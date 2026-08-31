# pi-deepseek-hours

DeepSeek **peak/off-peak billing hours** footer indicator for the [Pi coding agent](https://pi.dev).

Shows whether DeepSeek API usage is currently billed at the **peak** rate or the **off-peak** rate (50% off), with a live countdown to the next transition. The schedule comes straight from DeepSeek's official pricing docs:

> *"Off-peak rates are half of the peak rates. **Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday** (all other hours are off-peak)."*
> — <https://api-docs.deepseek.com/quick_start/pricing>

## Install

```bash
# from npm (after publishing)
pi install npm:pi-deepseek-hours

# or copy the single file into your global extensions dir
cp src/deepseek-hours.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart).

## Usage

The indicator appears in the footer **only while a DeepSeek model is the active provider** (provider id `deepseek`). Switch models and it follows automatically.

| Command | Effect |
| --- | --- |
| `/deepseek-hours` | Toggle the badge on/off (persisted) |
| `/deepseek-hours badge` | Colored status in the built-in footer (default) |
| `/deepseek-hours full` | Replace the footer with a custom component: token usage, model, branch, other extension statuses, plus the DeepSeek window |
| `/deepseek-hours off` | No indicator |
| `/deepseek-hours status` | Print the current window state as plain text (e.g. for a quick check or to share with the model) |
| `/deepseek-hours mode` | Show the current mode (`persisted` or `default`) |
| `/deepseek-hours mode badge\|full\|off` | Set the mode **and persist it** across restarts |
| `/deepseek-hours mode reset` | Back to the default (`badge`), clears persistence |

The mode set via any command above is persisted to `~/.pi/agent/deepseek-hours/mode.json` and re-applied on the next session start (`/reload` included), so a `full`-footer preference survives restarts.

### What it shows

- **OFF-PEAK** (green): `DSK off-peak (-50%) · next peak 01:00 UTC in 42m`
- **PEAK** (amber): `DSK peak (2× off-peak) · off-peak 10:00 UTC in 3h 12m`
- **Weekend**: `DSK off-peak (-50%) · next peak Mon 01:00 UTC in 1d`
- Non-UTC schedules are labeled `local` instead of `UTC`; transitions on a later day are prefixed with the weekday.

The countdown refreshes every 30 seconds; the badge only updates when its text actually changes.

## Configuration (optional env vars)

The official schedule is hardcoded by default; everything is overridable for schedule changes and testing:

| Env var | Meaning | Default |
| --- | --- | --- |
| `DEEPSEEK_PEAK_WINDOWS` | Comma-separated `HH:MM-HH:MM` peak windows in the schedule timezone | `01:00-04:00,06:00-10:00` |
| `DEEPSEEK_UTC_OFFSET` | Hours added to UTC for the schedule timezone (e.g. `8` for Beijing) | `0` (official schedule is UTC) |
| `DEEPSEEK_PROVIDER_IDS` | Comma-separated provider ids to match | `deepseek` |
| `DEEPSEEK_HOURS_STATE` | Mode state file (where `/deepseek-hours mode` persists) | `~/.pi/agent/deepseek-hours/mode.json` |

Example (Beijing-time schedule):

```bash
export DEEPSEEK_UTC_OFFSET=8
```

If DeepSeek ever changes the windows (or you want to simulate), just set the vars and `/reload`:

```bash
export DEEPSEEK_PEAK_WINDOWS="09:00-12:00,14:00-18:00"   # Beijing peak hours
```

Invalid values are ignored with a warning — the extension falls back to the defaults and never breaks pi.

## How it works

- `ctx.ui.setStatus("deepseek-hours", ...)` renders the colored badge inside the built-in footer (ANSI colors are honored).
- `/deepseek-hours full` uses `ctx.ui.setFooter(...)` with a component mirroring the built-in footer (cwd/branch line, token stats + model, and other extensions' statuses so the `ci` badge etc. stay visible).
- A 30-second timer recomputes the state; renders only happen when the displayed text changes.
- The provider is detected via `ctx.model.provider` on `model_select` / `session_start` / `agent_end` events.
- The indicator auto-clears on `session_shutdown`.

## Development

- The extension is a single file — no build step.
- One-time dev deps (resolved from the package dir; `node_modules` is gitignored):

```bash
npm i --no-save typescript @earendil-works/pi-coding-agent @earendil-works/pi-tui @earendil-works/pi-ai
```

- Run the pure schedule/format tests with plain node:

```bash
node --experimental-strip-types tests/deepseek-hours.test.ts
```

- Type-check against the real Pi types:

```bash
node_modules/.bin/tsc -p tsconfig.json
```

## Requirements

- Pi coding agent (extension API)

## License

MIT — see [LICENSE](./LICENSE).
