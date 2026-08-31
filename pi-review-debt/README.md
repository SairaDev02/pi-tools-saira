# pi-review-debt

A **review-debt tracker** for the [Pi coding agent](https://pi.dev). Code-review findings become durable, per-repository debt — and the loop closes itself: when the affected file's content changes, the finding is flagged as likely fixed so it gets verified instead of forgotten.

Reviews are worthless if findings aren't followed up. This extension turns review into a closed loop:

1. **Record** — after a review (e.g. `/review`) surfaces concrete issues, the agent records each via the `record_finding` tool (or you use `/debt add`). The file's **git blob hash** is captured as the change-detection baseline.
2. **Detect** — at the end of every agent run, findings whose file's content changed (or was deleted) transition `open → addressed` (awaiting verification), with **one** notification per transition.
3. **Surface** — open debt is shown to the model every turn (a short `before_agent_start` bullet, only while debt exists) and to you via notifications and `/debt`.

## Install

```bash
# from npm (after publishing)
pi install npm:pi-review-debt

# or copy the single file into your global extensions dir
cp src/review-debt.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart). No configuration needed — state is created automatically.

## Agent-facing tools

| Tool | Purpose |
|------|---------|
| `record_finding` | Record a review finding: `title` (required), `severity` (`info`/`warning`/`critical`), `file` (repo-relative), `line`, `detail`. |
| `list_findings` | List recorded findings (`status` and `file` filters; defaults to open + addressed). |

The tools carry prompt guidelines so the model knows when to use them: record findings after reviews, and check `list_findings` before finishing work on changed files.

## Commands

```text
/debt                          interactive list (pick a finding → resolve/dismiss)
/debt add <title> [--sev=warning|critical|info] [--file=path] [--line=N]
/debt resolve <id>             mark verified-fixed (unique id prefixes work)
/debt dismiss <id>             mark won't-fix / not applicable
/debt check                    force a re-scan of open findings
/debt clear [--days=N]         purge resolved/dismissed older than N days (default 14; 0 = all)
```

## How it works

- **State**: `~/.pi/agent/review-debt/state.json` (override with `REVIEW_DEBT_STATE`). Atomic writes; all I/O is error-swallowed so the extension can never break the agent loop.
- **Change detection**: per finding, compares the current `git hash-object` of the file against the blob captured at creation. Works for tracked and untracked files; a deleted file is flagged as addressed (verify it wasn't just renamed).
- **Cross-repo safe**: detection is per-file-blob; findings from different repos never interfere.
- **Statuses**: `open` → (file changed) → `addressed` → (you/agent confirm) → `resolved` or `dismissed`.

## Pairs well with

- [`pi-review`](https://github.com/earendil-works/pi-review) — run `/review`, then the agent records findings with `record_finding`.
- [`pi-ci-status`](https://github.com/your-org/pi-ci-status) — after addressing a finding, the agent can check CI before claiming victory.

## Development / tests

The core logic is exported for testing. Run the functional test suite (uses a temp state file + a real temp git repo):

```bash
node --experimental-strip-types tests/review-debt.test.ts
```

> The test imports the extension, so the Pi runtime packages (`@earendil-works/pi-tui`, `typebox`) must be resolvable — e.g. run from an environment where Pi's runtime node_modules are reachable, or symlink/junction them into a local `node_modules` first.

Covers: record → unchanged stays open → file modified → auto-addressed → prefix-id resolve → dismiss → unknown-id → deleted-file detection → non-repo no-op. **19 assertions.**

## Requirements

- Pi coding agent (extension API)
- `git` on PATH (for blob/HEAD checks)

## License

MIT — see [LICENSE](./LICENSE).
