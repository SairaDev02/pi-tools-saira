# pi-tools-saira

A collection of custom extensions for the [Pi coding agent](https://pi.dev), packaged for distribution. Every package is a self-contained npm-style package (manifest + source + docs + license + tests) that Pi installs through its package mechanism.

## Packages

| Package | What it does | Requires |
|---------|--------------|----------|
| [`pi-nano-gpt-provider`](./pi-nano-gpt-provider) | Registers the **nanoGPT** provider — lazy model discovery via `refreshModels`, per-model context windows (128k → 1M), no blocking at startup, auth via `/login` or `NANOGPT_API_KEY`. | API key for nano-gpt.com |
| [`pi-provider-switch`](./pi-provider-switch) | `/provider`, `/switch-provider`, `/models` — interactive and argument-based provider/model switching with tab-completions and optional persistence of the default. | — |
| [`pi-review-debt`](./pi-review-debt) | **Review-debt tracker** — records review findings as durable per-repo debt, auto-flags likely-fixed findings via git blob change detection, surfaces open debt to the model and user. | `git` |
| [`pi-ci-status`](./pi-ci-status) | **CI status** — zero-token footer badge, on-demand `ci_status` tool, edge-triggered one-line context injection on CI state changes. Zero LLM calls. | `gh` (authenticated), `git` |

## Install

Each package is structured for npm publishing:

```bash
cd pi-nano-gpt-provider && npm publish      # etc.
```

then, in Pi:

```bash
pi install npm:pi-nano-gpt-provider
pi install npm:pi-provider-switch
pi install npm:pi-review-debt
pi install npm:pi-ci-status
```

> Check name availability on npm before publishing; if a name is taken, rename it in `package.json` (the `pi.extensions` entry points at `./src/<name>.ts` — keep the file name in sync).

**No-publish alternative** — copy each single-file extension into Pi's global extensions dir (auto-discovered, hot-reloadable with `/reload`):

```bash
cp pi-nano-gpt-provider/src/nano-gpt-provider.ts ~/.pi/agent/extensions/
cp pi-provider-switch/src/provider-switch.ts       ~/.pi/agent/extensions/
cp pi-review-debt/src/review-debt.ts               ~/.pi/agent/extensions/
cp pi-ci-status/src/ci-status.ts                   ~/.pi/agent/extensions/
```

After any install: `/reload` (or restart Pi).

## Post-install setup

```bash
# nano-gpt: authenticate once
/login nano-gpt                    # or: export NANOGPT_API_KEY=...

# ci-status: GitHub CLI, once
gh auth login
```

## Development

- Each package's `src/` file is the entire extension — no build step. Type-check against the real Pi types with `tsc --strict` (module NodeNext) using `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` from Pi's runtime.
- Tests are self-contained (`node --experimental-strip-types`) — see each package README:
  - `pi-review-debt`: 19 assertions (record → detect → resolve loop on a real temp git repo)
  - `pi-ci-status`: 38 assertions across 3 runs (fake `gh` shim, no network)

## License

MIT — see each package's [LICENSE](./pi-review-debt/LICENSE).
