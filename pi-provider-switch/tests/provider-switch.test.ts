import assert from "node:assert/strict";
import registerProviderSwitch from "../src/provider-switch.ts";

const commands = new Map<string, Record<string, unknown>>();
registerProviderSwitch({
  registerCommand(name: string, options: Record<string, unknown>) {
    commands.set(name, options);
  },
} as never);

assert.deepEqual([...commands.keys()], ["provider", "switch-provider", "models"]);
assert.equal(
  commands.get("provider")?.handler,
  commands.get("switch-provider")?.handler,
  "/switch-provider shares the /provider handler",
);
assert.equal(typeof commands.get("models")?.handler, "function");

console.log("3 passed, 0 failed");
