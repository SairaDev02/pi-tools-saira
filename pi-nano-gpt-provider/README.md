# pi-nano-gpt-provider

A custom **nanoGPT provider** for the [Pi coding agent](https://pi.dev). Registers the `nano-gpt` provider against nano-gpt.com's OpenAI-compatible endpoint (`https://api.nano-gpt.com/api/v1`) with **lazy, detailed model discovery** — no blocking network call at startup.

## Why this shape

- **Never blocks startup.** Models are discovered via `refreshModels`, which Pi calls lazily with an abort signal. The old approach (a manual `fetch` in the factory) could hang Pi's launch when nano-gpt.com was slow or unreachable.
- **Detailed catalog, no hardcoded tables.** Discovery uses `GET /api/v1/models?detailed=true`, so every model carries real metadata straight from the API: context window (`context_length`), output cap (`max_output_tokens`), vision/reasoning/tool capabilities, and at-cost USD pricing (`pricing.prompt` / `pricing.completion`, plus cache rates when published).
- **Cached and resilient.** Successful snapshots are persisted through Pi's models store and restored on offline init; a fresh snapshot (< 5 min) is reused without a request; a failed refresh keeps the last-known list instead of wiping the catalog.
- **Honest "not configured" state.** With no API key, Pi never treats the provider as usable and no models appear — no phantom "auto-model" that fails on every call.
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

- **Model catalog**: fetched from `GET https://api.nano-gpt.com/api/v1/models?detailed=true` on demand. `api.nano-gpt.com` is nanoGPT's canonical API host for key-based integrations (the website lives on `nano-gpt.com`). The detailed shape is what the [models endpoint docs](https://docs.nano-gpt.com/api-reference/endpoint/models) recommend for capabilities and pricing.
- **Ordering**: the request asks for `sort=favorites`, so the account's most-used models come first (the API falls back to normal ordering when the key cannot be personalized). Set `NANOGPT_MODEL_SORT=mostused` for globally popular models, or `NANOGPT_MODEL_SORT=none` to leave the catalog order untouched.
- **Capabilities**: `vision` (or `architecture.input_modalities`) adds `image` input support; `capabilities.reasoning` and id suffixes ending in `:thinking` mark reasoning models.
- **Costs**: at-cost USD per-million-token rates from the API. Cache reads/writes use `pricing.cacheReadInputPer1kTokens` / `cacheWriteInputPer1kTokens` (converted from per-1k) when present; otherwise they fall back to the input rate rather than under-reporting spend.
- **Persistence**: a successful snapshot is written to Pi's models store (`models-store.json` in the agent directory) with a `checkedAt` timestamp. Offline/cache-only init restores it, and snapshots younger than five minutes (matching the API's `cache-control: s-maxage=300`) are reused without another request. `context.force` bypasses the freshness check.
- **Failures never wipe the catalog**: non-OK responses, network errors, unparsable payloads, and empty catalogs all keep the last-known model list.

## Options

| Variable | Default | Effect |
| --- | --- | --- |
| `NANOGPT_API_KEY` | — | Fallback API key when no `nano-gpt` credential is stored via `/login`. |
| `NANOGPT_MODEL_SORT` | `favorites` | Catalog ordering: `favorites`, `mostused`, or `none`/`off`. Unknown values use `favorites`. |

## Tests

The catalog mapping, snapshot restore, sort selection, persistence, and every refresh failure path run against a stubbed `fetch` — no Pi runtime and no network:

```bash
node --experimental-strip-types tests/nano-gpt-provider.test.ts
```

## Requirements

- Pi coding agent (extension API)
- An API key for nano-gpt.com

## License

MIT — see [LICENSE](./LICENSE).
