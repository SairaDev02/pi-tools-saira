#!/usr/bin/env node
/**
 * Fake local check for testing pi-verify-gate.
 *
 * Behavior is driven by env vars so the test can flip outcomes between runs:
 *   CHECK_SHIM_MODE   pass (default) | fail | slow | touch
 *   CHECK_SHIM_LOG    append one line per invocation (used for spawn counts)
 *   CHECK_SHIM_LINES  print N filler lines (tail/truncation tests)
 *   CHECK_SHIM_TOUCH  file to append to (mode=touch) — simulates a check that
 *                     rewrites the tree, which must NOT cause a re-run loop
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.CHECK_SHIM_MODE ?? "pass";
const log = process.env.CHECK_SHIM_LOG;
if (log) appendFileSync(log, `${mode} ${Date.now()}\n`);

const filler = Number(process.env.CHECK_SHIM_LINES ?? "0");
if (Number.isFinite(filler) && filler > 0) {
  for (let i = 1; i <= filler; i++) console.log(`filler line ${i}`);
}

if (mode === "pass") {
  console.log("OK: nothing to report");
  process.exit(0);
}

if (mode === "fail") {
  console.log("PASS  src/util.test.ts > formats a date");
  console.log("FAIL  src/foo.test.ts > adds numbers");
  console.log("AssertionError: expected 1 to be 2");
  process.exit(1);
}

if (mode === "touch") {
  const target = process.env.CHECK_SHIM_TOUCH;
  if (target) {
    const prev = readFileSync(target, "utf8");
    writeFileSync(target, `${prev}\n// rewritten by the check\n`, "utf8");
  }
  console.log("OK: rewrote a file during the check");
  process.exit(0);
}

if (mode === "slow") {
  // Runs past the timeout used in tests; the runner must kill and report.
  // Kept short so a killed run cannot leave an orphan holding a cwd lock on Windows.
  setTimeout(() => process.exit(0), 5_000);
} else {
  console.error(`unknown CHECK_SHIM_MODE: ${mode}`);
  process.exit(2);
}
