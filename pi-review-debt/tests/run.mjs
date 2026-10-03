/**
 * Test runner: runs each test file in its own Node process so module state and
 * env stay isolated, and fails the run if any file fails.
 *
 * Run: npm test
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ["review-debt.test.ts", "registration.test.ts"];

for (const file of files) {
	console.log(`\n### ${file}`);
	const result = spawnSync(process.execPath, ["--experimental-strip-types", path.join(dir, file)], {
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}
