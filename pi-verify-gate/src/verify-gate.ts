/**
 * verify-gate — local verification status for pi.
 *
 * The local sibling of pi-ci-status. ci-status tells you what GitHub thinks
 * AFTER you push; verify-gate tells you whether the tree in front of you still
 * passes, BEFORE you claim a fix works. Same three layers, same cost shape:
 *
 *  1. Footer badge (zero LLM context) — `ctx.ui.setStatus("verify", ...)` shows
 *     a compact "Verify: ✓ / ✗ 2 / ⏱ / –" indicator.
 *  2. Tool `verify_status` — the model pulls the detail on demand: the resolved
 *     command, exit code, duration, failure hints, and the output tail.
 *  3. Edge-triggered delta — ONLY when the verify signature changes
 *     (pass→fail, fail→pass, unavailable→pass...) does the extension append ONE
 *     line to the next turn's system prompt AND show ONE notification. A
 *     persisted `lastInjectKey` per repo prevents re-injection after /reload.
 *
 * Cost discipline: this extension makes ZERO LLM calls. The expensive thing
 * here is the check itself, so it is gated three times:
 *
 *  - **Tree gate** — the working tree must have actually changed. The key is
 *    sha256 over HEAD + `git status --porcelain -uall` + `git diff HEAD`, plus
 *    size+mtime for untracked files (whose contents git does not diff).
 *  - **TTL gate** — at most one check per VERIFY_GATE_TTL_MS (default 30s).
 *  - **Single-flight** — a module-level promise chain, so two settles can never
 *    run two test suites at once.
 *
 * The tree key is recorded AFTER the check finishes, never before: the check
 * itself may rewrite files (formatters, snapshot tests, codegen), and recording
 * the pre-run key would make the next settle see a "changed" tree and re-run
 * forever.
 *
 * Signature is `commandId|status` and deliberately excludes the output tail —
 * otherwise every differently-worded failure of the same broken test would
 * re-inject a line into the system prompt.
 *
 * `unavailable` (missing toolchain) is NOT `fail`: it gets its own badge, one
 * warning, and never injects a scary "verify failed" line.
 *
 * State:  ~/.pi/agent/verify-gate/state.json  (VERIFY_GATE_STATE)
 * Config: ~/.pi/agent/verify-gate/config.json (VERIFY_GATE_CONFIG)
 * Test seams: VERIFY_GATE_CMD overrides detection; VERIFY_GATE_TTL_MS and
 * VERIFY_GATE_TIMEOUT_MS make the timing gates testable.
 */

import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTL_MS = (() => {
  const v = Number(process.env.VERIFY_GATE_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
})();

const TIMEOUT_MS = (() => {
  const v = Number(process.env.VERIFY_GATE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
})();

const MAX_TAIL_LINES = (() => {
  const v = Number(process.env.VERIFY_GATE_MAX_LINES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 40;
})();

const MAX_TAIL_CHARS = 4_000;
const MAX_BUFFER = 2 * 1024 * 1024;
/** Cap on untracked files stat'd for the tree key (bounded work). */
const MAX_UNTRACKED = 200;

/** package.json script priority — first match wins. */
const SCRIPT_PRIORITY = ["check", "verify", "test", "typecheck", "lint"];

/**
 * `npm init -y` writes `"test": "echo \"Error: no test specified\" && exit 1"`.
 * Treating that as a check would report a permanent failure in every new repo,
 * so a placeholder means "no check here" (one warning, no badge, no injection).
 */
const PLACEHOLDER_SCRIPT_RE = /no test specified|^\s*exit\s+1\s*$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyStatus = "pass" | "fail" | "timeout" | "unavailable";

export interface CheckSpec {
  /** The shell command that is actually run. */
  command: string;
  /** Human label, e.g. "package.json:check (pnpm)". */
  label: string;
  /** Where it came from: env | project | config | package | cargo | go | python | make. */
  source: string;
  /** Stable identity of the command — part of the injection signature. */
  commandId: string;
}

export interface VerifyResult {
  status: VerifyStatus;
  commandId: string;
  label: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** Bounded tail of combined stdout+stderr. */
  tail: string;
  /** Heuristic failure highlights (empty unless status === "fail"). */
  failures: string[];
  finishedAt: number;
}

export interface VerifyRecord {
  lastRunAt: number;
  /** Tree key recorded AFTER the run finished. */
  lastKey: string;
  headSha: string;
  /** Signature last surfaced to the model — survives /reload. */
  lastInjectKey: string;
  spec: Omit<CheckSpec, never> | null;
  result: VerifyResult | null;
}

export type VerifyState = Record<string, VerifyRecord>;

export interface ResolveInput {
  env: Record<string, string | undefined>;
  /** Persisted `/verify cmd` overrides, keyed by git root (never global: a
   *  command for a Python repo must not run in a Rust repo). */
  commands: Record<string, string>;
  /** Whether project-local config may be read (ctx.isProjectTrusted()). */
  projectTrusted: boolean;
}

export type RefreshReason = "ok" | "no-repo" | "no-check" | "throttled";

export interface RefreshResult {
  key: string;
  root: string;
  branch: string;
  spec: CheckSpec | null;
  result: VerifyResult | null;
  /** True when the verify signature changed since the last run. */
  transition: boolean;
  reason: RefreshReason;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export function stateFilePath(): string {
  return (
    process.env.VERIFY_GATE_STATE ??
    path.join(os.homedir(), ".pi", "agent", "verify-gate", "state.json")
  );
}

export function configFilePath(): string {
  return (
    process.env.VERIFY_GATE_CONFIG ??
    path.join(os.homedir(), ".pi", "agent", "verify-gate", "config.json")
  );
}

let cachedState: VerifyState | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function loadState(): Promise<VerifyState> {
  if (cachedState) return cachedState;
  try {
    const raw = await fs.readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as VerifyState;
    cachedState = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cachedState = {};
  }
  return cachedState;
}

function persist(state: VerifyState): void {
  writeChain = writeChain.then(async () => {
    try {
      const file = stateFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.error("[verify-gate] persist failed:", err);
    }
  });
}

/** Await pending writes (used by tests). */
export async function flushState(): Promise<void> {
  await writeChain;
}

// ---------------------------------------------------------------------------
// Config (badge mode / run mode / command override)
// ---------------------------------------------------------------------------

export type BadgeMode = "always" | "activity" | "off";
export type RunMode = "auto" | "off";

export interface VerifyConfig {
  badge?: BadgeMode;
  /** Per-repo command overrides, keyed by git root. */
  commands?: Record<string, string>;
}

export function loadConfig(file: string): VerifyConfig {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: VerifyConfig = {};
    if (parsed.badge === "always" || parsed.badge === "activity" || parsed.badge === "off") {
      out.badge = parsed.badge;
    }
    const raw = parsed.commands;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim().length > 0) map[key] = value.trim();
      }
      if (Object.keys(map).length > 0) out.commands = map;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge a patch into the config file. `commands` replaces the whole map. */
export function saveConfig(file: string, patch: VerifyConfig): void {
  try {
    const merged: VerifyConfig = { ...loadConfig(file) };
    if ("badge" in patch) {
      if (patch.badge) merged.badge = patch.badge;
      else delete merged.badge;
    }
    if ("commands" in patch) {
      const commands = patch.commands;
      if (commands && Object.keys(commands).length > 0) merged.commands = commands;
      else delete merged.commands;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    console.error("[verify-gate] config persist failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Badge / run modes
// ---------------------------------------------------------------------------

export function resolveBadgeMode(env: Record<string, string | undefined>): BadgeMode {
  const v = env.VERIFY_GATE_BADGE?.trim().toLowerCase();
  return v === "always" || v === "activity" || v === "off" ? v : "activity";
}

/**
 * Whether the footer badge should be shown.
 * Default is "activity" (unlike ci-status's "always"): a repo with no detected
 * check would otherwise permanently show a meaningless "Verify: –".
 */
export function shouldShowBadge(mode: BadgeMode, result: VerifyResult | null): boolean {
  if (mode === "off") return false;
  if (mode === "activity") return result !== null;
  return true;
}

export function effectiveBadgeMode(
  env: Record<string, string | undefined>,
  override: BadgeMode | null,
): BadgeMode {
  return override ?? resolveBadgeMode(env);
}

export function resolveRunMode(env: Record<string, string | undefined>): RunMode {
  const v = env.VERIFY_GATE_MODE?.trim().toLowerCase();
  return v === "off" ? "off" : "auto";
}

// ---------------------------------------------------------------------------
// git helpers (self-contained — no cross-package imports)
// ---------------------------------------------------------------------------

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
    });
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** git output as a string ("" on error or empty) — unlike gitOut, never null. */
async function gitRaw(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function gitOut(root: string, args: string[]): Promise<string | null> {
  const out = (await gitRaw(root, args)).trim();
  return out.length > 0 ? out : null;
}

export function currentBranch(root: string): Promise<string | null> {
  return gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function gitHead(root: string): Promise<string | null> {
  return gitOut(root, ["rev-parse", "HEAD"]);
}

/**
 * Content identity of the working tree. Unlike ci-status (which only cares
 * about pushed commits), this MUST include uncommitted work — that is the whole
 * point of a local verify gate.
 *
 * Tracked files are hashed exactly via `git diff HEAD` (staged + unstaged).
 * Untracked files are not in that diff, so their size+mtime is hashed instead —
 * cheap (stat only) and enough to notice an agent rewriting a new file.
 */
export async function treeKey(root: string): Promise<string> {
  const [head, status, diff] = await Promise.all([
    gitRaw(root, ["rev-parse", "HEAD"]),
    gitRaw(root, ["status", "--porcelain", "-uall"]),
    gitRaw(root, ["diff", "HEAD"]),
  ]);
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter((p) => p.length > 0)
    .slice(0, MAX_UNTRACKED);
  const stats: string[] = [];
  for (const rel of untracked) {
    try {
      const st = await fs.stat(path.join(root, rel));
      stats.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      stats.push(`${rel}:?`);
    }
  }
  const h = createHash("sha256");
  h.update(head);
  h.update("\0");
  h.update(status);
  h.update("\0");
  h.update(diff);
  h.update("\0");
  h.update(stats.join("\n"));
  return h.digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Check detection
// ---------------------------------------------------------------------------

function makeSpec(command: string, label: string, source: string): CheckSpec {
  return {
    command,
    label,
    source,
    commandId: `${source}:${createHash("sha1").update(command).digest("hex").slice(0, 8)}`,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function readJsonSync(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function packageManager(root: string): Promise<string> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if ((await exists(path.join(root, "bun.lockb"))) || (await exists(path.join(root, "bun.lock")))) {
    return "bun";
  }
  return "npm";
}

async function detectPackageScript(root: string): Promise<CheckSpec | null> {
  const pkg = readJsonSync(path.join(root, "package.json"));
  if (!pkg) return null;
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const table = scripts as Record<string, unknown>;
  const name = SCRIPT_PRIORITY.find((s) => {
    const value = table[s];
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      !PLACEHOLDER_SCRIPT_RE.test(value.trim())
    );
  });
  if (!name) return null;
  const pm = await packageManager(root);
  return makeSpec(`${pm} run ${name}`, `package.json:${name} (${pm})`, "package");
}

/** `make check` only when the Makefile actually declares a check target. */
async function detectMake(root: string): Promise<CheckSpec | null> {
  const file = path.join(root, "Makefile");
  if (!(await exists(file))) return null;
  try {
    const text = await fs.readFile(file, "utf8");
    if (!/^check\s*:/m.test(text)) return null;
    return makeSpec("make check", "Makefile:check", "make");
  } catch {
    return null;
  }
}

/**
 * Detection order (first match wins):
 *   VERIFY_GATE_CMD > project-local command (trusted only) > per-repo
 *   `/verify cmd` override > package.json scripts > Cargo.toml > go.mod >
 *   pyproject.toml > Makefile
 *
 * `root` is always the git root, so every override is looked up consistently.
 */
export async function resolveCheck(root: string, input: ResolveInput): Promise<CheckSpec | null> {
  const envCommand = input.env.VERIFY_GATE_CMD?.trim();
  if (envCommand) return makeSpec(envCommand, "VERIFY_GATE_CMD", "env");

  if (input.projectTrusted) {
    const projectCommand = readProjectCommand(root);
    if (projectCommand) return makeSpec(projectCommand, "project verify-gate.json", "project");
  }
  const persistedCommand = input.commands[root];
  if (persistedCommand) return makeSpec(persistedCommand, "/verify cmd override", "config");

  const fromPackage = await detectPackageScript(root);
  if (fromPackage) return fromPackage;

  if (await exists(path.join(root, "Cargo.toml"))) {
    return makeSpec("cargo test --quiet", "Cargo.toml:cargo test", "cargo");
  }
  if (await exists(path.join(root, "go.mod"))) {
    return makeSpec("go test ./...", "go.mod:go test", "go");
  }
  if (await exists(path.join(root, "pyproject.toml"))) {
    return makeSpec("python -m pytest -q", "pyproject.toml:pytest", "python");
  }

  return detectMake(root);
}

// ---------------------------------------------------------------------------
// Running the check
// ---------------------------------------------------------------------------

export interface CheckOutcome {
  status: VerifyStatus;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/** Codes a shell reports when the command it was asked to run is missing. */
const MISSING_CODES = new Set([126, 127, 9009]);

/**
 * cmd.exe reports a missing command as exit code 1 — the same code as a failing
 * test — so on Windows the message is the only reliable signal. Scoped tightly
 * to the cmd.exe wording so real test output can never be misread as
 * `unavailable` (which would suppress a genuine failure).
 */
const MISSING_OUTPUT_RE = /is not recognized as an internal or external command/i;

/**
 * Run the check with a hard timeout and a bounded buffer.
 * Never throws: spawn failures become `unavailable`, timeouts become `timeout`.
 *
 * `exec` (not `execFile`) is required, not cosmetic: it runs the command through
 * the platform shell, which on Windows is what can spawn the npm/pnpm/yarn/bun
 * `.cmd` shims (plain execFile cannot, and fails with ENOENT).
 */
export function runCheck(root: string, command: string, timeoutMs = TIMEOUT_MS): Promise<CheckOutcome> {
  const started = Date.now();
  return new Promise<CheckOutcome>((resolve) => {
    const done = (outcome: CheckOutcome) => resolve(outcome);
    try {
      exec(
        command,
        {
          cwd: root,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          env: process.env,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const output = `${stdout ?? ""}${stderr ?? ""}`;
          if (!err) {
            done({ status: "pass", exitCode: 0, output, durationMs });
            return;
          }
          const rawCode = (err as { code?: unknown }).code;
          const code = typeof rawCode === "number" ? rawCode : null;
          const killed = (err as { killed?: unknown }).killed === true;
          if (rawCode === "ENOENT" || (code !== null && MISSING_CODES.has(code))) {
            done({ status: "unavailable", exitCode: code, output, durationMs });
            return;
          }
          if (MISSING_OUTPUT_RE.test(output)) {
            done({ status: "unavailable", exitCode: code, output, durationMs });
            return;
          }
          if (killed) {
            done({ status: "timeout", exitCode: code, output, durationMs });
            return;
          }
          done({ status: "fail", exitCode: code, output, durationMs });
        },
      );
    } catch {
      done({ status: "unavailable", exitCode: null, output: "", durationMs: Date.now() - started });
    }
  });
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

/** Last N lines, capped to the tail of MAX_TAIL_CHARS. */
export function tailOf(output: string, maxLines = MAX_TAIL_LINES, maxChars = MAX_TAIL_CHARS): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

/**
 * Bounded, regex-only failure highlights. Deliberately unanchored on the left:
 * an earlier version required whitespace before `Error:`, which silently missed
 * `SyntaxError:` and `TypeError:`. A hint is only a hint — the status always
 * comes from the exit code, never from this regex.
 */
const FAILURE_HINT_RE =
  /\bFAIL\b|\bFAILED\b|✗|✖|\w*Error:|\bpanic:|\bTraceback\b|error TS\d+|error\[E\d+\]|\bexpected .+? to \b|\bnot ok\b/;

/** Bounded, regex-only failure highlights — a hint for the model, not a parser. */
export function extractFailureHints(output: string, limit = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 200) continue;
    if (!FAILURE_HINT_RE.test(trimmed)) continue;
    const hint = trimmed.slice(0, 120);
    if (seen.has(hint)) continue;
    seen.add(hint);
    out.push(hint);
    if (out.length >= limit) break;
  }
  return out;
}

export function resultSignature(commandId: string, status: VerifyStatus): string {
  return `${commandId}|${status}`;
}

export function badgeText(result: VerifyResult | null): string {
  if (!result) return "Verify: –";
  switch (result.status) {
    case "pass":
      return "Verify: ✓";
    case "fail":
      return result.failures.length > 0 ? `Verify: ✗ ${result.failures.length}` : "Verify: ✗";
    case "timeout":
      return "Verify: ⏱";
    case "unavailable":
      return "Verify: –";
  }
}

/** One-line status for system-prompt injection / notifications. */
export function statusLine(result: VerifyResult, branch: string): string {
  const where = branch ? `on ${branch}` : "in this repo";
  switch (result.status) {
    case "pass":
      return `Local verify ${where}: passing (${result.label})`;
    case "fail": {
      const head = result.failures[0] ? `: ${result.failures[0]}` : "";
      return `Local verify ${where}: FAILING (${result.label}, exit ${result.exitCode ?? "?"})${head}`;
    }
    case "timeout":
      return `Local verify ${where}: timed out after ${Math.round(result.durationMs / 1000)}s (${result.label})`;
    case "unavailable":
      return `Local verify ${where}: not runnable (${result.label}) — toolchain or command unavailable`;
  }
}

/** Full detail for the verify_status tool / /verify command. */
export function formatResult(result: VerifyResult, branch: string, root: string): string {
  const lines = [
    `Local verify for ${root}${branch ? ` (${branch})` : ""}:`,
    `- status: ${result.status}`,
    `- command: ${result.command}  [${result.label}]`,
    `- exit code: ${result.exitCode ?? "n/a"} · duration: ${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  if (result.failures.length > 0) {
    lines.push("- failure hints:");
    for (const f of result.failures) lines.push(`  · ${f}`);
  }
  if (result.tail) {
    lines.push("- output tail:");
    for (const l of result.tail.split("\n")) lines.push(`  | ${l}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Refresh (tree-gated + throttled + single-flight)
// ---------------------------------------------------------------------------

let runChain: Promise<void> = Promise.resolve();

/**
 * In-flight automatic run started by `agent_settled`. The handler does NOT
 * await it: a real suite can take minutes, and blocking Pi's idle processing on
 * it would stall the next prompt. `flushRuns()` is the test seam that waits for
 * the background run to finish.
 */
let backgroundRuns: Promise<void> = Promise.resolve();

/** Await the current background auto-run (used by tests). */
export async function flushRuns(): Promise<void> {
  await backgroundRuns;
  await runChain;
}

/**
 * Resolve the check, apply the tree/TTL gates, and run it if needed.
 * Returns the cached record when throttled. Never throws.
 */
export async function refreshVerify(
  cwd: string,
  force: boolean,
  input: ResolveInput,
): Promise<RefreshResult> {
  const empty = (root: string, branch: string, reason: RefreshReason): RefreshResult => ({
    key: "",
    root,
    branch,
    spec: null,
    result: null,
    transition: false,
    reason,
  });

  let root: string | null = null;
  let branch = "";
  let spec: CheckSpec | null = null;
  let key = "";
  try {
    root = await repoRoot(cwd);
    if (!root) return empty("", "", "no-repo");
    branch = (await currentBranch(root)) ?? "";
    spec = await resolveCheck(root, input);
    if (!spec) return empty(root, branch, "no-check");
    key = await treeKey(root);

    const state = await loadState();
    const rec = state[root];
    if (!force && rec && rec.spec?.commandId === spec.commandId) {
      const withinTtl = Date.now() - rec.lastRunAt < TTL_MS;
      if (withinTtl || rec.lastKey === key) {
        return { key, root, branch, spec, result: rec.result ?? null, transition: false, reason: "throttled" };
      }
    }
  } catch {
    return empty(root ?? "", "", "no-repo");
  }

  const repoRootPath = root;
  const resolved = spec;
  const resolvedKey = key;
  const resolvedBranch = branch;
  let out: RefreshResult = {
    key: resolvedKey,
    root: repoRootPath,
    branch: resolvedBranch,
    spec: resolved,
    result: null,
    transition: false,
    reason: "throttled",
  };

  runChain = runChain
    .then(async () => {
      try {
        const outcome = await runCheck(repoRootPath, resolved.command);
        // Recorded AFTER the run: the check may have rewritten files.
        const postKey = await treeKey(repoRootPath);
        const result: VerifyResult = {
          status: outcome.status,
          commandId: resolved.commandId,
          label: resolved.label,
          command: resolved.command,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          tail: tailOf(outcome.output),
          failures: outcome.status === "fail" ? extractFailureHints(outcome.output) : [],
          finishedAt: Date.now(),
        };
        const state = await loadState();
        const prev = state[repoRootPath];
        const signature = resultSignature(result.commandId, result.status);
        const transition = prev ? prev.lastInjectKey !== signature : false;
        state[repoRootPath] = {
          lastRunAt: Date.now(),
          lastKey: postKey,
          headSha: (await gitHead(repoRootPath)) ?? prev?.headSha ?? "",
          lastInjectKey: signature,
          spec: resolved,
          result,
        };
        persist(state);
        out = {
          key: postKey,
          root: repoRootPath,
          branch: resolvedBranch,
          spec: resolved,
          result,
          transition,
          reason: "ok",
        };
      } catch (err) {
        console.error("[verify-gate] run failed:", err);
      }
    })
    .catch(() => {
      // Never let the chain reject — a rejected chain would disable the extension.
    });

  await runChain;
  return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const BADGE_KEY = "verify";

/**
 * Read the project-local command override. The CALLER decides whether the
 * project is trusted; `root` is the git root (not ctx.cwd), so starting Pi in a
 * subdirectory still finds the config and agrees with how state is keyed.
 */
export function readProjectCommand(root: string): string | null {
  try {
    const file = path.join(root, CONFIG_DIR_NAME, "verify-gate.json");
    const parsed = readJsonSync(file) as { command?: unknown } | null;
    return typeof parsed?.command === "string" && parsed.command.trim().length > 0
      ? parsed.command.trim()
      : null;
  } catch {
    return null;
  }
}

export default function verifyGateExtension(pi: ExtensionAPI): void {
  let pendingInjectLine: string | null = null;
  let unavailableWarned = false;
  const configFile = configFilePath();
  let config = loadConfig(configFile);

  /** Set or clear the footer badge per the effective mode. */
  function syncBadge(
    ctx: { hasUI?: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } },
    result: VerifyResult | null,
  ): void {
    if (!ctx.hasUI) return;
    const mode = effectiveBadgeMode(process.env as Record<string, string | undefined>, config.badge ?? null);
    try {
      if (result !== null && shouldShowBadge(mode, result)) {
        ctx.ui.setStatus(BADGE_KEY, badgeText(result));
      } else if (mode !== "always") {
        ctx.ui.setStatus(BADGE_KEY, undefined);
      }
    } catch {
      /* ignore */
    }
  }

  const input = (ctx: ExtensionContext): ResolveInput => ({
    env: process.env as Record<string, string | undefined>,
    commands: config.commands ?? {},
    projectTrusted: (() => {
      try {
        return ctx.isProjectTrusted() === true;
      } catch {
        return false;
      }
    })(),
  });

  const warnUnavailable = (ctx: {
    hasUI?: boolean;
    ui: { notify: (m: string, t?: "info" | "warning" | "error") => void };
  }): void => {
    if (unavailableWarned) return;
    unavailableWarned = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        "verify-gate: no check command detected (looked for package.json scripts, Cargo.toml, go.mod, pyproject.toml, Makefile:check) — set VERIFY_GATE_CMD or /verify cmd <command>",
        "warning",
      );
    }
  };

  // Re-read config on load so /verify settings survive a /reload.
  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig(configFile);
      // Cached render only — never spawn a check on session start.
      const state = await loadState();
      const root = await repoRoot(ctx.cwd);
      syncBadge(ctx, root ? state[root]?.result ?? null : null);
    } catch {
      // never break the loop
    }
  });

  // After the agent settles (no retry/compaction/follow-up left): gate, run,
  // refresh the badge, and on a signature transition queue ONE injected line.
  //
  // Deliberately NOT awaited: the check can take minutes, and event handlers are
  // awaited, so awaiting here would stall Pi's idle processing (and the next
  // prompt) for the whole suite. The badge shows progress immediately; the
  // result, notification and injected line are applied when the run resolves.
  pi.on("agent_settled", (_event, ctx) => {
    try {
      const runMode = resolveRunMode(process.env as Record<string, string | undefined>);
      if (runMode === "off") return;
      backgroundRuns = runDetached(ctx).catch(() => {
        // never break the loop
      });
    } catch {
      // never break the loop
    }
  });

  async function runDetached(ctx: ExtensionContext): Promise<void> {
    try {
      if (ctx.hasUI) ctx.ui.setStatus(BADGE_KEY, "Verify: …");
      const res = await refreshVerify(ctx.cwd, false, input(ctx));
      if (res.reason === "no-check") {
        syncBadge(ctx, null);
        warnUnavailable(ctx);
        return;
      }
      syncBadge(ctx, res.result);
      if (!res.result || !res.transition) return;
      const line = statusLine(res.result, res.branch);
      pendingInjectLine = line;
      if (ctx.hasUI) {
        ctx.ui.notify(line, res.result.status === "fail" ? "warning" : "info");
      }
    } catch {
      // never break the loop
    }
  }

  // Edge-triggered model surfacing: exactly one injected line per transition.
  pi.on("before_agent_start", async (event) => {
    if (!pendingInjectLine) return undefined;
    const line = pendingInjectLine;
    pendingInjectLine = null;
    return { systemPrompt: `${event.systemPrompt}\n\n${line}` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      ctx.ui.setStatus(BADGE_KEY, undefined);
    } catch {
      // ignore
    }
  });

  // --- tool ----------------------------------------------------------------

  pi.registerTool({
    name: "verify_status",
    label: "Local verify status",
    description:
      "Run or read the project's local check (package.json check/verify/test/typecheck/lint via " +
      "npm/pnpm/yarn/bun, cargo test, go test, pytest, make check) and report pass/fail, exit code, " +
      "duration, failure hints and the output tail. Optionally force a fresh run, bypassing the throttle.",
    promptGuidelines: [
      "Check verify_status before claiming a fix works, and after edits that could break the build.",
      "If local verify is failing, do not report the task complete.",
      "verify_status runs local commands only; it never touches CI. Use ci_status for GitHub Actions.",
    ],
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Force a fresh run, bypassing the throttle (default false)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await refreshVerify(ctx.cwd, params.refresh === true, input(ctx));
      if (!res.result) {
        const why =
          res.reason === "no-repo"
            ? "not inside a git repository"
            : res.reason === "no-check"
              ? "no check command detected (set VERIFY_GATE_CMD or /verify cmd <command>)"
              : "no result available";
        return {
          content: [{ type: "text", text: `Local verify unavailable: ${why}.` }],
          details: { reason: res.reason },
        };
      }
      syncBadge(ctx, res.result);
      return {
        content: [{ type: "text", text: formatResult(res.result, res.branch, res.root) }],
        details: {
          status: res.result.status,
          badge: badgeText(res.result),
          transition: res.transition,
          reason: res.reason,
        },
      };
    },
  });

  // --- command -------------------------------------------------------------

  pi.registerCommand("verify", {
    description:
      "Show local verify status (/verify run to force a check; /verify badge on|off|activity|reset; /verify cmd <command>|reset)",
    getArgumentCompletions: async (prefix) => {
      const p = prefix.toLowerCase();
      const sub = (name: string, values: string[]) => {
        const rest = p.slice(name.length).trim();
        const candidates = rest === "" ? values : values.filter((v) => v.startsWith(rest));
        const items = candidates.map((v) => ({ value: `${name} ${v}`, label: `${name} ${v}` }));
        return items.length > 0 ? items : null;
      };
      if (p.startsWith("badge")) return sub("badge", ["on", "off", "activity", "reset"]);
      if (p.startsWith("cmd")) return null;
      const opts = ["run", "status", "badge", "cmd"];
      const out = opts.filter((o) => o.startsWith(p)).map((o) => ({ value: o, label: o }));
      return out.length > 0 ? out : null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim().toLowerCase();

      // /verify badge [on|off|activity|reset]
      if (arg === "badge" || arg.startsWith("badge ")) {
        const raw = (args ?? "").trim();
        const sub = raw === "badge" ? "" : raw.slice("badge".length).trim().toLowerCase();
        const current = effectiveBadgeMode(
          process.env as Record<string, string | undefined>,
          config.badge ?? null,
        );
        if (sub === "") {
          const origin = config.badge ? "override" : "env default";
          ctx.ui.notify(`verify-gate badge mode: ${current} (${origin})`, "info");
          return;
        }
        if (sub === "reset") {
          saveConfig(configFile, { badge: undefined });
          config = loadConfig(configFile);
          ctx.ui.notify("verify-gate badge mode: env default", "info");
          return;
        }
        const next: BadgeMode | null =
          sub === "on" ? "always" : sub === "off" ? "off" : sub === "activity" ? "activity" : null;
        if (next === null) {
          ctx.ui.notify(`/verify badge: unknown value "${sub}" — use on, off, activity or reset`, "warning");
          return;
        }
        saveConfig(configFile, { badge: next });
        config = loadConfig(configFile);
        const state = await loadState();
        const root = await repoRoot(ctx.cwd);
        syncBadge(ctx, root ? state[root]?.result ?? null : null);
        ctx.ui.notify(`verify-gate badge mode: ${next === "always" ? "on" : next} (persisted)`, "info");
        return;
      }

      // /verify cmd [<command>|reset] — scoped to THIS repo's git root, so an
      // override for one project can never run in another.
      if (arg === "cmd" || arg.startsWith("cmd ")) {
        const root = (await repoRoot(ctx.cwd)) ?? ctx.cwd;
        const commands = { ...(config.commands ?? {}) };
        const raw = (args ?? "").trim();
        const value = raw === "cmd" ? "" : raw.slice("cmd".length).trim();
        if (value === "") {
          ctx.ui.notify(
            commands[root]
              ? `verify-gate command override (this repo): ${commands[root]}`
              : "verify-gate command override: none for this repo (auto-detected)",
            "info",
          );
          return;
        }
        if (value.toLowerCase() === "reset") {
          delete commands[root];
          saveConfig(configFile, { commands });
          config = loadConfig(configFile);
          ctx.ui.notify("verify-gate command override cleared for this repo", "info");
          return;
        }
        commands[root] = value;
        saveConfig(configFile, { commands });
        config = loadConfig(configFile);
        ctx.ui.notify(`verify-gate command override for this repo: ${value} (persisted)`, "info");
        return;
      }

      const force = arg === "run" || arg === "refresh" || arg === "-r";
      if (force && ctx.hasUI) ctx.ui.setStatus(BADGE_KEY, "Verify: …");
      const res = await refreshVerify(ctx.cwd, force, input(ctx));
      if (res.reason === "no-repo") {
        ctx.ui.notify("verify-gate: not inside a git repository", "info");
        return;
      }
      if (res.reason === "no-check") {
        warnUnavailable(ctx);
        return;
      }
      if (!res.result) {
        ctx.ui.notify("verify-gate: no result available", "info");
        return;
      }
      syncBadge(ctx, res.result);
      const verb = res.reason === "throttled" ? "cached" : "ran";
      ctx.ui.notify(
        `${badgeText(res.result)} — ${verb} ${res.result.label}`,
        res.result.status === "fail" ? "warning" : "info",
      );
    },
  });
}
