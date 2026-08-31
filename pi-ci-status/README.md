# pi-ci-status

Lightweight **CI status** for the [Pi coding agent](https://pi.dev): keeps you and the model aware of GitHub Actions state on the current branch **without burning tokens on per-turn status text**. This extension makes **zero LLM calls** — it only spawns throttled `gh`/`git` processes.

## The three-layer design

1. **Footer badge — zero tokens.** `ctx.ui.setStatus("ci", "CI: ✓ / ✗ test / ⟳ deploy")` shows a compact indicator, refreshed on session start and after each agent run.
2. **Tool `ci_status`.** The model pulls full detail on demand (latest run + which of the last 5 runs are failing, with URLs). Guidelines tell it *when*: before claiming a fix works, after pushing, when CI is red.
3. **Edge-triggered delta.** ONLY when the CI signature changes (green→red, red→green, none→red…) does the extension append **one** line to the next turn's system prompt and show **one** notification. A persisted `lastInjectKey` per `repo|branch` ensures `/reload` never re-injects.

## Install

```bash
# from npm (after publishing)
pi install npm:pi-ci-status

# or copy the single file into your global extensions dir
cp src/ci-status.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart).

**Requires the GitHub CLI, authenticated:**

```bash
gh auth login      # once
```

If `gh` is missing or unauthenticated, the extension degrades to a silent no-op with a single warning — it never crashes or prompts.

## Usage

- `/ci` — show the current status (badge + latest workflow)
- `/ci refresh` — force a fresh check, bypassing the throttle
- `/ci badge [on|off|activity|reset]` — set the footer badge mode at runtime (persisted); `reset` returns to the env var
- The `ci_status` tool (`refresh: true` to bypass the throttle) is available to the model

### Footer badge options

The footer badge can be gated or disabled via env var **and/or** the `/ci badge` runtime toggle (which wins and is persisted) — the `ci_status` tool, `/ci` command, and context injection are **unaffected**:

| Value | Behavior |
| --- | --- |
| `always` (default) | Show whenever a snapshot exists (current behavior) |
| `activity` | Show only when the branch has CI activity (≥ 1 run); hides the "CI: –" placeholder on repos with no runs yet |
| `off` | Never show the footer badge |

```bash
export CI_STATUS_BADGE=activity    # badge only appears once CI has run
# or: export CI_STATUS_BADGE=off   # badge disabled, everything else keeps working
```

At runtime (no restart needed):

```text
/ci badge              → show current mode (override or env default)
/ci badge activity     → activity mode, persisted
/ci badge on           → always show, persisted
/ci badge off          → badge disabled, persisted
/ci badge reset        → back to the CI_STATUS_BADGE env var
```

The override is stored in `~/.pi/agent/ci-status/badge-mode.json` (override the path with `CI_STATUS_BADGE_FILE`).

## Cost / behavior notes

- **Throttle**: at most one `gh run list` per **90 s** (`CI_STATUS_TTL_MS` env override) *and* per new HEAD — a run completing with no new commits still gets re-checked at the TTL; no redundant spawns otherwise.
- **`gh` gate at load**: one-time `gh --version` + `gh auth status` probe. On failure, `gh` is never spawned again this session.
- **State**: `~/.pi/agent/ci-status/state.json` (override with `CI_STATUS_STATE`), keyed `repo|branch` → last fetch time, HEAD sha, snapshot, and inject key.
- All I/O is error-swallowed — the extension can never break the agent loop.
- It reports the **latest run** (status/conclusion + workflow name) and **which of the last 5 runs are failing**.

## Development / tests

The core logic is exported for testing. Tests use a **fake `gh` shim** (`tests/gh-shim.mjs`) — no network, no auth:

```bash
# happy paths (throttle, transitions, derivation)
CI_STATUS_TTL_MS=1 CI_STATUS_GH_BIN="$PWD/tests/gh-shim.mjs" node --experimental-strip-types tests/ci-status.test.ts

# gh-missing / unauthenticated no-op (separate processes; the gh gate is cached per process)
CI_STATUS_GH_BIN=/nonexistent node --experimental-strip-types tests/ci-status.ghfail.test.ts
CI_STATUS_GH_BIN="$PWD/tests/gh-shim.mjs" GH_SHIM_AUTH_FAIL=1 node --experimental-strip-types tests/ci-status.ghfail.test.ts
```

Covers: gate ok · initial fetch · HEAD-unchanged skip (no extra spawn) · new-commit refetch · green→red transition fires once · red→active · no re-fire on same signature · badge/line/format derivation · badge visibility modes (`CI_STATUS_BADGE`: always/activity/off) · badge-mode override persistence (`/ci badge`) · gh-missing and unauthenticated no-ops. **56 assertions** across the 3 runs.

> The tests import the extension, so `typebox` (and `@earendil-works/pi-tui` if used) must be resolvable — e.g. run from an environment where Pi's runtime node_modules are reachable, or symlink/junction them into a local `node_modules` first.

Type-check against the real Pi types (`tsconfig.json` included):

```bash
node_modules/.bin/tsc -p tsconfig.json
```

## Requirements

- Pi coding agent (extension API)
- GitHub CLI (`gh`) installed and authenticated
- `git` on PATH

## License

MIT — see [LICENSE](./LICENSE).
