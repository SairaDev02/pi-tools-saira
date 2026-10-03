/**
 * Wiring smoke test for the extension factory.
 *
 * The behavior suite drives the exported logic with a fake check shim, but its
 * extension-wiring section only asserts tool/command names and badge effects.
 * This run registers the factory against a stub ExtensionAPI and asserts the
 * full surface a host API change hits first: the verify_status tool, the
 * /verify command, and exactly the four lifecycle handlers.
 *
 * Run: node --experimental-strip-types tests/registration.test.ts
 */
import verifyGateExtension from "../src/verify-gate.ts";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const tools = [];
const commands = [];
const events = [];
const api = {
  on: (event, handler) => {
    events.push({ event, handler });
    return () => {};
  },
  registerTool: (tool) => tools.push(tool),
  registerCommand: (name, options) => commands.push({ name, options }),
  registerShortcut: () => {},
  registerFlag: () => {},
  registerProvider: () => {},
};

verifyGateExtension(api);

// --- tool ------------------------------------------------------------------
check("factory is a function", typeof verifyGateExtension === "function");
check("registers exactly one tool", tools.length === 1, String(tools.length));
check("tool is verify_status", tools[0]?.name === "verify_status");
check(
  "tool has a parameter schema",
  typeof tools[0]?.parameters === "object" && tools[0].parameters !== null,
);
check(
  "tool has prompt guidelines",
  Array.isArray(tools[0]?.promptGuidelines) && tools[0].promptGuidelines.length > 0,
);
check("tool execute is a function", typeof tools[0]?.execute === "function");

// --- command ---------------------------------------------------------------
check("registers exactly one command", commands.length === 1, String(commands.length));
check("command is verify", commands[0]?.name === "verify");
check("command has a handler", typeof commands[0]?.options?.handler === "function");
check(
  "command has argument completions",
  typeof commands[0]?.options?.getArgumentCompletions === "function",
);

// --- event handlers --------------------------------------------------------
const eventNames = events.map((entry) => entry.event);
check("registers exactly four handlers", events.length === 4, String(events.length));
for (const name of ["session_start", "agent_settled", "before_agent_start", "session_shutdown"]) {
  check(`handles ${name}`, eventNames.includes(name));
}

// before_agent_start is transient: with no transition it must return undefined
// and leave the prompt untouched.
const beforeStart = events.find((entry) => entry.event === "before_agent_start").handler;
const result = await beforeStart(
  { type: "before_agent_start", prompt: "hi", systemPrompt: "SYS", systemPromptOptions: {} },
  {},
);
check("before_agent_start no-ops with no pending delta", result === undefined);

// --- command completions ---------------------------------------------------
const completions = commands[0].options.getArgumentCompletions;
const all = await completions("");
check(
  "empty prefix lists four subcommands",
  Array.isArray(all) && all.length === 4,
  String(all?.length),
);
const run = await completions("ru");
check(
  "prefix filters to run",
  Array.isArray(run) && run.length === 1 && run[0].value === "run",
);
const badge = await completions("badge ");
check(
  "badge prefix lists four modes",
  Array.isArray(badge) && badge.length === 4,
  String(badge?.length),
);
const unknown = await completions("zzz");
check("unknown prefix returns null", unknown === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
