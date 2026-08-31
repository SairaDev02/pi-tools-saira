/**
 * Functional test for pi-ci-status using a fake gh shim.
 * Run: CI_STATUS_TTL_MS=1 node --experimental-strip-types tests/ci-status.test.ts
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  badgeText,
  currentBranch,
  deriveSnapshot,
  effectiveBadgeMode,
  ensureGh,
  fetchRuns,
  flushState,
  formatStatus,
  loadBadgeOverride,
  loadState,
  refreshStatus,
  resolveBadgeMode,
  saveBadgeOverride,
  shouldShowBadge,
  stateFilePath,
  statusLine,
} from "../src/ci-status.ts";

const execFileAsync = promisify(execFile);
const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "gh-shim.mjs");
process.env.CI_STATUS_GH_BIN = shim;
process.env.CI_STATUS_STATE = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ci-state-")), "state.json");
const spawnLog = path.join(os.tmpdir(), `ci-spawns-${Date.now()}.log`);
process.env.GH_SHIM_LOG = spawnLog;

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ci-repo-"));
const repo = path.join(tmpRoot, "repo");
await fs.mkdir(repo, { recursive: true });
async function git(...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, windowsHide: true });
  return stdout.trim();
}
await git("init", "-b", "main");
await git("config", "user.email", "t@t");
await git("config", "user.name", "T");
const file = path.join(repo, "app.ts");
await fs.writeFile(file, "export const a = 1;\n", "utf8");
await git("add", "-A");
await git("commit", "-m", "init");

const runsOk = path.join(tmpRoot, "runs-ok.json");
const runsFail = path.join(tmpRoot, "runs-fail.json");
const runsMixed = path.join(tmpRoot, "runs-mixed.json");
await fs.writeFile(
  runsOk,
  JSON.stringify([
    { databaseId: 101, workflowName: "ci", status: "completed", conclusion: "success", headSha: "abc", createdAt: "2026-08-31T10:00:00Z", url: "https://github.com/x/y/actions/runs/101" },
    { databaseId: 100, workflowName: "lint", status: "completed", conclusion: "success", headSha: "abc", createdAt: "2026-08-31T09:00:00Z", url: "https://github.com/x/y/actions/runs/100" },
  ]),
);
await fs.writeFile(
  runsFail,
  JSON.stringify([
    { databaseId: 102, workflowName: "test", status: "completed", conclusion: "failure", headSha: "def", createdAt: "2026-08-31T11:00:00Z", url: "https://github.com/x/y/actions/runs/102" },
    { databaseId: 101, workflowName: "ci", status: "completed", conclusion: "success", headSha: "abc", createdAt: "2026-08-31T10:00:00Z", url: "https://github.com/x/y/actions/runs/101" },
  ]),
);
await fs.writeFile(
  runsMixed,
  JSON.stringify([
    { databaseId: 103, workflowName: "deploy", status: "in_progress", conclusion: null, headSha: "ghi", createdAt: "2026-08-31T12:00:00Z", url: "https://github.com/x/y/actions/runs/103" },
    { databaseId: 102, workflowName: "test", status: "completed", conclusion: "failure", headSha: "def", createdAt: "2026-08-31T11:00:00Z", url: "https://github.com/x/y/actions/runs/102" },
  ]),
);

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

// --- 1. gh gate + initial fetch --------------------------------------------
console.log("\n== gate + initial fetch ==");
check("ensureGh true (shim present + auth ok)", (await ensureGh()) === true);
process.env.GH_SHIM_RUNS_FILE = runsOk;
let r = await refreshStatus(repo);
check("initial fetch returns snapshot", r.snapshot !== null);
check("branch detected", r.branch === "main");
check("no transition on first sight", r.transition === false);
check("badge green", r.snapshot!.badge === "CI: ✓", r.snapshot!.badge);
check("latest is newest run", r.snapshot!.latest!.databaseId === 101);
check("no failing runs", r.snapshot!.failing.length === 0);
await flushState();
check("state persisted", (await fs.readFile(stateFilePath(), "utf8")).includes("main"));
check("exactly 1 gh spawn so far", (await spawnCount()) === 1, String(await spawnCount()));

// --- 2. throttle + HEAD-unchanged skip -------------------------------------
console.log("\n== throttle (TTL=1ms, HEAD unchanged) ==");
r = await refreshStatus(repo);
check("no extra gh spawn (HEAD unchanged)", (await spawnCount()) === 1, String(await spawnCount()));
check("cached snapshot returned", r.snapshot?.badge === "CI: ✓");

// new commit → HEAD changes → fetch allowed again, but same signature → no transition
await fs.writeFile(file, "export const a = 2;\n", "utf8");
await git("add", "-A");
await git("commit", "-m", "change a");
r = await refreshStatus(repo);
check("new HEAD triggers fetch", (await spawnCount()) === 2, String(await spawnCount()));
check("same signature → no transition", r.transition === false);

// --- 3. green→red transition ------------------------------------------------
console.log("\n== green→red ==");
process.env.GH_SHIM_RUNS_FILE = runsFail;
r = await refreshStatus(repo, true); // force (HEAD unchanged since last fetch)
check("force fetch spawns gh", (await spawnCount()) === 3, String(await spawnCount()));
check("transition detected", r.transition === true);
check("badge red", r.snapshot!.badge === "CI: ✗ test", r.snapshot!.badge);
check("failing run counted", r.snapshot!.failing.length === 1 && r.snapshot!.failing[0].databaseId === 102);
const line = statusLine(r.snapshot!, r.branch);
check("status line mentions failure", line.includes("failure") && line.includes("test"), line);
check("formatStatus lists failing", formatStatus(r.snapshot!, r.branch).includes("✗ test"));

// edge-triggered: same signature again → no re-fire
r = await refreshStatus(repo, true);
check("no re-transition on same signature", r.transition === false);

// --- 4. red→in_progress (active) -------------------------------------------
console.log("\n== red→active ==");
process.env.GH_SHIM_RUNS_FILE = runsMixed;
r = await refreshStatus(repo, true);
check("transition red→active detected", r.transition === true);
check("badge spinner", r.snapshot!.badge === "CI: ⟳ deploy", r.snapshot!.badge);
check("failing still counted while active", r.snapshot!.failing.length === 1);

// --- 5. unit checks ----------------------------------------------------------
console.log("\n== derivation units ==");
const noRuns = deriveSnapshot([]);
check("empty → dash badge", noRuns.badge === "CI: –");
check("empty → no latest", noRuns.latest === null);
const activeOnly = deriveSnapshot([
  { databaseId: 1, workflowName: "build", status: "queued", conclusion: null, headSha: "a", createdAt: "2026-08-31T10:00:00Z", url: "u" },
]);
check("queued → spinner badge", activeOnly.badge === "CI: ⟳ build");
check("latest conclusion null → status shown", statusLine(activeOnly, "main").includes("queued"));
check("long workflow name truncated in badge", badgeText({ databaseId: 1, workflowName: "very-long-workflow-name-here", status: "completed", conclusion: "failure", headSha: "a", createdAt: "2026-08-31T10:00:00Z", url: "u" }, []).length < 30);

// --- 6. git/gh helpers -------------------------------------------------------
console.log("\n== git/gh helpers ==");
check("currentBranch = main", (await currentBranch(repo)) === "main");
const fetched = await fetchRuns(repo, "main");
check("fetchRuns parses 2 runs", fetched?.length === 2, String(fetched?.length));

// --- 7. badge visibility modes ----------------------------------------------
console.log("\n== badge visibility modes ==");

check("resolveBadgeMode: default always", resolveBadgeMode({}) === "always");
check("resolveBadgeMode: activity", resolveBadgeMode({ CI_STATUS_BADGE: "activity" }) === "activity");
check("resolveBadgeMode: off (case-insensitive)", resolveBadgeMode({ CI_STATUS_BADGE: "OFF" }) === "off");
check("resolveBadgeMode: invalid -> always", resolveBadgeMode({ CI_STATUS_BADGE: "sometimes" }) === "always");
const noRunSnap = deriveSnapshot([]);
check("shouldShowBadge: always + null snapshot", shouldShowBadge("always", null) === true);
check("shouldShowBadge: always + snapshot", shouldShowBadge("always", r.snapshot) === true);
check("shouldShowBadge: off + snapshot", shouldShowBadge("off", r.snapshot) === false);
check("shouldShowBadge: activity + no runs", shouldShowBadge("activity", noRunSnap) === false);
check("shouldShowBadge: activity + runs", shouldShowBadge("activity", r.snapshot) === true);
check("shouldShowBadge: activity + null snapshot", shouldShowBadge("activity", null) === false);

// --- 8. badge override persistence ------------------------------------------
console.log("\n== badge override persistence ==");

const badgeFile = path.join(tmpRoot, "badge-mode.json");
check("loadBadgeOverride: missing file -> null", loadBadgeOverride(badgeFile) === null);
saveBadgeOverride(badgeFile, "activity");
check("loadBadgeOverride: roundtrip activity", loadBadgeOverride(badgeFile) === "activity");
saveBadgeOverride(badgeFile, "off");
check("loadBadgeOverride: roundtrip off", loadBadgeOverride(badgeFile) === "off");
saveBadgeOverride(badgeFile, null);
check("loadBadgeOverride: cleared -> null", loadBadgeOverride(badgeFile) === null);
await fs.writeFile(badgeFile, JSON.stringify({ mode: "on" }), "utf8");
check("loadBadgeOverride: invalid value -> null", loadBadgeOverride(badgeFile) === null);
check("effectiveBadgeMode: no override -> env", effectiveBadgeMode({ CI_STATUS_BADGE: "activity" }, null) === "activity");
check("effectiveBadgeMode: override wins over env", effectiveBadgeMode({ CI_STATUS_BADGE: "always" }, "activity") === "activity");
check("effectiveBadgeMode: reset -> env default", effectiveBadgeMode({}, null) === "always");

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.rm(spawnLog, { force: true });
process.exit(fail === 0 ? 0 : 1);
