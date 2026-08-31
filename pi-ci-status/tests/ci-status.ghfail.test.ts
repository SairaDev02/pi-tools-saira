/**
 * No-op behavior test: gh missing, and gh present but unauthenticated.
 * Run each scenario in its own process (the gh gate is cached per process):
 *   CI_STATUS_GH_BIN=/nonexistent/gh node --experimental-strip-types tests/ci-status.ghfail.test.ts
 *   CI_STATUS_GH_BIN="$PWD/tests/gh-shim.mjs" GH_SHIM_AUTH_FAIL=1 node --experimental-strip-types tests/ci-status.ghfail.test.ts
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureGh, flushState, refreshStatus, stateFilePath } from "../src/ci-status.ts";

const execFileAsync = promisify(execFile);

process.env.CI_STATUS_STATE = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ci-ghfail-")), "state.json");
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ci-ghfail-repo-"));
const repo = path.join(tmpRoot, "repo");
await fs.mkdir(repo, { recursive: true });
async function git(...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, windowsHide: true });
  return stdout.trim();
}
await git("init", "-b", "main");
await git("config", "user.email", "t@t");
await git("config", "user.name", "T");
await fs.writeFile(path.join(repo, "a.ts"), "export const a = 1;\n", "utf8");
await git("add", "-A");
await git("commit", "-m", "init");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

check("ensureGh false", (await ensureGh()) === false);
const r = await refreshStatus(repo);
check("refreshStatus returns null snapshot", r.snapshot === null);
check("no transition", r.transition === false);
await flushState();
let stateExists = true;
try { await fs.access(stateFilePath()); } catch { stateExists = false; }
check("no state file written (gate blocked before fetch)", stateExists === false);

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmpRoot, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
