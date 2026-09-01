/**
 * ci-status — lightweight CI status for pi.
 *
 * Keeps you and the model aware of CI state on the current branch WITHOUT
 * burning tokens on per-turn status text. Three layers:
 *
 *  1. Footer badge (zero LLM context) — `ctx.ui.setStatus("ci", ...)` shows a
 *     compact "CI: ✓ / ✗ / ⟳" indicator, refreshed on session start and after
 *     each agent run (throttled).
 *  2. Tool `ci_status` — the model pulls the detailed status on demand
 *     (latest run + which of the last 5 runs are failing). Guidelines tell it
 *     when to check: before claiming a fix works, after pushing, when CI is
 *     red.
 *  3. Edge-triggered delta — ONLY when the CI signature changes
 *     (green→red, red→green, none→red...) does the extension append ONE line
 *     to the next turn's system prompt AND show ONE notification. A persisted
 *     `lastInjectKey` per repo|branch prevents re-injection after /reload.
 *
 * Cost discipline: this extension makes ZERO LLM calls. It only spawns
 * throttled `gh`/`git` processes: at most once per TTL (default 90s,
 * CI_STATUS_TTL_MS) AND once per new HEAD. If `gh` is missing or
 * unauthenticated at load, the extension no-ops with one warning and re-probes
 * with capped backoff until gh is available again — failures are never latched.
 *
 * State: ~/.pi/agent/ci-status/state.json (override CI_STATUS_STATE for
 * tests). Test hooks: CI_STATUS_GH_BIN may point at a script (e.g. a .mjs
 * shim) which is then run via `node <bin> <args>`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTL_MS = (() => {
  const v = Number(process.env.CI_STATUS_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 90_000;
})();

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CiRun {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  createdAt: string;
  url: string;
}

export interface CiSnapshot {
  latest: CiRun | null;
  failing: CiRun[];
  /** Identity of the CI state — used for edge-triggered injection. */
  signature: string;
  badge: string;
}

export interface CiRecord {
  lastFetchAt: number;
  headSha: string;
  /** Signature the model was last told about — survives /reload. */
  lastInjectKey: string;
  snapshot: CiSnapshot | null;
}

export type CiState = Record<string, CiRecord>;

export interface RefreshResult {
  key: string;
  branch: string;
  snapshot: CiSnapshot | null;
  /** True when the CI signature changed since the last fetch. */
  transition: boolean;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export function stateFilePath(): string {
  return (
    process.env.CI_STATUS_STATE ??
    path.join(os.homedir(), ".pi", "agent", "ci-status", "state.json")
  );
}

let cachedState: CiState | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function loadState(): Promise<CiState> {
  if (cachedState) return cachedState;
  const file = stateFilePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CiState;
    cachedState = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cachedState = {};
  }
  return cachedState;
}

function persist(state: CiState): void {
  writeChain = writeChain.then(async () => {
    try {
      const file = stateFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.error("[ci-status] persist failed:", err);
    }
  });
}

/** Await pending writes (used by tests). */
export async function flushState(): Promise<void> {
  await writeChain;
}

// ---------------------------------------------------------------------------
// gh / git helpers
// ---------------------------------------------------------------------------

/**
 * Run gh. `CI_STATUS_GH_BIN` may point at a script (.js/.mjs/.cjs) which is
 * executed via `node <bin> <args>` — a test seam for shim-based tests.
 * Returns stdout, or null on any error (missing binary, non-zero exit).
 */
export async function runGh(args: string[], cwd: string): Promise<string | null> {
  const bin = process.env.CI_STATUS_GH_BIN ?? "gh";
  const isScript = /\.(mjs|cjs|js)$/i.test(bin);
  const opts = {
    cwd,
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  };
  try {
    const { stdout } = isScript
      ? await execFileAsync(process.execPath, [bin, ...args], opts)
      : await execFileAsync(bin, args, opts);
    return stdout;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// gh availability gate — no permanent failure latch
// ---------------------------------------------------------------------------

const GH_PROBE_TTL_MS = (() => {
  const v = Number(process.env.CI_STATUS_GH_PROBE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();

const GH_PROBE_STALE_MS = (() => {
  const v = Number(process.env.CI_STATUS_GH_PROBE_STALE_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
})();

const GH_RETRY_BASE_MS = (() => {
  const v = Number(process.env.CI_STATUS_GH_RETRY_BASE_MS);
  return Number.isFinite(v) && v > 0 ? v : 5_000;
})();

const GH_RETRY_MAX_MS = (() => {
  const v = Number(process.env.CI_STATUS_GH_RETRY_MAX_MS);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
})();

interface GhProbeState {
  /** Last verdict; null until the first probe completes. */
  ok: boolean | null;
  /** When the last probe completed (epoch ms). */
  probedAt: number;
  /** Consecutive failures since the last success. */
  retries: number;
  /** Pending backoff re-probe. */
  timer: ReturnType<typeof setTimeout> | null;
  /** In-flight probe, shared so callers never spawn gh concurrently. */
  inFlight: Promise<boolean> | null;
}

const ghProbe: GhProbeState = { ok: null, probedAt: 0, retries: 0, timer: null, inFlight: null };

/** One probe: gh present AND authenticated. */
export async function probeGh(): Promise<boolean> {
  try {
    const version = await runGh(["--version"], os.homedir());
    if (!version) return false;
    const auth = await runGh(["auth", "status"], os.homedir());
    return auth !== null;
  } catch {
    return false;
  }
}

/** Schedule a backoff re-probe; keeps going (capped) until gh works again. */
function scheduleGhRetry(): void {
  if (ghProbe.timer) return;
  const delay = Math.min(GH_RETRY_BASE_MS * 2 ** Math.min(ghProbe.retries, 6), GH_RETRY_MAX_MS);
  ghProbe.timer = setTimeout(() => {
    ghProbe.timer = null;
    void ensureGh(true);
  }, delay);
  // Never hold the process open (also keeps the ghfail tests from hanging).
  ghProbe.timer.unref?.();
}

/**
 * Current gh availability, cached within a freshness window.
 *
 * Unlike the old one-shot latch, a failure here is never final: a failed
 * probe schedules a capped backoff re-probe, and any caller can force a
 * fresh probe with `ensureGh(true)`. `refreshStatus` keeps the cheap cached
 * path; the `ci_status` tool and `/ci` re-probe on demand when failing.
 */
export function ensureGh(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && ghProbe.ok !== null) {
    const fresh = now - ghProbe.probedAt < (ghProbe.ok ? GH_PROBE_TTL_MS : GH_PROBE_STALE_MS);
    if (fresh) return Promise.resolve(ghProbe.ok);
  }
  if (ghProbe.inFlight) return ghProbe.inFlight;
  ghProbe.inFlight = probeGh()
    .then((ok) => {
      ghProbe.ok = ok;
      ghProbe.probedAt = Date.now();
      if (ok) {
        ghProbe.retries = 0;
        if (ghProbe.timer) {
          clearTimeout(ghProbe.timer);
          ghProbe.timer = null;
        }
      } else {
        ghProbe.retries += 1;
        scheduleGhRetry();
      }
      return ok;
    })
    .finally(() => {
      ghProbe.inFlight = null;
    });
  return ghProbe.inFlight;
}

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

async function gitOut(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      windowsHide: true,
      timeout: 10_000,
    });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function currentBranch(root: string): Promise<string | null> {
  return gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function gitHead(root: string): Promise<string | null> {
  return gitOut(root, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

function shortName(name: string): string {
  return name.length > 18 ? name.slice(0, 15) + "…" : name;
}

export function badgeText(latest: CiRun | null, failing: CiRun[]): string {
  if (!latest) return "CI: –";
  if (ACTIVE_STATUSES.has(latest.status)) return `CI: ⟳ ${shortName(latest.workflowName)}`;
  if (latest.conclusion === "success") {
    return failing.length > 0 ? `CI: ✓ +${failing.length} fail` : "CI: ✓";
  }
  return `CI: ✗ ${shortName(latest.workflowName)}`;
}

export function deriveSnapshot(runs: CiRun[], _prev?: CiSnapshot | null): CiSnapshot {
  const sorted = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const latest = sorted[0] ?? null;
  const failing = sorted.filter((r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion));
  const sigLatest = latest ? `${latest.databaseId}:${latest.conclusion ?? latest.status}` : "none";
  const signature = `${sigLatest};f=${failing.length}`;
  return { latest, failing, signature, badge: badgeText(latest, failing) };
}

/** One-line status for system-prompt injection / notifications. */
export function statusLine(snapshot: CiSnapshot, branch: string): string {
  if (!snapshot.latest) return `CI on ${branch}: no runs found recently.`;
  const r = snapshot.latest;
  const state = r.conclusion ?? r.status;
  const base = `CI on ${branch}: ${state} (${r.workflowName})`;
  return snapshot.failing.length > 0 ? `${base} — ${snapshot.failing.length} recent run(s) failing` : base;
}

/** Full status text for the ci_status tool / /ci command. */
export function formatStatus(snapshot: CiSnapshot, branch: string): string {
  if (!snapshot.latest) return `CI status for branch ${branch}: no runs found in the last 5.`;
  const lines: string[] = [`CI status for branch ${branch}:`];
  const shown = new Set<number>();
  const runs = [snapshot.latest, ...snapshot.failing.filter((f) => f.databaseId !== snapshot.latest!.databaseId)];
  for (const r of runs) {
    if (shown.has(r.databaseId)) continue;
    shown.add(r.databaseId);
    const mark = r.conclusion === "success" ? "✓" : r.conclusion ? "✗" : "⟳";
    lines.push(`- ${mark} ${r.workflowName} — ${r.conclusion ?? r.status} (run #${r.databaseId}, ${new Date(r.createdAt).toLocaleString()})`);
    lines.push(`  ${r.url}`);
  }
  if (snapshot.failing.length === 0) lines.push("- no failing runs in the last 5");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Badge visibility modes
// ---------------------------------------------------------------------------

/**
 * Footer badge visibility, from `CI_STATUS_BADGE`:
 *  - "always"   (default) show whenever a snapshot exists (current behavior)
 *  - "activity" show only when the branch has CI activity (>= 1 run)
 *  - "off"      never show the footer badge (tool, /ci, injection still work)
 */
export type BadgeMode = "always" | "activity" | "off";

export function resolveBadgeMode(env: Record<string, string | undefined>): BadgeMode {
  const v = env.CI_STATUS_BADGE?.trim().toLowerCase();
  return v === "activity" || v === "off" || v === "always" ? v : "always";
}

/** Whether the footer badge should be shown for this mode/snapshot. */
export function shouldShowBadge(mode: BadgeMode, snapshot: CiSnapshot | null): boolean {
  if (mode === "off") return false;
  if (mode === "activity") return snapshot !== null && snapshot.latest !== null;
  return true;
}

/** Badge-mode override persisted via `/ci badge`; null = follow CI_STATUS_BADGE. */
export function loadBadgeOverride(file: string): BadgeMode | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown };
    return parsed.mode === "always" || parsed.mode === "activity" || parsed.mode === "off"
      ? parsed.mode
      : null;
  } catch {
    return null;
  }
}

/** Persist a badge-mode override; null clears it (back to the env var). */
export function saveBadgeOverride(file: string, mode: BadgeMode | null): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode }, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    console.error("[ci-status] badge-mode persist failed:", err);
  }
}

/** Effective mode: the `/ci badge` override wins over the env var. */
export function effectiveBadgeMode(
  env: Record<string, string | undefined>,
  override: BadgeMode | null,
): BadgeMode {
  return override ?? resolveBadgeMode(env);
}

// ---------------------------------------------------------------------------
// Refresh (throttled)
// ---------------------------------------------------------------------------

export async function fetchRuns(root: string, branch: string): Promise<CiRun[] | null> {
  const stdout = await runGh(
    [
      "run",
      "list",
      "--branch",
      branch,
      "--limit",
      "5",
      "--json",
      "databaseId,workflowName,status,conclusion,headSha,createdAt,url",
    ],
    root,
  );
  if (stdout === null) return null;
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? (parsed as CiRun[]) : null;
  } catch {
    return null;
  }
}

let fetchChain: Promise<void> = Promise.resolve();

/**
 * Fetch (or return cached) CI status for the repo at `cwd`.
 * Throttled: skips when within TTL or when HEAD is unchanged — unless
 * `force`. Returns the snapshot, the branch, and whether the CI signature
 * transitioned since the previous fetch.
 */
export async function refreshStatus(cwd: string, force = false): Promise<RefreshResult> {
  if (!(await ensureGh())) return { key: "", branch: "", snapshot: null, transition: false };
  const root = await repoRoot(cwd);
  if (!root) return { key: "", branch: "", snapshot: null, transition: false };
  const branch = await currentBranch(root);
  if (!branch || branch === "HEAD") return { key: "", branch: "", snapshot: null, transition: false };
  const key = `${root}|${branch}`;

  let result!: RefreshResult;
  await (fetchChain = fetchChain.then(async () => {
    const state = await loadState();
    const rec = state[key];
    const now = Date.now();
    if (!force && rec) {
      if (now - rec.lastFetchAt < TTL_MS) {
        result = { key, branch, snapshot: rec.snapshot ?? null, transition: false };
        return;
      }
      const head = await gitHead(root);
      if (head && rec.headSha && head === rec.headSha) {
        result = { key, branch, snapshot: rec.snapshot ?? null, transition: false };
        return;
      }
    }
    const runs = await fetchRuns(root, branch);
    if (!runs) {
      // Fetch failed — keep stale state, no transition.
      result = { key, branch, snapshot: rec?.snapshot ?? null, transition: false };
      return;
    }
    const snapshot = deriveSnapshot(runs, rec?.snapshot);
    const transition = rec ? rec.lastInjectKey !== snapshot.signature : false;
    state[key] = {
      lastFetchAt: now,
      headSha: (await gitHead(root)) ?? rec?.headSha ?? "",
      // Always advance to the fetched signature: transitions fire exactly once
      // per signature change, and after /reload the baseline equals the current
      // signature so nothing re-injects.
      lastInjectKey: snapshot.signature,
      snapshot,
    };
    persist(state);
    result = { key, branch, snapshot, transition };
  }));
  return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const BADGE_KEY = "ci";

export default function ciStatusExtension(pi: ExtensionAPI): void {
  let pendingInjectLine: string | null = null;
  let ghWarningShown = false;
  let ghRecoveredNotified = false;
  /** /ci badge override (null = follow CI_STATUS_BADGE), persisted on change. */
  const badgeFile = process.env.CI_STATUS_BADGE_FILE ?? path.join(os.homedir(), ".pi", "agent", "ci-status", "badge-mode.json");
  let badgeOverride = loadBadgeOverride(badgeFile);

  /** Set or clear the footer badge per the effective mode. */
  function syncBadge(
    ctx: { hasUI?: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } },
    snapshot: CiSnapshot | null,
  ): void {
    if (!ctx.hasUI) return;
    const mode = effectiveBadgeMode(process.env as Record<string, string | undefined>, badgeOverride);
    try {
      if (snapshot !== null && shouldShowBadge(mode, snapshot)) {
        ctx.ui.setStatus(BADGE_KEY, snapshot.badge);
      } else if (mode !== "always") {
        // activity/off: actively hide; always + no snapshot keeps any stale badge.
        ctx.ui.setStatus(BADGE_KEY, undefined);
      }
    } catch {
      /* ignore */
    }
  }

  const warnGhMissing = (ctx: { hasUI?: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }) => {
    if (ghWarningShown) return;
    ghWarningShown = true;
    if (ctx.hasUI) ctx.ui.notify("ci-status: gh CLI missing or not authenticated — CI badge disabled", "warning");
  };

  /**
   * Gate for the session handlers: warn once while gh is unavailable, then
   * notify once when it recovers (the badge comes back without a pi restart).
   */
  const ghAvailable = async (ctx: { hasUI?: boolean; ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }): Promise<boolean> => {
    if (!(await ensureGh())) {
      warnGhMissing(ctx);
      return false;
    }
    if (ghWarningShown && !ghRecoveredNotified && ctx.hasUI) {
      ghRecoveredNotified = true;
      ctx.ui.notify("ci-status: gh available again — CI badge enabled", "info");
    }
    return true;
  };

  // Probe gh once at load; remember the verdict for the session.
  void ensureGh();

  // Initial badge + baseline inject key (no notification on first sight).
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!(await ghAvailable(ctx))) return;
      const { snapshot } = await refreshStatus(ctx.cwd);
      syncBadge(ctx, snapshot);
    } catch {
      // never break the loop
    }
  });

  // After each run: refresh badge; on a CI signature transition, notify once
  // and queue the one-line delta for the next turn's system prompt.
  pi.on("agent_end", async (_event, ctx) => {
    try {
      if (!(await ghAvailable(ctx))) return;
      const { snapshot, branch, transition } = await refreshStatus(ctx.cwd);
      syncBadge(ctx, snapshot);
      if (!snapshot || !branch) return;
      if (transition) {
        const line = statusLine(snapshot, branch);
        pendingInjectLine = line;
        if (ctx.hasUI) {
          ctx.ui.notify(line, snapshot.failing.length > 0 ? "warning" : "info");
        }
      }
    } catch {
      // never break the loop
    }
  });

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
    name: "ci_status",
    label: "CI status",
    description:
      "Get the latest CI run status for the current git branch: latest run (workflow, " +
      "status/conclusion) and which of the last 5 runs are failing. Optionally force a " +
      "fresh check, bypassing the throttled cache.",
    promptGuidelines: [
      "Check ci_status before claiming a fix works, after pushing, and whenever CI is reported red.",
    ],
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({ description: "Force a fresh check, bypassing the throttle (default false)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // On-demand recovery: re-probe when the cached verdict is failing, so a
      // transient at load never leaves the tool dead for the whole session.
      const ok = (await ensureGh()) || (await ensureGh(true));
      if (!ok) {
        return {
          content: [
            { type: "text", text: "CI status unavailable: gh CLI is not installed or not authenticated." },
          ],
          details: {},
        };
      }
      const { snapshot, branch } = await refreshStatus(ctx.cwd, params.refresh === true);
      if (!snapshot || !branch) {
        return {
          content: [
            { type: "text", text: "CI status unavailable: not inside a git repository, or no runs found." },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: formatStatus(snapshot, branch) }],
        details: { badge: snapshot.badge, signature: snapshot.signature },
      };
    },
  });

  // --- command ---------------------------------------------------------------

  pi.registerCommand("ci", {
    description:
      "Show CI status for the current branch (/ci refresh for a forced fresh check; /ci badge on|off|activity|reset to set the footer badge mode)",
    getArgumentCompletions: async (prefix) => {
      const p = prefix.toLowerCase();
      if (p.startsWith("badge")) {
        const rest = p.slice(5).trim();
        const subs = ["on", "off", "activity", "reset"];
        const candidates = rest === "" ? subs : subs.filter((s) => s.startsWith(rest));
        const items = candidates.map((s) => ({ value: `badge ${s}`, label: `badge ${s}` }));
        return items.length > 0 ? items : null;
      }
      const opts = ["refresh", "status", "badge"];
      const out = opts.filter((o) => o.startsWith(p)).map((o) => ({ value: o, label: o }));
      return out.length > 0 ? out : null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim().toLowerCase();

      // /ci badge [on|off|activity|reset] — runtime badge-mode override.
      if (arg === "badge" || arg.startsWith("badge ")) {
        const sub = arg === "badge" ? "" : arg.slice("badge ".length).trim();
        const current = effectiveBadgeMode(process.env as Record<string, string | undefined>, badgeOverride);
        if (sub === "") {
          const origin = badgeOverride !== null ? "override" : "env default";
          ctx.ui.notify(`CI badge mode: ${current} (${origin})`, "info");
          return;
        }
        let next: BadgeMode | null;
        if (sub === "on") next = "always";
        else if (sub === "off") next = "off";
        else if (sub === "activity") next = "activity";
        else if (sub === "reset") next = null;
        else {
          ctx.ui.notify(`/ci badge: unknown value "${sub}" — use on, off, activity or reset`, "warning");
          return;
        }
        badgeOverride = next;
        saveBadgeOverride(badgeFile, next);
        // Fresh snapshot so the change is visible immediately (one gh spawn).
        const { snapshot } = await refreshStatus(ctx.cwd, true);
        syncBadge(ctx, snapshot);
        const label = next === null ? "env default" : next === "always" ? "on" : next;
        ctx.ui.notify(`CI badge mode: ${label} (persisted)`, "info");
        return;
      }

      const force = arg === "refresh" || arg === "-r";
      const ok = (await ensureGh()) || (await ensureGh(true));
      if (!ok) {
        ctx.ui.notify("ci-status: gh CLI missing or not authenticated", "error");
        return;
      }
      const { snapshot, branch } = await refreshStatus(ctx.cwd, force);
      if (!snapshot || !branch) {
        ctx.ui.notify("CI status unavailable (not a git repo?)", "info");
        return;
      }
      syncBadge(ctx, snapshot);
      ctx.ui.notify(
        snapshot.badge + " — " + (snapshot.latest ? snapshot.latest.workflowName : "no runs"),
        snapshot.failing.length > 0 ? "warning" : "info",
      );
    },
  });
}
