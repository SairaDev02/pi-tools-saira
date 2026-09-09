# pi-tools-saira

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![For: Pi coding agent](https://img.shields.io/badge/For-Pi%20coding%20agent-8A2BE2)
![Repo: SairaDev02/pi-tools-saira](https://img.shields.io/badge/Repo-SairaDev02%2Fpi--tools--saira-181717?logo=github&logoColor=white)

A collection of MIT-licensed extensions for the [Pi coding agent](https://pi.dev). Each extension is self-contained — manifest, single-file source, docs, tests, and license — with no build step, so you can read the whole implementation before you trust it.

## Overview

The five tools cover three everyday jobs in Pi:

- **Choosing a model.** [`pi-nano-gpt-provider`](./pi-nano-gpt-provider) adds an extra provider (nanoGPT) without slowing Pi's startup; [`pi-provider-switch`](./pi-provider-switch) makes moving between providers and models fast, with tab-completions.
- **Closing the review loop.** [`pi-review-debt`](./pi-review-debt) records code-review findings as durable per-repo debt and flags them when the code changes; [`pi-ci-status`](./pi-ci-status) is what the agent checks before claiming a fix is done.
- **Staying aware, at zero token cost.** [`pi-ci-status`](./pi-ci-status) and [`pi-deepseek-hours`](./pi-deepseek-hours) render footer indicators directly in the UI and make no LLM calls.

Everything is deliberately small and auditable. Pick one package and read on — each ships its own README with full usage, behavior notes, and env-var reference.

## Packages

| Package | What it does | Requires |
|---------|--------------|----------|
| [`pi-nano-gpt-provider`](./pi-nano-gpt-provider) | Registers the **nanoGPT** provider — lazy model discovery via `refreshModels` (no blocking at startup), per-model context windows (128k → 1M), auth via `/login` or `NANOGPT_API_KEY`. | API key for nano-gpt.com |
| [`pi-provider-switch`](./pi-provider-switch) | `/provider`, `/switch-provider`, `/models` — interactive and argument-based provider/model switching with tab-completions and optional persistence of the default. | — |
| [`pi-review-debt`](./pi-review-debt) | **Review-debt tracker** — records review findings as durable per-repo debt, auto-flags likely-fixed findings via git blob change detection, surfaces open debt to the model and user. | `git` |
| [`pi-ci-status`](./pi-ci-status) | **CI status** — zero-token footer badge, on-demand `ci_status` tool, edge-triggered one-line context injection on CI state changes. Zero LLM calls. | `gh` (authenticated), `git` |
| [`pi-deepseek-hours`](./pi-deepseek-hours) | **DeepSeek peak/off-peak hours** — colored footer badge (or full custom footer) showing the current billing window with a live countdown to the next transition, per DeepSeek's official pricing schedule. | — |

## Install

### From this repository (recommended)

The packages are **not published to npm yet**, so this repository is the supported way to install today. Clone it and copy the extension(s) you want into Pi's global extensions directory — `~/.pi/agent/extensions/` (on Windows: `%USERPROFILE%\.pi\agent\extensions\`) is auto-discovered by Pi:

```bash
git clone https://github.com/SairaDev02/pi-tools-saira
cd pi-tools-saira

# copy only the packages you want — each line is independent
cp pi-nano-gpt-provider/src/nano-gpt-provider.ts ~/.pi/agent/extensions/
cp pi-provider-switch/src/provider-switch.ts       ~/.pi/agent/extensions/
cp pi-review-debt/src/review-debt.ts               ~/.pi/agent/extensions/
cp pi-ci-status/src/ci-status.ts                   ~/.pi/agent/extensions/
cp pi-deepseek-hours/src/deepseek-hours.ts         ~/.pi/agent/extensions/
```

After any install: `/reload` (or restart Pi). Extensions in that directory hot-reload, and updating is a matter of `git pull` + re-copying the file.

### From npm (once published)

Each package carries a `pi` manifest (`package.json` → `pi.extensions`), so it can be published to npm independently and installed with `pi install npm:<name>`. **Until the packages are actually published, those commands will 404** — use the repository install above instead. Once live, each package's own README shows its exact install command.

## Post-install setup

```bash
# nano-gpt: authenticate once
/login nano-gpt                    # or: export NANOGPT_API_KEY=...

# ci-status: GitHub CLI, once
gh auth login
```

## Requirements

- **Pi coding agent** with extension support (current stable release).
- **`git` on PATH** — required by `pi-review-debt` and `pi-ci-status` (blob/HEAD checks); the install flow uses it too.
- **GitHub CLI (`gh`), installed and authenticated** — `pi-ci-status` only.
- **An API key for nano-gpt.com** — `pi-nano-gpt-provider` only.
- Everything else is optional: each package's env vars are documented in its own README, and state files are created under `~/.pi/agent/` on first use.

## Development

Each package's `src/` file is the entire extension — no build step. Type-check against the real Pi types with `tsc --strict` (module NodeNext) using the packages Pi bundles (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`). Tests are self-contained and run with plain node (`--experimental-strip-types`, Node ≥ 22.6) — see each package README for the exact commands and dev-dependency setup:

- `pi-ci-status`: **60 assertions across 4 runs** — main behavior, `gh`-missing, unauthenticated, and gate-recovery, all against a fake `gh` shim with no network.
- `pi-deepseek-hours`: **90 assertions** — schedule parsing, weekday/weekend/offset transitions, formatting, Flash rate card, mode persistence.
- `pi-review-debt`: **19 assertions** — the record → detect → resolve loop on a real temp git repo.

## Contributing & support

- **Bugs and feature requests**: open a [GitHub issue](https://github.com/SairaDev02/pi-tools-saira/issues). Please include your Pi version and, for bugs, the extension and reproduction steps.
- **Pull requests are welcome.** Before submitting:
  - Keep each extension a single file in `src/` (the `pi.extensions` manifest entry points at it — keep names in sync).
  - No build step: the `.ts` file is what ships.
  - Run the package's tests (`node --experimental-strip-types tests/<name>.test.ts`) and keep `tsc -p tsconfig.json` clean.
  - Preserve the design constraints — all I/O is error-swallowed so an extension can never break the agent loop, and UI indicators make zero LLM calls.
- **Security**: Pi extensions execute with your full system access, so review source before installing — this codebase is small and readable by design. To report a vulnerability privately, use GitHub's private vulnerability reporting on the repository (Security → *Report a vulnerability*).

## Notes on third-party data

DeepSeek pricing windows and rates, nano-gpt.com's model catalog, and GitHub Actions state are all published by their respective providers and may change. This project is not affiliated with DeepSeek or nano-gpt.com.

## License

MIT — see each package's [LICENSE](./pi-ci-status/LICENSE).
