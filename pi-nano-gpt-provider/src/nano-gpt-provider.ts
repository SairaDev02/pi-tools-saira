import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * nanoGPT custom provider for pi.
 *
 * - Endpoint: OpenAI-compatible at https://api.nano-gpt.com/api/v1 — the
 *   canonical API host from the nanoGPT docs (nano-gpt.com serves the web app;
 *   key-based integrations use the `api.` subdomain).
 * - Auth: pi resolves the credential itself — an api key stored in
 *   `~/.pi/agent/auth.json` under provider id "nano-gpt" (via `/login nano-gpt`)
 *   takes priority; `NANOGPT_API_KEY` env var is the fallback (`$NANOGPT_API_KEY`
 *   interpolation below is pi's own resolution, no manual shim needed).
 * - Models: discovered lazily via `refreshModels` — never blocks startup, honors
 *   the shared abort signal, and skips network entirely on offline init.
 *
 * Catalog discovery uses `GET /api/v1/models?detailed=true`. The detailed shape
 * carries real per-model metadata (context window, output cap, vision/reasoning
 * capabilities, at-cost USD pricing), so this extension keeps no hardcoded
 * per-model tables. Successful snapshots are persisted through pi's models
 * store and restored offline; a failed refresh keeps the last-known list.
 */

/** Canonical API host for key-based integrations (nanoGPT docs: API Hosts). */
const BASE_URL = "https://api.nano-gpt.com/api/v1";

/**
 * Catalog snapshot lifetime. The models endpoint serves
 * `cache-control: s-maxage=300`, so a five-minute-old snapshot is reused unless
 * the refresh is forced (`context.force`).
 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** Fallback when the detailed record omits `context_length` (4 of ~600 models). */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Fallback when the detailed record omits `max_output_tokens`. */
const DEFAULT_MAX_TOKENS = 8192;

/** Supported `sort` values from the models endpoint documentation, plus `none`. */
type ModelSort = "favorites" | "mostused" | "none";

/**
 * `NANOGPT_MODEL_SORT` selects the catalog ordering:
 *
 * - `favorites` (default) — the account's recently used models first. Requires a
 *   valid API key; the API falls back to normal ordering otherwise.
 * - `mostused` — globally most-used models first (no auth required).
 * - `none` / `off` — leave the API's default catalog order.
 */
export function requestedSort(env: string | undefined = process.env.NANOGPT_MODEL_SORT): ModelSort {
	const value = env?.trim().toLowerCase();
	if (value === "none" || value === "off" || value === "") return "none";
	if (value === "mostused") return "mostused";
	return "favorites";
}

/** Build the detailed models URL, including the requested ordering. */
export function buildModelsUrl(sort: ModelSort = requestedSort()): string {
	const url = new URL(`${BASE_URL}/models`);
	url.searchParams.set("detailed", "true");
	if (sort !== "none") url.searchParams.set("sort", sort);
	return url.toString();
}

/** One raw record from `GET /api/v1/models?detailed=true` (fields validated at read time). */
export interface NanoGptRawModel {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
	max_output_tokens?: unknown;
	capabilities?: { reasoning?: unknown; vision?: unknown } | null;
	architecture?: { input_modalities?: unknown } | null;
	pricing?: {
		prompt?: unknown;
		completion?: unknown;
		cacheReadInputPer1kTokens?: unknown;
		cacheWriteInputPer1kTokens?: unknown;
		unit?: unknown;
	} | null;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	const n = finiteNumber(value);
	return n !== undefined && n > 0 ? n : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	const n = finiteNumber(value);
	return n !== undefined && n >= 0 ? n : undefined;
}

/** Convert a price to per-million-token units (documented default unit). */
function perMillionTokens(value: unknown, unit: unknown): number | undefined {
	const n = finiteNumber(value);
	if (n === undefined) return undefined;
	const normalized = typeof unit === "string" ? unit.toLowerCase() : "";
	return normalized.includes("per_1k") ? n * 1000 : n;
}

/** Convert a per-1k-token rate to per-million-token units. */
function perThousandTokens(value: unknown): number | undefined {
	const n = finiteNumber(value);
	return n === undefined ? undefined : n * 1000;
}

export function clampMaxTokens(maxTokens: number, contextWindow: number): number {
	return Number.isFinite(contextWindow) && maxTokens > contextWindow ? contextWindow : maxTokens;
}

/**
 * Prefer the catalog's declared input modalities; fall back to the `vision`
 * capability flag when `architecture` is absent (docs: catalog fields are
 * additive).
 */
function inputModalities(raw: NanoGptRawModel): ("text" | "image")[] {
	const declared = raw.architecture?.input_modalities;
	if (Array.isArray(declared)) {
		const input = declared.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image");
		if (input.length > 0) return input;
	}
	return raw.capabilities?.vision === true ? ["text", "image"] : ["text"];
}

/**
 * Map one detailed catalog record to pi's model metadata.
 *
 * `capabilities.reasoning` is the authoritative flag; the `:thinking` id suffix
 * is also treated as reasoning because a few variant ids ship without the flag.
 */
export function mapNanoGptModel(raw: NanoGptRawModel): ProviderModelConfig | undefined {
	if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;

	const pricing = raw.pricing ?? {};
	const input = nonNegativeNumber(perMillionTokens(pricing.prompt, pricing.unit)) ?? 0;
	const output = nonNegativeNumber(perMillionTokens(pricing.completion, pricing.unit)) ?? 0;
	const contextWindow = positiveNumber(raw.context_length) ?? DEFAULT_CONTEXT_WINDOW;

	return {
		id: raw.id,
		name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id,
		reasoning: raw.capabilities?.reasoning === true || raw.id.toLowerCase().endsWith(":thinking"),
		input: inputModalities(raw),
		// Unknown cache rates fall back to the input rate: over-reporting spend is
		// less harmful than silently under-reporting it.
		cost: {
			input,
			output,
			cacheRead: nonNegativeNumber(perThousandTokens(pricing.cacheReadInputPer1kTokens)) ?? input,
			cacheWrite: nonNegativeNumber(perThousandTokens(pricing.cacheWriteInputPer1kTokens)) ?? input,
		},
		contextWindow,
		maxTokens: clampMaxTokens(positiveNumber(raw.max_output_tokens) ?? DEFAULT_MAX_TOKENS, contextWindow),
	};
}

/** Structural subset of pi's `Model` that a persisted snapshot round-trips. */
export interface StoredModelLike {
	id?: unknown;
	name?: unknown;
	reasoning?: unknown;
	input?: unknown;
	cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | null;
	contextWindow?: unknown;
	maxTokens?: unknown;
}

function storedInput(value: unknown): ("text" | "image")[] {
	if (Array.isArray(value)) {
		const input = value.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image");
		if (input.length > 0) return input;
	}
	return ["text"];
}

/**
 * Restore provider configs from a persisted snapshot. Only the fields pi needs
 * from an extension model are kept, so stored `api`/`baseUrl` values can never
 * override a future host change.
 */
export function modelsFromStored(models: readonly StoredModelLike[] | undefined): ProviderModelConfig[] {
	if (!models) return [];
	const restored: ProviderModelConfig[] = [];
	for (const model of models) {
		if (typeof model.id !== "string" || model.id.length === 0) continue;
		const rates = model.cost ?? {};
		const input = nonNegativeNumber(rates.input) ?? 0;
		const contextWindow = positiveNumber(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
		restored.push({
			id: model.id,
			name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
			reasoning: model.reasoning === true,
			input: storedInput(model.input),
			cost: {
				input,
				output: nonNegativeNumber(rates.output) ?? 0,
				cacheRead: nonNegativeNumber(rates.cacheRead) ?? input,
				cacheWrite: nonNegativeNumber(rates.cacheWrite) ?? input,
			},
			contextWindow,
			maxTokens: clampMaxTokens(positiveNumber(model.maxTokens) ?? DEFAULT_MAX_TOKENS, contextWindow),
		});
	}
	return restored;
}

/** A persisted model carries the full pi `Model` shape expected by the store. */
type PersistedModel = ProviderModelConfig & {
	provider: string;
	api: "openai-completions";
	baseUrl: string;
};

/**
 * Models store entries are typed as pi `Model`s, so the persisted snapshot gets
 * the provider/api/baseUrl fields. They are stripped again on restore.
 */
function withProviderMetadata(models: ProviderModelConfig[]): PersistedModel[] {
	return models.map((model) => ({
		...model,
		provider: "nano-gpt",
		api: "openai-completions",
		baseUrl: BASE_URL,
	}));
}

export default function (pi: ExtensionAPI) {
	// Last successfully discovered catalog. Re-published when a later refresh
	// fails, so a transient error never empties the model list.
	let lastKnown: ProviderModelConfig[] = [];

	pi.registerProvider("nano-gpt", {
		name: "nanoGPT",
		baseUrl: BASE_URL,
		api: "openai-completions",
		// pi resolves auth: auth.json "nano-gpt" credential wins, env is the fallback.
		apiKey: "$NANOGPT_API_KEY",
		models: [],
		refreshModels: async (context) => {
			const restored = modelsFromStored(context.stored?.models);
			if (restored.length > 0) lastKnown = restored;

			// Offline/cache-only initialization: serve the persisted snapshot.
			if (!context.allowNetwork) return lastKnown;

			// A fresh snapshot is reused unless the caller explicitly forces a refresh.
			const checkedAt = finiteNumber(context.stored?.checkedAt);
			if (!context.force && checkedAt !== undefined && Date.now() - checkedAt < CATALOG_TTL_MS && lastKnown.length > 0) {
				return lastKnown;
			}

			// The network phase only runs once pi resolved a credential; prefer it
			// over the env fallback so a `/login nano-gpt` key is always used.
			const storedKey = (context.credential as { key?: unknown } | undefined)?.key;
			const key =
				typeof storedKey === "string" && storedKey.length > 0 ? storedKey : (process.env.NANOGPT_API_KEY ?? "");

			try {
				const response = await fetch(buildModelsUrl(), {
					signal: context.signal,
					headers: key ? { Authorization: `Bearer ${key}` } : {},
				});
				if (!response.ok) return lastKnown;

				const payload = (await response.json()) as { data?: unknown } | null;
				const records = payload?.data;
				if (!Array.isArray(records)) return lastKnown;

				const models = records
					.map((record) => mapNanoGptModel(record as NanoGptRawModel))
					.filter((model): model is ProviderModelConfig => model !== undefined);

				// An empty catalog is treated as a bad response, not as "no models":
				// the endpoint always returns the visible text catalog.
				if (models.length === 0) return lastKnown;

				lastKnown = models;
				await context.publish({
					persist: { models: withProviderMetadata(models), checkedAt: Date.now() },
				});
				return models;
			} catch {
				// Network failure or unparsable response: keep the last-known list;
				// a later refresh retries. No synthetic fallback model — a phantom
				// "auto-model" that fails on every call is worse than no models.
				return lastKnown;
			}
		},
	});
}
