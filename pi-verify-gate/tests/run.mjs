import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testFile = join(packageRoot, "tests", "verify-gate.test.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", testFile], {
  cwd: packageRoot,
  env: { ...process.env, VERIFY_GATE_TTL_MS: "0" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
