/**
 * Wiring smoke test for the extension factory.
 *
 * The behavior tests drive the exported logic (refreshStatus, deriveSnapshot,
 * the gh gate), but never call the default export. That factory is the surface
 * a host API change hits first, so this run registers it against a stub
 * ExtensionAPI and asserts exactly what the extension claims to add: the
 * ci_status tool, the /ci command, and the four lifecycle handlers.
 *
 * Run: CI_STATUS_GH_BIN=<shim> node --experimental-strip-types tests/registration.test.ts
 */
import ciStatusExtension from "../src/ci-status.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "gh-shim.mjs");
process.env.CI_STATUS_GH_BIN = shim;
process.env.CI_STATUS_BADGE_FILE = path.join(
  process.env.TEMP ?? "/tmp",
  `ci-badge-registration-${Date.now()}.json`,
);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
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
  registerMcpServer: () => {},
  registerVirtualModel: () => {},
  registerMessageRenderer: () => {},
  registerEntryRenderer: () => {},
  registerMarkdownTransformer: () => {},
};

ciStatusExtension(api);

// --- tool ------------------------------------------------------------------
check("factory is a function", typeof ciStatusExtension === "function");
check("registers exactly one tool", tools.length === 1, String(tools.length));
check("tool is ci_status", tools[0]?.name === "ci_status");
check("tool has a parameter schema", typeof tools[0]?.parameters === "object" && tools[0]?.parameters !== null);
check(
  "tool has prompt guidelines",
  Array.isArray(tools[0]?.promptGuidelines) && tools[0].promptGuidelines.length > 0,
);
check("tool execute is a function", typeof tools[0]?.execute === "function");

// --- command ---------------------------------------------------------------
check("registers exactly one command", commands.length === 1, String(commands.length));
check("command is ci", commands[0]?.name === "ci");
check("command has a handler", typeof commands[0]?.options?.handler === "function");
check(
  "command has argument completions",
  typeof commands[0]?.options?.getArgumentCompletions === "function",
);

// --- event handlers --------------------------------------------------------
const eventNames = events.map((e) => e.event);
check("registers exactly four handlers", events.length === 4, String(events.length));
for (const name of ["session_start", "agent_end", "before_agent_start", "session_shutdown"]) {
  check(`handles ${name}`, eventNames.includes(name));
}

// before_agent_start is pure until a transition is queued: with nothing
// pending it must return undefined and leave the prompt untouched.
const beforeStart = events.find((e) => e.event === "before_agent_start").handler;
const result = await beforeStart(
  { type: "before_agent_start", prompt: "hi", systemPrompt: "SYS", systemPromptOptions: {} },
  {},
);
check("before_agent_start no-ops with no pending delta", result === undefined);

// --- command completions ---------------------------------------------------
const completions = commands[0].options.getArgumentCompletions;
const badgeAll = await completions("badge ");
check("badge completions list four modes", Array.isArray(badgeAll) && badgeAll.length === 4);
const badgePartial = await completions("badge act");
check(
  "badge completions filter by prefix",
  Array.isArray(badgePartial) &&
    badgePartial.length === 1 &&
    badgePartial[0].value === "badge activity",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
