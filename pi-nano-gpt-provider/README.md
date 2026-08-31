# pi-nano-gpt-provider

A custom **nanoGPT provider** for the [Pi coding agent](https://pi.dev). Registers the `nano-gpt` provider against nano-gpt.com's OpenAI-compatible endpoint (`https://nano-gpt.com/api/v1`) with **lazy model discovery** — no blocking network call at startup.

## Why this shape

- **Never blocks startup.** Models are discovered via `refreshModels`, which Pi calls lazily with an abort signal. The old approach (a manual `fetch` in the factory) could hang Pi's launch when nano-gpt.com was slow or unreachable.
- **Honest "not configured" state.** With no API key, the `/models` discovery call 401s and the extension exposes **no models** — no phantom "auto-model" that fails on every call.
- **Auth handled by Pi.** The key comes from `~/.pi/agent/auth.json` under provider id `nano-gpt` (via `/login nano-gpt`) with `NANOGPT_API_KEY` as the fallback (`$NANOGPT_API_KEY` is Pi's own env interpolation).

## Install

```bash
# from npm (after publishing)
pi install npm:pi-nano-gpt-provider

# or copy the single file into your global extensions dir
cp src/nano-gpt-provider.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart) and authenticate:

```bash
pi
/login nano-gpt          # store your API key
# or set the env var once:
export NANOGPT_API_KEY=...
```

## Usage

Once installed, `nano-gpt` appears alongside your other providers:

- `/provider nano-gpt` — switch to the provider (its first model)
- `/models nano-gpt` — list and pick from the discovered models
- `Ctrl+L` / `/model` — normal Pi model switching

## Behavior notes

- **Model catalog**: fetched from `GET /api/v1/models` on demand. Offline/cache-only init returns no models and retries on a later refresh; network errors keep the last-known list.
- **Reasoning models**: ids ending in `:thinking` are marked with `reasoning: true`.
- **Context windows**: mapped per model family (see `MODEL_CONTEXT_WINDOWS` in the source — OpenAI 128k, Claude/o1 200k, Gemini/GLM up to 1M). Unknown ids fall back to `DEFAULT_CONTEXT_WINDOW` (128k). Adjust the map to the live catalog after `/login` if needed.

## Requirements

- Pi coding agent (extension API)
- An API key for nano-gpt.com

## License

MIT — see [LICENSE](./LICENSE).
