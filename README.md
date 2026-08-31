# pi-tools-saira

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![For: Pi coding agent](https://img.shields.io/badge/For-Pi%20coding%20agent-8A2BE2)
![Repo: SairaDev02/pi-tools-saira](https://img.shields.io/badge/Repo-SairaDev02%2Fpi--tools--saira-181717?logo=github&logoColor=white)

A collection of custom extensions for the [Pi coding agent](https://pi.dev), packaged for distribution. Each package is self-contained (manifest + source + docs + license + tests) and installs through Pi's package mechanism — or by copying the single-file extension into Pi's global extensions dir.

## Packages

| Package | What it does | Requires |
|---------|--------------|----------|
| [`pi-nano-gpt-provider`](./pi-nano-gpt-provider) | Registers the **nanoGPT** provider — lazy model discovery via `refreshModels`, per-model context windows (128k → 1M), no blocking at startup, auth via `/login` or `NANOGPT_API_KEY`. | API key for nano-gpt.com |
| [`pi-provider-switch`](./pi-provider-switch) | `/provider`, `/switch-provider`, `/models` — interactive and argument-based provider/model switching with tab-completions and optional persistence of the default. | — |
| [`pi-review-debt`](./pi-review-debt) | **Review-debt tracker** — records review findings as durable per-repo debt, auto-flags likely-fixed findings via git blob change detection, surfaces open debt to the model and user. | `git` |
| [`pi-ci-status`](./pi-ci-status) | **CI status** — zero-token footer badge, on-demand `ci_status` tool, edge-triggered one-line context injection on CI state changes. Zero LLM calls. | `gh` (authenticated), `git` |
| [`pi-deepseek-hours`](./pi-deepseek-hours) | **DeepSeek peak/off-peak hours** — colored footer badge (or full custom footer) showing the current billing window with a live countdown to the next transition, per DeepSeek's official pricing schedule. | — |

## Install

### From npm (published packages)

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
pi install npm:pi-deepseek-hours
```

> Check name availability on npm before publishing; if a name is taken, rename it in `package.json` (the `pi.extensions` entry points at `./src/<name>.ts` — keep the file name in sync).

### From this repo (no publish needed)

The full source of every package lives in this repository. Clone it and copy each single-file extension into Pi's global extensions dir (auto-discovered, hot-reloadable with `/reload`):

```bash
git clone https://github.com/SairaDev02/pi-tools-saira
cd pi-tools-saira
cp pi-nano-gpt-provider/src/nano-gpt-provider.ts ~/.pi/agent/extensions/
cp pi-provider-switch/src/provider-switch.ts       ~/.pi/agent/extensions/
cp pi-review-debt/src/review-debt.ts               ~/.pi/agent/extensions/
cp pi-ci-status/src/ci-status.ts                   ~/.pi/agent/extensions/
cp pi-deepseek-hours/src/deepseek-hours.ts         ~/.pi/agent/extensions/
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
  - `pi-ci-status`: 48 assertions across 3 runs (fake `gh` shim, no network)
  - `pi-deepseek-hours`: 71 assertions (schedule parsing, weekday/weekend/offset transitions, formatting)

## License

MIT — see each package's [LICENSE](./pi-review-debt/LICENSE).
