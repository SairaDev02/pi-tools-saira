# pi-verify-gate

Local **verification status** for the [Pi coding agent](https://pi.dev): does the tree in front of you still pass? This extension makes **zero LLM calls** — it runs your project's own check (tests, typecheck, lint) only when the working tree actually changed, and reports the result in a footer badge, an on-demand tool, and a single injected line.

It is the **local sibling of `pi-ci-status`**. That extension tells you what GitHub thinks *after* you push; this one tells you whether the working tree passes *before* you claim the fix works.

## The three-layer design

1. **Footer badge — zero tokens.** `ctx.ui.setStatus("verify", "Verify: … / ✓ / ✗ 2 / ⏱ / –")` shows a compact indicator (`…` while a run is in flight). It is rendered from cached state on `session_start` — no check is ever spawned at startup.
2. **Tool `verify_status`.** The model pulls full detail on demand: resolved command, exit code, duration, failure hints, and the output tail. Guidelines tell it *when*: before claiming a fix works, and never to report completion while local verify is failing.
3. **Edge-triggered delta.** ONLY when the verify signature changes (`command|pass` → `command|fail`, `fail` → `pass`, `timeout` → `pass`…) does the extension append **one** line to the next turn's system prompt and show **one** notification. A persisted `lastInjectKey` per repo means `/reload` never re-injects.

## Install

```bash
# from npm (after publishing)
pi install npm:pi-verify-gate

# or copy the single file into your global extensions dir
cp src/verify-gate.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart). Nothing else to configure — the check is auto-detected (see below). Requires `git` on PATH.

## Usage

- `/verify` — show the current status
- `/verify run` — force a fresh check, bypassing the throttle
- `/verify badge [on|off|activity|reset]` — set the footer badge mode at runtime (persisted); `reset` returns to the env var
- `/verify cmd <command>` — override the detected check **for this repo** (persisted, keyed by git root); `/verify cmd reset` clears it
- The `verify_status` tool (`refresh: true` to bypass the throttle) is available to the model

### What it runs

Detection order, first match wins:

| Priority | Source | Command |
| --- | --- | --- |
| 1 | `VERIFY_GATE_CMD` | *your string, verbatim* |
| 2 | `<git root>/.pi/verify-gate.json` | `{ "command": "…" }` — only for trusted projects |
| 3 | `/verify cmd <command>` | persisted override **for that repo** in `config.json` |
| 4 | `package.json` scripts | `<pm> run <script>`, first of `check` → `verify` → `test` → `typecheck` → `lint` |
| 5 | `Cargo.toml` | `cargo test --quiet` |
| 6 | `go.mod` | `go test ./...` |
| 7 | `pyproject.toml` | `python -m pytest -q` |
| 8 | `Makefile` | `make check` (only if a `check:` target exists) |

The package manager for #4 is picked from the lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun, otherwise npm. A placeholder script — the `"test": "echo \"Error: no test specified\" && exit 1"` that `npm init -y` writes, or a bare `exit 1` — is **not** treated as a check, so a fresh repo cannot report a permanent failure. If nothing matches, the extension no-ops with **one** warning and re-tries on the next settle — it never latches.

Overrides are resolved against the **git root**, never `ctx.cwd`, so starting Pi inside `packages/api/` finds the same project config and state key as starting it at the root. `/verify cmd` is stored **per repo root**: an override recorded for a Python repo can never run in a Rust repo.

## How the gate works

An automatic verify run is expensive, so it is gated three times:

- **Tree gate.** The working tree must have actually changed. The key is `sha256` over `HEAD` + `git status --porcelain -uall` + `git diff HEAD`. Untracked files are not in that diff, so their size+mtime is hashed too (bounded to 200 files) — otherwise an agent rewriting a *new* file would never trigger a check.
- **TTL gate.** At most one check per `VERIFY_GATE_TTL_MS` (default 30s).
- **Single-flight.** A module-level promise chain — two settles can never run two test suites at once.

Two details matter and are deliberate:

- **The tree key is recorded *after* the check finishes.** The check itself may rewrite files (formatters, snapshot tests, codegen). Recording the pre-run key would make the next settle see a "changed" tree and re-run forever.
- **The signature is `commandId|status` and excludes the output.** Otherwise every differently-worded failure of the same broken test would re-inject a line into the system prompt.

An automatic run happens on **`agent_settled`** (Pi will not retry, compact, or continue on its own) — not on `agent_end`, which can fire mid-retry.

That run is **not awaited**: a real suite can take minutes, event handlers are awaited by Pi, and a status integration must never stall idle processing or the next prompt. The badge shows `Verify: …` immediately, and the result, notification, and injected line are applied when the run resolves. (The injected line therefore lands on the next turn — which is exactly when it is useful.) In a one-shot `-p` run the process can exit before a long background check finishes, so the automatic result is best-effort there; the `verify_status` tool and `/verify run` are awaited and always complete.

### `unavailable` is not `fail`

If the toolchain or the command itself is missing, the status is `unavailable` — badge `Verify: –`, no injected line, no "verify failed" alarm, one warning. A `timeout` (default 120s, `VERIFY_GATE_TIMEOUT_MS`) gets its own `Verify: ⏱` badge.

## Footer badge options

The badge mode is settable via env var **and/or** `/verify badge` (which wins and is persisted); the `verify_status` tool, `/verify` command, and context injection are **unaffected**.

| Value | Behavior |
| --- | --- |
| `activity` (default) | Show only once a result exists |
| `always` | Show even before the first run (`Verify: –`) |
| `off` | Never show the footer badge |

> Note: the default here is `activity`, unlike `pi-ci-status`'s `always`. A repo with no detectable check would otherwise permanently display a meaningless `Verify: –`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VERIFY_GATE_CMD` | — | Hard override of the detected command (also the test seam) |
| `VERIFY_GATE_MODE` | `auto` | `off` disables the automatic run (tool + `/verify run` still work) |
| `VERIFY_GATE_BADGE` | `activity` | `always` \| `activity` \| `off` |
| `VERIFY_GATE_TTL_MS` | `30000` | Minimum time between checks |
| `VERIFY_GATE_TIMEOUT_MS` | `120000` | Hard timeout per check |
| `VERIFY_GATE_MAX_LINES` | `40` | Output-tail line cap |
| `VERIFY_GATE_STATE` | `~/.pi/agent/verify-gate/state.json` | State file |
| `VERIFY_GATE_CONFIG` | `~/.pi/agent/verify-gate/config.json` | Persisted overrides |

## Cost / behavior notes

- **Zero LLM calls.** The only cost is the check you asked for, gated by the tree key and TTL.
- **Bounded work:** hard timeout, ~2 MB output buffer, and only the last 40 lines / 4000 chars of output are kept — in state and in context.
- **Project-local config is trust-gated.** `<cwd>/.pi/verify-gate.json` is only read when `ctx.isProjectTrusted()`. The extension itself does not require trust: running your project's own check is what the agent already does.
- All I/O is error-swallowed — the extension can never break the agent loop.
- On Windows the check runs through the shell, which is required because npm/pnpm/yarn/bun are `.cmd` shims. cmd.exe reports a *missing* command as exit code 1 (the same as a failing test), so a missing toolchain is recognised from the shell's own message — scoped tightly so real test output is never misread as `unavailable`.
- **Known limitation:** a check that hits the timeout has its shell killed, but grandchildren it spawned (e.g. `npm` → `node`) can outlive it. Keep `VERIFY_GATE_TIMEOUT_MS` above your suite's normal runtime.
- The **gate** costs a few `git` calls per settle (HEAD, status, diff); the expensive thing — your test suite — is what the tree/TTL gates actually protect.

## Development / tests

The core logic is exported for testing. Tests use a **fake check shim** (`tests/check-shim.mjs`) — no real test suite is run:

```bash
# TTL=0 so the tree-key gate (not the TTL) is what's under test
VERIFY_GATE_TTL_MS=0 node --experimental-strip-types tests/verify-gate.test.ts
```

Covers: detection order + lockfile/PM choice · placeholder `npm init` scripts rejected · project config trust-gating from the git root · `/verify cmd` isolation between repos · tree-key sensitivity (tracked, new untracked, untracked content) · pass/fail/timeout/unavailable outcomes · failure-hint extraction (`SyntaxError`/`TypeError`/`Traceback`/`error[E]`/`error TS`, and quiet on clean output) · output-tail truncation · badge/line/signature derivation · badge + run modes · config roundtrip · force vs throttled runs · pass→fail and fail→pass transitions fire once · **post-run key recording** (a check that rewrites the tree must not re-run) · `no-check`/`no-repo` inert cases · extension wiring (`session_start` does no spawn, the auto-run is detached from the event path, `agent_settled` sets the badge, auto-run `off`, one-line injection happens **exactly once**) · tool + `/verify` command surface.

Type-check against the real Pi types (`tsconfig.json` included):

```bash
node_modules/.bin/tsc -p tsconfig.json
```

> The tests import the extension, so `typebox` (and `@earendil-works/pi-tui` if used) must be resolvable — run from an environment where Pi's runtime node_modules are reachable, or symlink/junction them into a local `node_modules` first.

## Requirements

- Pi coding agent (extension API)
- `git` on PATH
- A project with a detectable check (or set `VERIFY_GATE_CMD`)

## License

MIT — see [LICENSE](./LICENSE).
