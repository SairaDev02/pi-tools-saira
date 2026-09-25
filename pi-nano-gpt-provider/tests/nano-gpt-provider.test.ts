/**
 * Functional tests for pi-nano-gpt-provider.
 * Run: node --experimental-strip-types tests/nano-gpt-provider.test.ts
 *
 * Covers detailed-catalog mapping (capabilities, context/output limits, at-cost
 * pricing including per-1k cache rates), snapshot persistence and restore,
 * catalog sort selection, and every refresh failure path — all against a
 * stubbed fetch, no pi runtime needed.
 */

import nanoGptProvider, {
	buildModelsUrl,
	mapNanoGptModel,
	modelsFromStored,
	requestedSort,
} from "../src/nano-gpt-provider.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name} ${extra}`);
	}
}

// --- 1. sort selection -------------------------------------------------------
console.log("\n== sort selection ==");

{
	check("unspecified -> favorites", requestedSort("favorites") === "favorites");
	check("mostused (case/space insensitive)", requestedSort("  MOSTUSED ") === "mostused");
	check("none -> none", requestedSort("none") === "none");
	check("off -> none", requestedSort("off") === "none");
	check("empty -> none", requestedSort("") === "none");
	check("unknown -> favorites default", requestedSort("sometimes") === "favorites");

	const fav = new URL(buildModelsUrl("favorites"));
	check("URL uses canonical host", fav.origin === "https://api.nano-gpt.com");
	check("URL path", fav.pathname === "/api/v1/models");
	check("URL requests detailed", fav.searchParams.get("detailed") === "true");
	check("URL requests favorites", fav.searchParams.get("sort") === "favorites");

	const none = new URL(buildModelsUrl("none"));
	check("no sort param when disabled", !none.searchParams.has("sort"));

	const oldEnv = process.env.NANOGPT_MODEL_SORT;
	process.env.NANOGPT_MODEL_SORT = "mostused";
	check("env override mostused", new URL(buildModelsUrl()).searchParams.get("sort") === "mostused");
	process.env.NANOGPT_MODEL_SORT = "none";
	check("env override none drops sort", !new URL(buildModelsUrl()).searchParams.has("sort"));
	if (oldEnv === undefined) delete process.env.NANOGPT_MODEL_SORT;
	else process.env.NANOGPT_MODEL_SORT = oldEnv;
}

// --- 2. detailed record mapping ---------------------------------------------
console.log("\n== detailed record mapping ==");

{
	const mapped = mapNanoGptModel({
		id: "anthropic/claude-sonnet-5",
		name: "Claude Sonnet 5",
		context_length: 1_000_000,
		max_output_tokens: 128_000,
		architecture: { input_modalities: ["text", "image"] },
		capabilities: { vision: true, reasoning: false },
		pricing: {
			prompt: 2,
			completion: 10,
			cacheReadInputPer1kTokens: 0.0002,
			cacheWriteInputPer1kTokens: 0.0025,
			unit: "per_million_tokens",
		},
	});
	check("id + name", mapped?.id === "anthropic/claude-sonnet-5" && mapped.name === "Claude Sonnet 5");
	check("context window from catalog", mapped?.contextWindow === 1_000_000);
	check("max output from catalog", mapped?.maxTokens === 128_000);
	check("vision -> image input", JSON.stringify(mapped?.input) === '["text","image"]');
	check("reasoning flag false", mapped?.reasoning === false);
	check("input price per million", mapped?.cost.input === 2);
	check("output price per million", mapped?.cost.output === 10);
	check("cache read per-1k scaled to per-million", mapped?.cost.cacheRead === 0.2);
	check("cache write per-1k scaled to per-million", mapped?.cost.cacheWrite === 2.5);
}

{
	const mapped = mapNanoGptModel({
		id: "z-ai/glm-5.3:thinking",
		context_length: null,
		max_output_tokens: null,
		architecture: { input_modalities: ["text", "video", "audio"] },
		capabilities: {},
		pricing: { prompt: 0.5, completion: 1.5 },
	});
	check("thinking suffix -> reasoning", mapped?.reasoning === true);
	check("non-image modalities filtered", JSON.stringify(mapped?.input) === '["text"]');
	check("missing context -> default 128k", mapped?.contextWindow === 128_000);
	check("missing max output -> default 8192", mapped?.maxTokens === 8192);
	check("absent cache rates fall back to input", mapped?.cost.cacheRead === 0.5 && mapped?.cost.cacheWrite === 0.5);
	check("name falls back to id", mapped?.name === "z-ai/glm-5.3:thinking");
}

{
	const mapped = mapNanoGptModel({
		id: "vision/fallback",
		architecture: null,
		capabilities: { vision: true, reasoning: true },
		pricing: { prompt: 1, completion: 2, unit: "per_1k_tokens" },
	});
	check("vision flag falls back when architecture missing", JSON.stringify(mapped?.input) === '["text","image"]');
	check("reasoning capability flag honoured", mapped?.reasoning === true);
	check("per-1k pricing unit scaled", mapped?.cost.input === 1000 && mapped?.cost.output === 2000);
}

{
	const mapped = mapNanoGptModel({ id: "clamped/model", context_length: 32_768, max_output_tokens: 65_536, pricing: null });
	check("max output clamped to context", mapped?.maxTokens === 32_768);
	check("missing pricing -> zero cost", mapped?.cost.input === 0 && mapped?.cost.output === 0 && mapped?.cost.cacheRead === 0);
	check("missing id rejected", mapNanoGptModel({ name: "ghost" }) === undefined);
	check("empty id rejected", mapNanoGptModel({ id: "" }) === undefined);
}

// --- 3. persisted snapshot restore ------------------------------------------
console.log("\n== snapshot restore ==");

{
	const restored = modelsFromStored([
		{
			id: "anthropic/claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			// Stored metadata must never leak into the live config.
			provider: "nano-gpt",
			api: "openai-completions",
			baseUrl: "https://old.example/api/v1",
		},
		{ id: "", name: "broken" },
		{ id: "minimal/model", cost: null },
	]);
	check("invalid stored ids skipped", restored.length === 2);
	check("stored fields preserved", restored[0].id === "anthropic/claude-sonnet-5" && restored[0].contextWindow === 1_000_000);
	check("stored metadata stripped", !("baseUrl" in restored[0]) && !("provider" in restored[0]) && !("api" in restored[0]));
	check("stored input preserved", JSON.stringify(restored[0].input) === '["text","image"]');
	check("minimal stored entry gets defaults", restored[1].contextWindow === 128_000 && restored[1].maxTokens === 8192);
	check("undefined stored -> empty", modelsFromStored(undefined).length === 0);
}

// --- 4. refresh behavior -----------------------------------------------------
console.log("\n== refresh behavior ==");

const BASE = "https://api.nano-gpt.com/api/v1";

const CATALOG = {
	object: "list",
	data: [
		{
			id: "openai/gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			context_length: 128_000,
			max_output_tokens: 16_384,
			architecture: { input_modalities: ["text", "image"] },
			capabilities: { reasoning: true, vision: true, tool_calling: true },
			pricing: {
				prompt: 2.5,
				completion: 10,
				cacheReadInputPer1kTokens: 0.00025,
				unit: "per_million_tokens",
			},
		},
		{
			id: "meta/llama-3.3-70b",
			name: "Llama 3.3 70B",
			context_length: 128_000,
			max_output_tokens: null,
			architecture: { input_modalities: ["text"] },
			capabilities: { reasoning: false, vision: false },
			pricing: { prompt: 0.1, completion: 0.2, unit: "per_million_tokens" },
		},
	],
};

let fetchCalls: Array<{ url: string; init: any }> = [];
function stubFetch(handler: (url: string, init: any) => any) {
	const original = globalThis.fetch;
	fetchCalls = [];
	globalThis.fetch = (async (input: any, init: any) => {
		fetchCalls.push({ url: String(input), init });
		return handler(String(input), init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

function jsonResponse(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function makeContext(overrides: Record<string, unknown> = {}) {
	return {
		allowNetwork: true,
		force: false,
		signal: new AbortController().signal,
		stored: undefined,
		publish: async () => true,
		...overrides,
	} as any;
}

function registerProvider() {
	let config: any;
	const pi = {
		registerProvider: (_name: string, providerConfig: any) => {
			config = providerConfig;
		},
	};
	nanoGptProvider(pi as any);
	return config;
}

const config = registerProvider();
check(
	"provider registration uses canonical host",
	config.name === "nanoGPT" &&
		config.baseUrl === BASE &&
		config.api === "openai-completions" &&
		config.apiKey === "$NANOGPT_API_KEY",
);

// Offline init restores the persisted snapshot (and strips stale metadata).
{
	const stored = {
		models: [
			{
				id: "anthropic/claude-sonnet-5",
				name: "Claude Sonnet 5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				provider: "nano-gpt",
				api: "openai-completions",
				baseUrl: "https://old.example/api/v1",
			},
		],
		checkedAt: Date.now(),
	};
	const restored = await config.refreshModels(makeContext({ allowNetwork: false, stored }));
	check("offline restores stored snapshot", restored.length === 1 && restored[0].id === "anthropic/claude-sonnet-5");
	check("offline strips stored metadata", restored[0].baseUrl === undefined);
}

// Successful detailed fetch: URL, auth, signal, mapping, persistence.
let successModels: any[] = [];
{
	const published: any[] = [];
	const ctx = makeContext({
		credential: { type: "api_key", key: "sk-stored" },
		publish: async (publication: any) => {
			published.push(publication);
			return true;
		},
	});
	const restoreFetch = stubFetch(() => jsonResponse(CATALOG));
	try {
		successModels = await config.refreshModels(ctx);
	} finally {
		restoreFetch();
	}

	const call = fetchCalls[0] ?? { url: "", init: undefined };
	check("fetches detailed catalog", call.url === `${BASE}/models?detailed=true&sort=favorites`);
	check("uses stored credential key", call.init?.headers?.Authorization === "Bearer sk-stored");
	check("forwards abort signal", call.init?.signal === ctx.signal);
	check("maps every record", successModels.length === 2);
	check("vision capability mapped", JSON.stringify(successModels[0].input) === '["text","image"]');
	check("reasoning capability mapped", successModels[0].reasoning === true);
	check("null max output defaulted", successModels[1].maxTokens === 8192);
	check("publish persisted snapshot", published.length === 1 && published[0].persist.models.length === 2);
	check("publish records checkedAt", typeof published[0].persist.checkedAt === "number");
	check(
		"persisted models carry store metadata",
		published[0].persist.models[0].provider === "nano-gpt" &&
			published[0].persist.models[0].api === "openai-completions" &&
			published[0].persist.models[0].baseUrl === BASE,
	);
	check("no stale metadata on returned models", successModels[0].provider === undefined && successModels[0].baseUrl === undefined);
}

// Failure paths never wipe the catalog.
{
	const restoreFetch = stubFetch(() => jsonResponse({ error: "rate_limited" }, 429));
	try {
		const models = await config.refreshModels(makeContext({ force: true, credential: { type: "api_key", key: "sk-stored" } }));
		check("non-OK keeps last known", models.length === 2 && models[0].id === "openai/gpt-5.6-sol");
	} finally {
		restoreFetch();
	}

	const restoreThrow = stubFetch(() => {
		throw new Error("network down");
	});
	try {
		const models = await config.refreshModels(makeContext({ force: true, credential: { type: "api_key", key: "sk-stored" } }));
		check("network error keeps last known", models.length === 2);
	} finally {
		restoreThrow();
	}

	const restoreMalformed = stubFetch(() => jsonResponse({ object: "list" }));
	try {
		const models = await config.refreshModels(makeContext({ force: true, credential: { type: "api_key", key: "sk-stored" } }));
		check("non-array payload keeps last known", models.length === 2);
	} finally {
		restoreMalformed();
	}

	const restoreEmpty = stubFetch(() => jsonResponse({ object: "list", data: [] }));
	try {
		const models = await config.refreshModels(makeContext({ force: true, credential: { type: "api_key", key: "sk-stored" } }));
		check("empty catalog keeps last known", models.length === 2);
	} finally {
		restoreEmpty();
	}
}

// Fresh snapshot is reused; force bypasses the TTL.
{
	const stored = { models: successModels, checkedAt: Date.now() };
	const restoreFetch = stubFetch(() => {
		throw new Error("should not fetch");
	});
	try {
		const models = await config.refreshModels(
			makeContext({ force: false, stored, credential: { type: "api_key", key: "sk-stored" } }),
		);
		check("fresh snapshot served without network", fetchCalls.length === 0 && models.length === 2);
	} finally {
		restoreFetch();
	}

	const restoreForced = stubFetch(() => jsonResponse(CATALOG));
	try {
		await config.refreshModels(makeContext({ force: true, stored, credential: { type: "api_key", key: "sk-stored" } }));
		check("force bypasses TTL", fetchCalls.length === 1);
	} finally {
		restoreForced();
	}
}

// Env fallback for the key and the sort override.
{
	const oldKey = process.env.NANOGPT_API_KEY;
	const oldSort = process.env.NANOGPT_MODEL_SORT;
	process.env.NANOGPT_API_KEY = "sk-env";
	process.env.NANOGPT_MODEL_SORT = "mostused";
	const restoreFetch = stubFetch(() => jsonResponse(CATALOG));
	try {
		await config.refreshModels(makeContext({ force: true }));
		check("env key used when no credential", fetchCalls[0]?.init?.headers?.Authorization === "Bearer sk-env");
		check("env sort override used in URL", fetchCalls[0]?.url.endsWith("detailed=true&sort=mostused"));
	} finally {
		restoreFetch();
		if (oldKey === undefined) delete process.env.NANOGPT_API_KEY;
		else process.env.NANOGPT_API_KEY = oldKey;
		if (oldSort === undefined) delete process.env.NANOGPT_MODEL_SORT;
		else process.env.NANOGPT_MODEL_SORT = oldSort;
	}

	delete process.env.NANOGPT_API_KEY;
	const restoreNoKey = stubFetch(() => jsonResponse(CATALOG));
	try {
		await config.refreshModels(makeContext({ force: true }));
		check("no key sends no auth header", fetchCalls[0]?.init?.headers?.Authorization === undefined);
	} finally {
		restoreNoKey();
	}
}

// -----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
