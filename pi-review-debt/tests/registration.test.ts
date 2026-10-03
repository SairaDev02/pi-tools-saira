/**
 * Wiring smoke test for the extension factory.
 *
 * The behavior suite drives the exported logic on a real temp git repo, but
 * never calls the default export. That factory is the surface a host API
 * change hits first, so this run registers it against a stub ExtensionAPI and
 * asserts exactly what the extension claims to add: the record_finding and
 * list_findings tools, the /debt command, and the two lifecycle handlers.
 *
 * Run: node --experimental-strip-types tests/registration.test.ts
 */
import reviewDebtExtension from "../src/review-debt.ts";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

// Keep the wiring run off the real state file and start from empty debt.
process.env.REVIEW_DEBT_STATE = path.join(
	await fs.mkdtemp(path.join(os.tmpdir(), "rd-registration-")),
	"state.json",
);

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

reviewDebtExtension(api);

// --- tools -----------------------------------------------------------------
check("factory is a function", typeof reviewDebtExtension === "function");
check("registers exactly two tools", tools.length === 2, String(tools.length));
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
check("records record_finding", byName.record_finding !== undefined);
check("records list_findings", byName.list_findings !== undefined);
for (const name of ["record_finding", "list_findings"]) {
	const tool = byName[name];
	check(
		`${name} has a parameter schema`,
		typeof tool?.parameters === "object" && tool.parameters !== null,
	);
	check(
		`${name} has prompt guidelines`,
		Array.isArray(tool?.promptGuidelines) && tool.promptGuidelines.length > 0,
	);
	check(`${name} execute is a function`, typeof tool?.execute === "function");
}
check(
	"record_finding requires a title",
	Array.isArray(byName.record_finding?.parameters?.required) &&
		byName.record_finding.parameters.required.includes("title"),
);

// --- command ---------------------------------------------------------------
check("registers exactly one command", commands.length === 1, String(commands.length));
check("command is debt", commands[0]?.name === "debt");
check("command has a handler", typeof commands[0]?.options?.handler === "function");
check(
	"command has argument completions",
	typeof commands[0]?.options?.getArgumentCompletions === "function",
);

// --- event handlers --------------------------------------------------------
const eventNames = events.map((entry) => entry.event);
check("registers exactly two handlers", events.length === 2, String(events.length));
check("handles before_agent_start", eventNames.includes("before_agent_start"));
check("handles agent_settled", eventNames.includes("agent_settled"));

// before_agent_start is transient: with no debt it must return undefined and
// leave the prompt untouched.
const beforeStart = events.find((entry) => entry.event === "before_agent_start").handler;
const result = await beforeStart(
	{ type: "before_agent_start", prompt: "hi", systemPrompt: "SYS", systemPromptOptions: {} },
	{},
);
check("before_agent_start no-ops with no debt", result === undefined);

// --- command completions ---------------------------------------------------
const completions = commands[0].options.getArgumentCompletions;
const all = await completions("");
check(
	"empty prefix lists six subcommands",
	Array.isArray(all) && all.length === 6,
	String(all?.length),
);
const partial = await completions("res");
check(
	"prefix filters to resolve",
	Array.isArray(partial) && partial.length === 1 && partial[0].value === "resolve",
);
const unknown = await completions("zzz");
check("unknown prefix returns null", unknown === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
