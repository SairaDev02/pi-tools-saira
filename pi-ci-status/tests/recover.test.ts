// Verifies the no-permanent-latch fix: gate fails at load, then recovers
// via the on-demand forced re-probe that ci_status / /ci now use.
import { ensureGh } from "../src/ci-status.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "gh-shim.mjs");
process.env.CI_STATUS_GH_BIN = shim;
process.env.CI_STATUS_STATE = path.join(process.env.TEMP ?? "/tmp", `ci-recover-${Date.now()}.json`);

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

// 1. gh starts "not authenticated" (simulates the transient at pi load)
process.env.GH_SHIM_AUTH_FAIL = "1";
check("initial probe fails", (await ensureGh()) === false);

// 2. cached verdict is served without re-probing (cheap path used by refreshStatus)
check("cached failure served", (await ensureGh()) === false);

// 3. gh becomes available again — the tool's on-demand forced re-probe recovers
delete process.env.GH_SHIM_AUTH_FAIL;
check("forced re-probe recovers", (await ensureGh(true)) === true);

// 4. fresh verdict now cached as healthy
check("healthy verdict cached", (await ensureGh()) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
