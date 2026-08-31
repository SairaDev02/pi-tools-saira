import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * nanoGPT custom provider for pi.
 *
 * - Endpoint: OpenAI-compatible at https://nano-gpt.com/api/v1
 * - Auth: pi resolves the credential itself — an api key stored in
 *   `~/.pi/agent/auth.json` under provider id "nano-gpt" (via `/login nano-gpt`)
 *   takes priority; `NANOGPT_API_KEY` env var is the fallback (`$NANOGPT_API_KEY`
 *   interpolation below is pi's own resolution, no manual shim needed).
 * - Models: discovered lazily via `refreshModels` — never blocks startup, honors
 *   the shared abort signal, and skips network entirely on offline init.
 */
const BASE_URL = "https://nano-gpt.com/api/v1";

/**
 * Per-model context windows. NanoGPT resells many families with different
 * windows (128k OpenAI models, 200k Claude, up to 1M Gemini/GLM). The map is
 * the extension point — adjust entries to the live catalog after `/login`.
 * Unknown ids fall back to DEFAULT_CONTEXT_WINDOW.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI family
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1": 200_000,
  "o3": 200_000,
  // Anthropic family
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  // Gemini / GLM — 1M-token models
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "glm-5.3-flash": 1_000_000,
};
const DEFAULT_CONTEXT_WINDOW = 128_000;

export default function (pi: ExtensionAPI) {
  pi.registerProvider("nano-gpt", {
    name: "nanoGPT",
    baseUrl: BASE_URL,
    api: "openai-completions",
    // pi resolves auth: auth.json "nano-gpt" credential wins, env is the fallback.
    apiKey: "$NANOGPT_API_KEY",
    models: [],
    refreshModels: async ({ signal, credential, allowNetwork }) => {
      // Offline/cache-only initialization: nothing to fetch yet.
      if (!allowNetwork) return [];

      // Best-effort bearer for the discovery call; without a key the endpoint
      // 401s and we simply expose no models (honest "not configured yet").
      const storedKey = (credential as { key?: unknown } | undefined)?.key;
      const key =
        typeof storedKey === "string" && storedKey.length > 0
          ? storedKey
          : (process.env.NANOGPT_API_KEY ?? "");

      try {
        const response = await fetch(`${BASE_URL}/models`, {
          signal,
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        });
        if (!response.ok) return [];

        const payload = (await response.json()) as {
          data?: Array<{ id: string; name?: string }>;
        };
        if (!Array.isArray(payload.data)) return [];

        return payload.data.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          // model ids ending in :thinking advertise extended thinking
          reasoning: m.id.toLowerCase().endsWith(":thinking"),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: MODEL_CONTEXT_WINDOWS[m.id] ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: 8192,
        }));
      } catch {
        // Network failure: keep the last-known (empty) list; a later refresh
        // retries. No synthetic fallback model — a phantom "auto-model" that
        // fails on every call is worse than no models.
        return [];
      }
    },
  });
}
