/**
 * Functional test for pi-review-debt core logic.
 * Run: node --experimental-strip-types tests/review-debt.test.ts
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  addFinding,
  checkFindings,
  describeFinding,
  findFinding,
  findingsMarkdown,
  flushState,
  loadState,
  setFindingStatus,
  stateFilePath,
  summarize,
} from "../src/review-debt.ts";

const execFileAsync = promisify(execFile);

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rd-test-"));
process.env.REVIEW_DEBT_STATE = path.join(tmpRoot, "state.json");

// --- temp git repo ----------------------------------------------------------
const repo = path.join(tmpRoot, "repo");
await fs.mkdir(repo, { recursive: true });
async function git(...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, windowsHide: true });
  return stdout.trim();
}
await git("init", "-b", "main");
await git("config", "user.email", "t@t");
await git("config", "user.name", "T");
const file = path.join(repo, "src", "app.ts");
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, "export const a = 1;\n", "utf8");
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

// --- 1. record a finding ----------------------------------------------------
console.log("\n== record ==");
const f1 = await addFinding({
  title: "Handle null from fetch",
  severity: "critical",
  file: "src/app.ts",
  line: 3,
  detail: "fetch may return null",
  source: "agent",
  cwd: repo,
});
check("finding created with id", /^rd-[a-z0-9]+$/.test(f1.id), f1.id);
check("status open", f1.status === "open");
check("blob baseline captured", typeof f1.fileBlobAtCreate === "string" && f1.fileBlobAtCreate.length === 40, String(f1.fileBlobAtCreate));
await flushState();
check("state persisted", (await fs.readFile(stateFilePath(), "utf8")).includes(f1.id));

// --- 2. no change → still open ---------------------------------------------
console.log("\n== no change ==");
let { changed } = await checkFindings(repo);
check("no change detected", changed.length === 0);
const after1 = (await loadState()).findings.find((f) => f.id === f1.id)!;
check("still open", after1.status === "open");

// --- 3. modify the file → auto-addressed -----------------------------------
console.log("\n== file changed ==");
await fs.writeFile(file, "export const a = 2;\nexport const b = 3;\n", "utf8");
({ changed } = await checkFindings(repo));
check("change detected", changed.length === 1 && changed[0].id === f1.id);
const after2 = (await loadState()).findings.find((f) => f.id === f1.id)!;
check("transitioned to addressed", after2.status === "addressed");
check("changedSinceCreate flagged", after2.changedSinceCreate === true);

// --- 4. prefix id lookup + resolve -----------------------------------------
console.log("\n== resolve ==");
const prefix = f1.id.slice(0, 6);
const found = findFinding(await loadState(), prefix);
check("prefix id match", found?.id === f1.id);
const resolved = await setFindingStatus(prefix, "resolved", repo);
check("resolved", resolved?.status === "resolved" && typeof resolved.resolvedAt === "number");

// --- 5. second finding: dismiss --------------------------------------------
console.log("\n== dismiss ==");
const f2 = await addFinding({
  title: "Rename helper",
  severity: "info",
  file: "src/other.ts",
  source: "user",
  cwd: repo,
});
const dismissed = await setFindingStatus(f2.id, "dismissed", repo);
check("dismissed", dismissed?.status === "dismissed");

// --- 6. unknown id ----------------------------------------------------------
const missing = await setFindingStatus("rd-nope", "resolved", repo);
check("unknown id → null", missing === null);

// --- 7. formatting ----------------------------------------------------------
console.log("\n== formatting ==");
const state = await loadState();
const summary = summarize(state);
check("summary counts", summary.includes("1 resolved") && summary.includes("1 dismissed"), summary);
const md = findingsMarkdown(state.findings);
check("markdown lists findings", md.includes(f1.id) && md.includes("src/app.ts"), md);
check("describe has id+severity", describeFinding(f1).includes(f1.id) && describeFinding(f1).includes("critical"));

// --- 8. change detection for deleted file ----------------------------------
console.log("\n== file deleted ==");
await fs.writeFile(path.join(repo, "src", "gone.ts"), "const x = 1;\n", "utf8");
const f3 = await addFinding({
  title: "Remove dead code",
  severity: "warning",
  file: "src/gone.ts",
  source: "agent",
  cwd: repo,
});
const f3b = (await loadState()).findings.find((f) => f.id === f3.id)!;
check("untracked file blob captured", typeof f3b.fileBlobAtCreate === "string", String(f3b.fileBlobAtCreate));
await fs.rm(path.join(repo, "src", "gone.ts"));
({ changed } = await checkFindings(repo));
check("deleted file → addressed", changed.some((f) => f.id === f3.id));

// --- 9. no repo → check is a no-op -----------------------------------------
console.log("\n== no repo ==");
const empty = await fs.mkdtemp(path.join(tmpRoot, "norepo-"));
({ changed } = await checkFindings(empty));
check("no repo → no changes", changed.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmpRoot, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
