/**
 * Wiring smoke test for the extension factory.
 *
 * The behavior tests drive the exported pure logic; this run calls the default
 * export against a stub ExtensionAPI and asserts exactly what the extension
 * claims to add: the /deepseek-hours command and the four lifecycle handlers.
 * It is the surface a host API change hits first.
 *
 * Run: node --experimental-strip-types tests/registration.test.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The extension resolves its state file at module load, so point it at a temp
// path before the dynamic import below evaluates the module.
const stateFile = path.join(os.tmpdir(), `deepseek-hours-registration-${Date.now()}.json`);
process.env.DEEPSEEK_HOURS_STATE = stateFile;

const { default: deepseekHoursExtension } = await import("../src/deepseek-hours.ts");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name} ${extra}`);
	}
};

const commands: Array<{ name: string; options: Record<string, unknown> }> = [];
const events: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
const api = {
	on: (event: string, handler: (...args: unknown[]) => unknown) => {
		events.push({ event, handler });
		return () => {};
	},
	registerCommand: (name: string, options: Record<string, unknown>) => commands.push({ name, options }),
	registerTool: () => {},
	registerShortcut: () => {},
	registerFlag: () => {},
	registerProvider: () => {},
	registerMcpServer: () => {},
	registerVirtualModel: () => {},
	registerMessageRenderer: () => {},
	registerEntryRenderer: () => {},
	registerMarkdownTransformer: () => {},
};

deepseekHoursExtension(api as never);

// --- command ---------------------------------------------------------------
check("factory is a function", typeof deepseekHoursExtension === "function");
check("registers exactly one command", commands.length === 1, String(commands.length));
check("command is deepseek-hours", commands[0]?.name === "deepseek-hours");
check("command has a handler", typeof commands[0]?.options?.handler === "function");
check("command has a description", typeof commands[0]?.options?.description === "string");
check(
	"command has argument completions",
	typeof commands[0]?.options?.getArgumentCompletions === "function",
);

// --- event handlers --------------------------------------------------------
const eventNames = events.map((e) => e.event);
check("registers exactly four handlers", events.length === 4, String(events.length));
for (const name of ["session_start", "model_select", "agent_end", "session_shutdown"]) {
	check(`handles ${name}`, eventNames.includes(name));
}

// --- command completions ---------------------------------------------------
const completions = commands[0].options.getArgumentCompletions as (
	prefix: string,
) => Promise<Array<{ value: string }> | null>;
const top = await completions("b");
check(
	"top-level completions filter by prefix",
	Array.isArray(top) && top.length === 1 && top[0].value === "badge",
	JSON.stringify(top),
);
const full = await completions("full");
check(
	"full is still offered (deprecated alias)",
	Array.isArray(full) && full.some((c) => c.value === "full"),
	JSON.stringify(full),
);
const modeAll = await completions("mode ");
check("mode completions list four sub-modes", Array.isArray(modeAll) && modeAll.length === 4, JSON.stringify(modeAll));
const modePartial = await completions("mode ba");
check(
	"mode completions filter by prefix",
	Array.isArray(modePartial) && modePartial.length === 1 && modePartial[0].value === "mode badge",
	JSON.stringify(modePartial),
);

// --- deprecated `full` command path ----------------------------------------
const statuses: Array<[string, string | undefined]> = [];
const notices: Array<[string, string | undefined]> = [];
const ctx = {
	hasUI: true,
	model: { provider: "deepseek", id: "deepseek-chat" },
	ui: {
		setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
		notify: (message: string, type: string | undefined) => notices.push([message, type]),
		theme: { fg: (_color: string, text: string) => text },
	},
};
const handler = commands[0].options.handler as (args: string, ctx: unknown) => Promise<void>;
await handler("mode full", ctx);
check(
	"`mode full` warns that full is deprecated",
	notices.some(([m]) => m.includes("deprecated")),
	JSON.stringify(notices),
);
check(
	"`mode full` still renders the badge",
	statuses.some(([key, text]) => key === "deepseek-hours" && typeof text === "string" && text.includes("DSK")),
	JSON.stringify(statuses),
);

// The bare `/deepseek-hours full` argument must share the deprecation notice.
// Turn the indicator off first so the badge-text dedup does not swallow the setStatus.
await handler("off", ctx);
notices.length = 0;
statuses.length = 0;
await handler("full", ctx);
check(
	"bare `full` also warns that it is deprecated",
	notices.some(([m]) => m.includes("deprecated")),
	JSON.stringify(notices),
);
check(
	"bare `full` still renders the badge",
	statuses.some(([key, text]) => key === "deepseek-hours" && typeof text === "string" && text.includes("DSK")),
	JSON.stringify(statuses),
);

// `/deepseek-hours mode` must report the effective mode, not the deprecated value.
notices.length = 0;
await handler("mode", ctx);
check(
	"`mode` reports full as deprecated",
	notices.some(([m]) => m.includes("badge (full deprecated)")),
	JSON.stringify(notices),
);

// --- persisted `full` from an earlier version ------------------------------
await fs.writeFile(stateFile, JSON.stringify({ mode: "full" }), "utf8");
const events2: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
const api2 = {
	on: (event: string, handler: (...args: unknown[]) => unknown) => {
		events2.push({ event, handler });
		return () => {};
	},
	registerCommand: () => {},
};
deepseekHoursExtension(api2 as never);
statuses.length = 0;
const start = events2.find((e) => e.event === "session_start")?.handler as (
	event: unknown,
	ctx: unknown,
) => void;
start({}, ctx);
check(
	"persisted `full` renders the badge on session_start",
	statuses.some(([key, text]) => key === "deepseek-hours" && typeof text === "string" && text.includes("DSK")),
	JSON.stringify(statuses),
);

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(stateFile, { force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
