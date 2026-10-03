import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testFile = (name) => join(packageRoot, "tests", name);

// Each file runs in its own process so module state and env stay isolated.
// verify-gate.test.ts needs VERIFY_GATE_TTL_MS=0 so its tree gate, not the TTL,
// is what the re-run cases exercise.
const cases = [
  ["verify-gate.test.ts", { VERIFY_GATE_TTL_MS: "0" }],
  ["registration.test.ts", {}],
];

for (const [file, env] of cases) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", testFile(file)], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
