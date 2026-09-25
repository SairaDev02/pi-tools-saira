import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testFile = (name) => join(packageRoot, "tests", name);
const ghShim = testFile("gh-shim.mjs");
const missingGh = testFile("missing-gh-shim.mjs");

const cases = [
  ["ci-status.test.ts", { CI_STATUS_TTL_MS: "1", CI_STATUS_GH_BIN: ghShim }],
  ["ci-status.ghfail.test.ts", { CI_STATUS_GH_BIN: missingGh }],
  ["ci-status.ghfail.test.ts", { CI_STATUS_GH_BIN: ghShim, GH_SHIM_AUTH_FAIL: "1" }],
  ["recover.test.ts", { CI_STATUS_GH_BIN: ghShim }],
];

for (const [file, env] of cases) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", testFile(file)],
    {
      cwd: packageRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
