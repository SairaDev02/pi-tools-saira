/**
 * Functional test for pi-verify-gate.
 *
 * Run (TTL 0 so the tree-key gate — not the TTL — is what's under test):
 *   VERIFY_GATE_TTL_MS=0 node --experimental-strip-types tests/verify-gate.test.ts
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  badgeText,
  configFilePath,
  effectiveBadgeMode,
  extractFailureHints,
  flushRuns,
  flushState,
  formatResult,
  loadConfig,
  loadState,
  readProjectCommand,
  refreshVerify,
  repoRoot,
  resolveBadgeMode,
  resolveCheck,
  resolveRunMode,
  resultSignature,
  runCheck,
  saveConfig,
  shouldShowBadge,
  stateFilePath,
  statusLine,
  tailOf,
  treeKey,
  type VerifyResult,
} from "../src/verify-gate.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import verifyGateExtension from "../src/verify-gate.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(here, "check-shim.mjs");

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "verify-gate-"));
const spawnLog = path.join(tmpRoot, "spawns.log");
process.env.CHECK_SHIM_LOG = spawnLog;
process.env.VERIFY_GATE_STATE = path.join(tmpRoot, "state.json");
process.env.VERIFY_GATE_CONFIG = path.join(tmpRoot, "config.json");
process.env.VERIFY_GATE_CMD = `"${process.execPath}" "${shim}"`;

/** A real git repo with one commit. */
const repo = path.join(tmpRoot, "repo");
await fs.mkdir(repo, { recursive: true });
const tracked = path.join(repo, "app.ts");
async function git(...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, windowsHide: true });
  return stdout.trim();
}
await git("init", "-b", "main");
await git("config", "user.email", "t@t");
await git("config", "user.name", "T");
await fs.writeFile(tracked, "export const a = 1;\n", "utf8");
await git("add", "-A");
await git("commit", "-m", "init");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${extra}`);
  }
}
async function spawnCount(): Promise<number> {
  try {
    const raw = await fs.readFile(spawnLog, "utf8");
    return raw.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}
async function touch(file: string, marker: string) {
  const prev = await fs.readFile(file, "utf8");
  await fs.writeFile(file, `${prev}${marker}\n`, "utf8");
}

// --- 1. check detection ------------------------------------------------------
console.log("\n== detection ==");
const noEnv = { env: {}, commands: {}, projectTrusted: false };

/** Create a real git repo with optional files. */
async function makeGitRepo(name: string, files: Record<string, string> = {}) {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  }
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir, windowsHide: true });
  return dir;
}

const pkgRepo = path.join(tmpRoot, "pkg");
await fs.mkdir(pkgRepo, { recursive: true });
await fs.writeFile(
  path.join(pkgRepo, "package.json"),
  JSON.stringify({ scripts: { test: "vitest", check: "tsc && vitest" } }),
  "utf8",
);
await fs.writeFile(path.join(pkgRepo, "pnpm-lock.yaml"), "", "utf8");
let spec = await resolveCheck(pkgRepo, noEnv);
check("package.json: check preferred over test", spec?.command === "pnpm run check", spec?.command);
check("package.json: label names the script+pm", spec?.label === "package.json:check (pnpm)", spec?.label);
check("package.json: source recorded", spec?.source === "package");

await fs.writeFile(path.join(pkgRepo, "bun.lockb"), "", "utf8");
await fs.rm(path.join(pkgRepo, "pnpm-lock.yaml"));
spec = await resolveCheck(pkgRepo, noEnv);
check("lockfile picks bun", spec?.command === "bun run check", spec?.command);

const cargoRepo = path.join(tmpRoot, "cargo");
await fs.mkdir(cargoRepo, { recursive: true });
await fs.writeFile(path.join(cargoRepo, "Cargo.toml"), "[package]\nname='x'\n", "utf8");
spec = await resolveCheck(cargoRepo, noEnv);
check("Cargo.toml detected", spec?.command === "cargo test --quiet", spec?.command);

const goRepo = path.join(tmpRoot, "go");
await fs.mkdir(goRepo, { recursive: true });
await fs.writeFile(path.join(goRepo, "go.mod"), "module x\n", "utf8");
check("go.mod detected", (await resolveCheck(goRepo, noEnv))?.command === "go test ./...");

const pyRepo = path.join(tmpRoot, "py");
await fs.mkdir(pyRepo, { recursive: true });
await fs.writeFile(path.join(pyRepo, "pyproject.toml"), "[project]\n", "utf8");
check("pyproject detected", (await resolveCheck(pyRepo, noEnv))?.command === "python -m pytest -q");

const makeRepo = path.join(tmpRoot, "make");
await fs.mkdir(makeRepo, { recursive: true });
await fs.writeFile(path.join(makeRepo, "Makefile"), "all:\n\techo hi\n\ncheck:\n\techo check\n", "utf8");
check("Makefile check: target detected", (await resolveCheck(makeRepo, noEnv))?.command === "make check");

const makeNoRepo = path.join(tmpRoot, "make-no-check");
await fs.mkdir(makeNoRepo, { recursive: true });
await fs.writeFile(path.join(makeNoRepo, "Makefile"), "all:\n\techo hi\n", "utf8");
check("Makefile without check: target -> null", (await resolveCheck(makeNoRepo, noEnv)) === null);

spec = await resolveCheck(pkgRepo, { ...noEnv, env: { VERIFY_GATE_CMD: "my-cmd --go" } });
check("VERIFY_GATE_CMD wins over detection", spec?.command === "my-cmd --go" && spec?.source === "env");

// npm init -y writes a placeholder test script; that is NOT a real check.
const placeholderRepo = await makeGitRepo("placeholder", {
  "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
});
check("npm-init placeholder script is not a check", (await resolveCheck(placeholderRepo, noEnv)) === null);
const placeholderRes = await refreshVerify(placeholderRepo, true, {
  env: {},
  commands: {},
  projectTrusted: false,
});
check("placeholder-only repo -> no-check", placeholderRes.reason === "no-check", placeholderRes.reason);
check("placeholder-only repo yields no result", placeholderRes.result === null);

const exitOnlyRepo = await makeGitRepo("exit-only", {
  "package.json": JSON.stringify({ scripts: { check: "exit 1" } }),
});
check("bare 'exit 1' script is a placeholder too", (await resolveCheck(exitOnlyRepo, noEnv)) === null);

const realCheckRepo = await makeGitRepo("real-check", {
  "package.json": JSON.stringify({ scripts: { test: "echo ok", check: "exit 1" } }),
});
check(
  "placeholder check falls through to a real test script",
  (await resolveCheck(realCheckRepo, noEnv))?.command === "npm run test",
  (await resolveCheck(realCheckRepo, noEnv))?.command,
);

// Project-local config is trust-gated and read from the git root.
const projRepo = await makeGitRepo("proj", {
  [`${CONFIG_DIR_NAME}/verify-gate.json`]: JSON.stringify({ command: "project-cmd" }),
});
check("untrusted project config is ignored", (await resolveCheck(projRepo, noEnv)) === null);
check(
  "trusted project config is read",
  (await resolveCheck(projRepo, { ...noEnv, projectTrusted: true }))?.command === "project-cmd",
);
const projRoot = (await repoRoot(projRepo))!;
check("readProjectCommand resolves from the git root", readProjectCommand(projRoot) === "project-cmd");

// A persisted /verify cmd override is per-repo: a Python override must not run
// in a Rust repo.
const repoA = await makeGitRepo("iso-a", { "package.json": JSON.stringify({ scripts: { check: "echo A" } }) });
const repoB = await makeGitRepo("iso-b", {});
const rootA = (await repoRoot(repoA))!;
const rootB = (await repoRoot(repoB))!;
const perRepo = { [rootA]: "echo A-override" };
check(
  "cmd override applies to its own repo",
  (await resolveCheck(rootA, { ...noEnv, commands: perRepo }))?.command === "echo A-override",
);
check(
  "cmd override does NOT leak into another repo",
  (await resolveCheck(rootB, { ...noEnv, commands: perRepo })) === null,
);
check(
  "project command beats the /verify cmd override",
  (await resolveCheck(projRoot, { ...noEnv, commands: { [projRoot]: "global-cmd" }, projectTrusted: true }))?.command ===
    "project-cmd",
);
spec = await resolveCheck(rootA, { ...noEnv, commands: { [rootA]: "global-cmd" } });
check("/verify cmd override beats detection", spec?.command === "global-cmd" && spec?.source === "config");

// --- 2. tree key -------------------------------------------------------------
console.log("\n== tree key ==");
const k1 = await treeKey(repo);
check("tree key stable when nothing changed", (await treeKey(repo)) === k1);
await touch(tracked, "// edit");
const k2 = await treeKey(repo);
check("tracked edit changes the key", k2 !== k1);
const untracked = path.join(repo, "new-file.ts");
await fs.writeFile(untracked, "one\n", "utf8");
const k3 = await treeKey(repo);
check("new untracked file changes the key", k3 !== k2);
await fs.writeFile(untracked, "two\n", "utf8");
check("untracked content change changes the key", (await treeKey(repo)) !== k3);

// --- 3. runCheck outcomes ----------------------------------------------------
console.log("\n== runCheck outcomes ==");
process.env.CHECK_SHIM_MODE = "pass";
let outcome = await runCheck(repo, process.env.VERIFY_GATE_CMD!);
check("exit 0 -> pass", outcome.status === "pass", outcome.status);
check("pass records exit code 0", outcome.exitCode === 0);

process.env.CHECK_SHIM_MODE = "fail";
outcome = await runCheck(repo, process.env.VERIFY_GATE_CMD!);
check("exit 1 -> fail", outcome.status === "fail", outcome.status);
check("fail records exit code 1", outcome.exitCode === 1);
const hints = extractFailureHints(outcome.output);
check("failure hints find the FAIL line", hints.some((h) => h.includes("FAIL")), JSON.stringify(hints));
check("failure hints find the assertion", hints.some((h) => h.includes("AssertionError")));
check("failure hints are bounded to 3", hints.length <= 3, String(hints.length));
check("hints find a SyntaxError", extractFailureHints("SyntaxError: Invalid or unexpected token").length === 1);
check("hints find a TypeError", extractFailureHints("TypeError: x is not a function").length === 1);
check(
  "hints find a python Traceback",
  extractFailureHints("Traceback (most recent call last):").some((h) => h.includes("Traceback")),
);
check(
  "hints find a cargo error[E]",
  extractFailureHints("error[E0308]: mismatched types").some((h) => h.includes("error[E0308]")),
);
check("hints find a tsc error", extractFailureHints("src/a.ts(3,1): error TS2322: bad").length === 1);
check("hints stay quiet on clean output", extractFailureHints("all tests passed\n3 passing\nOK").length === 0);

process.env.CHECK_SHIM_MODE = "slow";
outcome = await runCheck(repo, process.env.VERIFY_GATE_CMD!, 300);
check("timeout reported as timeout", outcome.status === "timeout", outcome.status);
check("timeout is not reported as fail", outcome.status !== "fail");

outcome = await runCheck(repo, "definitely-not-a-real-command-xyz-123");
check("missing command -> unavailable (not fail)", outcome.status === "unavailable", outcome.status);

// --- 4. tail truncation ------------------------------------------------------
console.log("\n== tail truncation ==");
process.env.CHECK_SHIM_MODE = "pass";
process.env.CHECK_SHIM_LINES = "200";
outcome = await runCheck(repo, process.env.VERIFY_GATE_CMD!);
const tail = tailOf(outcome.output);
check("tail respects the line cap", tail.split("\n").length <= 40, String(tail.split("\n").length));
check("tail keeps the END of the output", tail.includes("OK: nothing to report"), tail.slice(0, 60));
check("tail drops the noisy start", !tail.includes("filler line 1\n"));
check("tailOf caps chars", tailOf("x".repeat(9000), 100).length === 4000);
delete process.env.CHECK_SHIM_LINES;

// --- 5. badge / line derivation ---------------------------------------------
console.log("\n== badge + line derivation ==");
const mk = (status: VerifyResult["status"], failures: string[] = []): VerifyResult => ({
  status,
  commandId: "env:abcd1234",
  label: "VERIFY_GATE_CMD",
  command: "cmd",
  exitCode: status === "pass" ? 0 : status === "unavailable" ? null : 1,
  durationMs: 12,
  tail: "",
  failures,
  finishedAt: Date.now(),
});
check("pass badge", badgeText(mk("pass")) === "Verify: ✓");
check("fail badge without hints", badgeText(mk("fail")) === "Verify: ✗");
check("fail badge counts hints", badgeText(mk("fail", ["a", "b"])) === "Verify: ✗ 2");
check("timeout badge", badgeText(mk("timeout")) === "Verify: ⏱");
check("unavailable badge", badgeText(mk("unavailable")) === "Verify: –");
check("no result badge", badgeText(null) === "Verify: –");
check("statusLine pass", statusLine(mk("pass"), "main").includes("passing"));
check("statusLine fail mentions exit", statusLine(mk("fail"), "main").includes("FAILING"));
check("statusLine unavailable is not a failure", !statusLine(mk("unavailable"), "main").includes("FAILING"));
check("formatResult lists the command", formatResult(mk("fail"), "main", repo).includes("command: cmd"));
check("signature excludes output", resultSignature("env:abcd1234", "fail") === "env:abcd1234|fail");

// --- 6. badge + run modes ----------------------------------------------------
console.log("\n== modes ==");
check("badge default is activity", resolveBadgeMode({}) === "activity");
check("badge always", resolveBadgeMode({ VERIFY_GATE_BADGE: "always" }) === "always");
check("badge off (case-insensitive)", resolveBadgeMode({ VERIFY_GATE_BADGE: "OFF" }) === "off");
check("badge invalid -> activity", resolveBadgeMode({ VERIFY_GATE_BADGE: "sometimes" }) === "activity");
check("shouldShow: activity + null", shouldShowBadge("activity", null) === false);
check("shouldShow: activity + result", shouldShowBadge("activity", mk("pass")) === true);
check("shouldShow: always + null", shouldShowBadge("always", null) === true);
check("shouldShow: off + result", shouldShowBadge("off", mk("pass")) === false);
check("override wins over env", effectiveBadgeMode({ VERIFY_GATE_BADGE: "always" }, "off") === "off");
check("run mode default auto", resolveRunMode({}) === "auto");
check("run mode off", resolveRunMode({ VERIFY_GATE_MODE: "off" }) === "off");
check("run mode invalid -> auto", resolveRunMode({ VERIFY_GATE_MODE: "maybe" }) === "auto");

// --- 7. config roundtrip -----------------------------------------------------
console.log("\n== config roundtrip ==");
const cfgFile = configFilePath();
check("loadConfig: missing file -> {}", Object.keys(loadConfig(cfgFile)).length === 0);
saveConfig(cfgFile, { badge: "off" });
check("config badge roundtrip", loadConfig(cfgFile).badge === "off");
saveConfig(cfgFile, { commands: { "/repo/a": "pnpm run check" } });
check("config commands roundtrip", loadConfig(cfgFile).commands?.["/repo/a"] === "pnpm run check", JSON.stringify(loadConfig(cfgFile).commands));
saveConfig(cfgFile, { commands: { "/repo/a": "x", "/repo/b": "y" } });
check("config commands replace the map", Object.keys(loadConfig(cfgFile).commands ?? {}).length === 2);
saveConfig(cfgFile, { commands: {} });
check("config commands cleared", loadConfig(cfgFile).commands === undefined);
check("config still has badge after clearing commands", loadConfig(cfgFile).badge === "off");
// `run` is no longer a config field (run mode is VERIFY_GATE_MODE only).
await fs.writeFile(cfgFile, JSON.stringify({ badge: "nonsense", run: "off" }), "utf8");
check("config ignores invalid values", Object.keys(loadConfig(cfgFile)).length === 0, JSON.stringify(loadConfig(cfgFile)));
await fs.writeFile(cfgFile, JSON.stringify({ commands: { a: 1, b: "ok" } }), "utf8");
check("config keeps only valid command entries", JSON.stringify(loadConfig(cfgFile).commands) === '{"b":"ok"}', JSON.stringify(loadConfig(cfgFile).commands));

// --- 8. refresh gate + transitions -------------------------------------------
console.log("\n== refresh gate + transitions ==");
const gateInput = {
  env: { VERIFY_GATE_CMD: process.env.VERIFY_GATE_CMD! },
  commands: {},
  projectTrusted: false,
};
const before = await spawnCount();
process.env.CHECK_SHIM_MODE = "pass";
let res = await refreshVerify(repo, true, gateInput);
check("force run executes the check", res.reason === "ok" && res.result?.status === "pass", res.reason);
check("first sight is not a transition", res.transition === false);
check("one spawn for the forced run", (await spawnCount()) === before + 1, String(await spawnCount()));
check("badge reflected on result", badgeText(res.result) === "Verify: ✓");

const afterFirst = await spawnCount();
res = await refreshVerify(repo, false, gateInput);
check("unchanged tree -> throttled", res.reason === "throttled", res.reason);
check("throttled reuses the cached result", res.result?.status === "pass");
check("no extra spawn when throttled", (await spawnCount()) === afterFirst, String(await spawnCount()));

await touch(tracked, "// change to force a re-run");
process.env.CHECK_SHIM_MODE = "fail";
res = await refreshVerify(repo, false, gateInput);
check("changed tree re-runs without force", res.reason === "ok", res.reason);
check("pass->fail is a transition", res.transition === true);
check("fail status recorded", res.result?.status === "fail", res.result?.status);
const line = statusLine(res.result!, res.branch);
check("transition line mentions failure", line.includes("FAILING"), line);

res = await refreshVerify(repo, true, gateInput);
check("same signature does not re-transition", res.transition === false);

// unavailable -> pass transition (toolchain appears/disappears)
await touch(tracked, "// again");
process.env.CHECK_SHIM_MODE = "pass2-nonsense-exit-2";
check("unknown shim mode exits 2 -> fail", (await refreshVerify(repo, true, gateInput)).result?.status === "fail");

await touch(tracked, "// third");
process.env.CHECK_SHIM_MODE = "pass";
res = await refreshVerify(repo, true, gateInput);
check("fail->pass transition", res.transition === true && res.result?.status === "pass");
await flushState();
const persisted = JSON.parse(await fs.readFile(stateFilePath(), "utf8")) as Record<string, { lastInjectKey: string; result: { status: string } }>;
const persistedKeys = Object.keys(persisted);
// Compare against git's own root path: on Windows it differs from our temp path
// (forward slashes, and 8.3 short names like FERDIN~1).
const gitRoot = await repoRoot(repo);
check("state persisted per repo root", persistedKeys.length === 1 && gitRoot !== null && persistedKeys[0] === gitRoot, JSON.stringify(persistedKeys));
check("persisted inject key matches signature", Object.values(persisted)[0].lastInjectKey.endsWith("|pass"), JSON.stringify(Object.values(persisted)[0]));

// --- 9. post-run key recording (the re-run loop bug) -------------------------
console.log("\n== post-run key recording ==");
process.env.CHECK_SHIM_MODE = "touch";
process.env.CHECK_SHIM_TOUCH = tracked;
const beforeTouch = await spawnCount();
res = await refreshVerify(repo, true, gateInput);
check("touch check ran", res.reason === "ok" && res.result?.status === "pass", res.reason);
check("one spawn for the touch run", (await spawnCount()) === beforeTouch + 1);
// flushState() first: persist() is chained, so an un-awaited read races the write.
await flushState();
const recorded = JSON.parse(await fs.readFile(stateFilePath(), "utf8")) as Record<string, { lastKey: string }>;
const recordedKey = (gitRoot !== null ? recorded[gitRoot]?.lastKey : undefined) ?? Object.values(recorded)[0].lastKey;
check("recorded key is the POST-run tree", recordedKey === (await treeKey(repo)), "pre-run key would mismatch");
res = await refreshVerify(repo, false, gateInput);
check("check that rewrites the tree does not re-run", res.reason === "throttled", res.reason);
check("no extra spawn after a tree-rewriting check", (await spawnCount()) === beforeTouch + 1, String(await spawnCount()));
delete process.env.CHECK_SHIM_TOUCH;

// --- 10. no-check / no-repo --------------------------------------------------
console.log("\n== inert cases ==");
const noCheckInput = { env: {}, commands: {}, projectTrusted: false };
// A real git repo with nothing detectable — repoRoot succeeds, resolveCheck does not.
const plainRepo = path.join(tmpRoot, "plain-repo");
await fs.mkdir(plainRepo, { recursive: true });
await execFileAsync("git", ["init", "-b", "main"], { cwd: plainRepo, windowsHide: true });
check("plain git repo has no detectable check", (await resolveCheck(plainRepo, noCheckInput)) === null);
res = await refreshVerify(plainRepo, true, noCheckInput);
check("git repo with no detectable check -> reason no-check", res.reason === "no-check", res.reason);
check("no-check yields no result", res.result === null);

const notARepo = path.join(tmpRoot, "not-a-repo");
await fs.mkdir(notARepo, { recursive: true });
if ((await repoRoot(notARepo)) === null) {
  res = await refreshVerify(notARepo, true, noCheckInput);
  check("non-repo -> reason no-repo", res.reason === "no-repo", res.reason);
} else {
  console.log("  ..  skipped non-repo check (temp dir is inside a git repo)");
}

// --- 11. extension wiring (edge-triggered injection) -------------------------
console.log("\n== extension wiring ==");
type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
const handlers: Record<string, Handler[]> = {};
const statuses: Record<string, string | undefined> = {};
const notes: { msg: string; type?: string }[] = [];
/* eslint-disable @typescript-eslint/no-explicit-any */
let toolDef: any = null;
let commandDef: any = null;

const ctxMock = {
  cwd: repo,
  hasUI: true,
  isIdle: () => true,
  isProjectTrusted: () => false,
  ui: {
    setStatus: (k: string, v: string | undefined) => {
      statuses[k] = v;
    },
    notify: (msg: string, type?: string) => {
      notes.push({ msg, type });
    },
  },
};

const piMock = {
  on: (name: string, fn: Handler) => {
    (handlers[name] ??= []).push(fn);
  },
  registerTool: (def: unknown) => {
    toolDef = def;
  },
  registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    commandDef = { name, handler: (args: string) => def.handler(args, ctxMock) };
  },
} as unknown as Parameters<typeof verifyGateExtension>[0];
const fire = async (name: string, event: Record<string, unknown> = {}) => {
  const out: unknown[] = [];
  for (const h of handlers[name] ?? []) out.push(await h(event, ctxMock));
  return out;
};

verifyGateExtension(piMock);
check("registers verify_status tool", toolDef?.name === "verify_status", String(toolDef?.name));
check("registers /verify command", commandDef?.name === "verify", String(commandDef?.name));

await fire("session_start", {});
check("session_start does not spawn a check", (await spawnCount()) === beforeTouch + 1, String(await spawnCount()));

process.env.CHECK_SHIM_MODE = "pass";
await touch(tracked, "// wiring pass");
await fire("agent_settled", {});
check("agent_settled does not block (handler returns before the check finishes)", true);
await flushRuns();
check("badge set from agent_settled", statuses["verify"] === "Verify: ✓", statuses["verify"]);

console.log("\n== auto-run off ==");
const beforeOff = await spawnCount();
process.env.VERIFY_GATE_MODE = "off";
await touch(tracked, "// while off");
await fire("agent_settled", {});
await flushRuns();
check("VERIFY_GATE_MODE=off skips the auto-run", (await spawnCount()) === beforeOff, String(await spawnCount()));
delete process.env.VERIFY_GATE_MODE;

console.log("\n== edge-triggered injection ==");
process.env.CHECK_SHIM_MODE = "fail";
await touch(tracked, "// wiring fail");
await fire("agent_settled", {});
await flushRuns();
check("badge flips to fail", statuses["verify"]?.startsWith("Verify: ✗") === true, statuses["verify"]);
check("one notification on transition", notes.some((n) => n.msg.includes("FAILING")), JSON.stringify(notes.slice(-1)));
const injected = (await fire("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt?: string }[];
check("injects one line into the next turn", injected[0]?.systemPrompt?.includes("FAILING") === true, JSON.stringify(injected[0]));
check("injected prompt preserves the base prompt", injected[0]?.systemPrompt?.startsWith("BASE") === true);
const second = (await fire("before_agent_start", { systemPrompt: "BASE" })) as (undefined | { systemPrompt?: string })[];
check("injects exactly once (no repeat)", second[0] === undefined, JSON.stringify(second[0]));
check("reasons are not re-injected on unchanged signature", notes.filter((n) => n.msg.includes("FAILING")).length === 1, String(notes.filter((n) => n.msg.includes("FAILING")).length));

await fire("session_shutdown", {});
check("shutdown clears the badge", statuses["verify"] === undefined, statuses["verify"]);

// --- 12. tool + command surface ---------------------------------------------
console.log("\n== tool + command ==");
const toolResult = await toolDef.execute("call-1", { refresh: true }, undefined, undefined, ctxMock);
check("verify_status returns formatted detail", toolResult.content[0].text.includes("status:"), toolResult.content[0].text.slice(0, 60));
check("verify_status reports the shim command", toolResult.content[0].text.includes("check-shim.mjs"));

await commandDef.handler("status");
check("/verify notifies the current status", notes.some((n) => n.msg.includes("Verify:")), JSON.stringify(notes.slice(-1)));
await commandDef.handler("badge off");
check("/verify badge off persists", loadConfig(configFilePath()).badge === "off");
await commandDef.handler("badge reset");
check("/verify badge reset clears the override", loadConfig(configFilePath()).badge === undefined);
const cmdRoot = (await repoRoot(repo))!;
await commandDef.handler("cmd my custom check");
check(
  "/verify cmd persists a per-repo override (keyed by git root)",
  loadConfig(configFilePath()).commands?.[cmdRoot] === "my custom check",
  JSON.stringify(loadConfig(configFilePath()).commands),
);
await commandDef.handler("cmd reset");
check(
  "/verify cmd reset clears the override for this repo only",
  !(cmdRoot in (loadConfig(configFilePath()).commands ?? {})),
  JSON.stringify(loadConfig(configFilePath()).commands),
);

console.log(`\n${pass} passed, ${fail} failed`);
try {
  await fs.rm(tmpRoot, { recursive: true, force: true });
} catch {
  // Windows can hold a cwd lock on the temp dir if a killed check left an
  // orphan process behind. Cleanup must never fail the run.
  console.log(`  ..  temp dir left behind: ${tmpRoot}`);
}
process.exit(fail === 0 ? 0 : 1);
