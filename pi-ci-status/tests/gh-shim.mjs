#!/usr/bin/env node
/**
 * Fake `gh` CLI for testing pi-ci-status.
 * - `gh --version`          → prints a version, exit 0
 * - `gh auth status`        → exit 0, or exit 1 when GH_SHIM_AUTH_FAIL=1
 * - `gh run list ...`       → prints the contents of GH_SHIM_RUNS_FILE (JSON array)
 *                             and appends one line to GH_SHIM_LOG per invocation
 * - anything else           → exit 2
 */
import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("gh version 99.0.0 (shim)");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (process.env.GH_SHIM_AUTH_FAIL === "1") {
    console.error("! not logged in");
    process.exit(1);
  }
  console.log("Logged in to github.com (shim)");
  process.exit(0);
}

if (args[0] === "run" && args[1] === "list") {
  const log = process.env.GH_SHIM_LOG;
  if (log) appendFileSync(log, `${Date.now()}\n`);
  const file = process.env.GH_SHIM_RUNS_FILE;
  if (!file) {
    console.log("[]");
  } else {
    console.log(readFileSync(file, "utf8"));
  }
  process.exit(0);
}

console.error(`unexpected args: ${args.join(" ")}`);
process.exit(2);
