/**
 * deepseek-hours — DeepSeek peak/off-peak hours footer indicator for pi.
 *
 * Shows whether DeepSeek API billing is currently in PEAK or OFF-PEAK hours,
 * with a live countdown to the next transition — sourced from DeepSeek's
 * official pricing docs:
 *
 *   https://api-docs.deepseek.com/quick_start/pricing
 *   "Off-peak rates are half of the peak rates. Peak hours are
 *    01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
 *    (all other hours are off-peak)."
 *
 *   Rate card (Flash series) — effective 2026-09-10 12:00 Beijing time:
 *   off-peak unit prices are $0.003 per 1M input tokens on cache hits,
 *   $0.15 per 1M input tokens on cache misses and $0.6 per 1M output
 *   tokens; peak-hour prices are double the off-peak rates. The
 *   peak/off-peak windows above are unchanged.
 *
 * Modes (toggle with /deepseek-hours, persisted across restarts):
 *   badge  (default)  colored status item in the built-in footer
 *   off                no indicator
 *   status             print the current window state as plain text
 *   full               DEPRECATED alias for "badge" (kept for persisted
 *                      state and habit; the built-in footer already shows
 *                      other extensions' statuses next to the badge)
 *
 * The indicator is only shown while a DeepSeek model is the active provider
 * (provider id "deepseek" — override with DEEPSEEK_PROVIDER_IDS).
 *
 * Env overrides (all optional — for schedule changes and testing):
 *   DEEPSEEK_PEAK_WINDOWS  comma-separated "HH:MM-HH:MM" windows in the
 *                          schedule timezone
 *                          (default "01:00-04:00,06:00-10:00")
 *   DEEPSEEK_UTC_OFFSET    hours added to UTC to get the schedule timezone
 *                          (default 0 — the official schedule is UTC)
 *   DEEPSEEK_PROVIDER_IDS  comma-separated provider ids to match
 *                          (default "deepseek")
 *   DEEPSEEK_FLASH_RATES   off-peak Flash unit prices "hit,miss,output" in
 *                          USD per 1M tokens (default "0.003,0.15,0.6" —
 *                          the rate card effective 2026-09-10 12:00 Beijing;
 *                          peak prices are derived as 2x off-peak)
 *   DEEPSEEK_HOURS_STATE   mode state file (default ~/.pi/agent/deepseek-hours/mode.json;
 *                          the mode set via /deepseek-hours survives restarts)
 *
 * The pure schedule/format logic lives in exported functions so the tests
 * (tests/deepseek-hours.test.ts) run with plain node, no pi runtime needed.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Schedule facts (official, as of the pricing page above)
// ---------------------------------------------------------------------------

/** Default peak windows: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
export const DEFAULT_PEAK_WINDOWS_STR = "01:00-04:00,06:00-10:00";
/** JS Date.getDay() values that count as peak weekdays (1=Mon .. 5=Fri). */
export const DEFAULT_PEAK_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
export const DEFAULT_PROVIDER_IDS: readonly string[] = ["deepseek"];
/** Off-peak Flash unit prices (USD per 1M tokens) as "hit,miss,output", effective 2026-09-10 12:00 Beijing. */
export const DEFAULT_FLASH_RATES_STR = "0.003,0.15,0.6";

export interface PeakWindow {
	/** Start of the window: minutes since midnight (schedule tz), inclusive. */
	startMin: number;
	/** End of the window: minutes since midnight (schedule tz), exclusive. endMin < startMin means the window wraps past midnight. */
	endMin: number;
}

export interface ScheduleConfig {
	windows: PeakWindow[];
	/** Minutes added to UTC to get the schedule timezone (0 = UTC). */
	utcOffsetMinutes: number;
	peakWeekdays: readonly number[];
}

// ---------------------------------------------------------------------------
// Config parsing (env-overridable, pure)
// ---------------------------------------------------------------------------

/** Parse "HH:MM-HH:MM,HH:MM-HH:MM" into windows. Throws on invalid input. */
export function parseWindows(s: string): PeakWindow[] {
	const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0) {
		throw new Error(`DEEPSEEK_PEAK_WINDOWS is empty (expected "HH:MM-HH:MM,...")`);
	}
	return parts.map((part) => {
		const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(part);
		if (!m) {
			throw new Error(`Invalid peak window "${part}" (expected HH:MM-HH:MM, e.g. 01:00-04:00)`);
		}
		const startMin = Number(m[1]) * 60 + Number(m[2]);
		const endMin = Number(m[3]) * 60 + Number(m[4]);
		if (startMin >= 1440 || endMin >= 1440) {
			throw new Error(`Invalid peak window "${part}" (times must be < 24:00)`);
		}
		if (startMin === endMin) {
			throw new Error(`Invalid peak window "${part}" (zero-length)`);
		}
		return { startMin, endMin };
	});
}

/** Build the schedule from env vars (or defaults). Throws on invalid values. */
export function loadConfig(env: Record<string, string | undefined>): ScheduleConfig {
	const windows = parseWindows(env.DEEPSEEK_PEAK_WINDOWS ?? DEFAULT_PEAK_WINDOWS_STR);
	let utcOffsetMinutes = 0;
	const offsetRaw = env.DEEPSEEK_UTC_OFFSET?.trim();
	if (offsetRaw !== undefined && offsetRaw !== "") {
		const hours = Number(offsetRaw);
		if (!Number.isFinite(hours) || hours < -14 || hours > 14) {
			throw new Error(`Invalid DEEPSEEK_UTC_OFFSET "${offsetRaw}" (expected hours, -14..14)`);
		}
		utcOffsetMinutes = Math.round(hours * 60);
	}
	return { windows, utcOffsetMinutes, peakWeekdays: DEFAULT_PEAK_WEEKDAYS };
}

export function loadProviderIds(env: Record<string, string | undefined>): readonly string[] {
	const raw = env.DEEPSEEK_PROVIDER_IDS?.trim();
	if (raw === undefined || raw === "") return DEFAULT_PROVIDER_IDS;
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Flash-series rate card (env-overridable, pure)
// ---------------------------------------------------------------------------

/** Off-peak unit prices for the Flash series, USD per 1M tokens. */
export interface FlashRates {
	/** Input, prompt cache hit. */
	cacheHit: number;
	/** Input, prompt cache miss. */
	cacheMiss: number;
	/** Output. */
	output: number;
}

/** Parse "hit,miss,output" (USD/1M, off-peak). Throws on invalid input. */
export function parseFlashRates(s: string): FlashRates {
	const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
	if (parts.length !== 3) {
		throw new Error(`DEEPSEEK_FLASH_RATES must be "hit,miss,output" (got "${s}")`);
	}
	const nums = parts.map(Number);
	if (!nums.every((n) => Number.isFinite(n) && n >= 0)) {
		throw new Error(`Invalid DEEPSEEK_FLASH_RATES "${s}" (expected non-negative numbers)`);
	}
	return { cacheHit: nums[0], cacheMiss: nums[1], output: nums[2] };
}

/** Load the rate card from env; missing/empty falls back to the defaults. */
export function loadFlashRates(env: Record<string, string | undefined>): FlashRates {
	const raw = env.DEEPSEEK_FLASH_RATES?.trim();
	if (raw === undefined || raw === "") return parseFlashRates(DEFAULT_FLASH_RATES_STR);
	return parseFlashRates(raw);
}

// ---------------------------------------------------------------------------
// Window state (pure)
// ---------------------------------------------------------------------------

function minutesInWindow(minutes: number, w: PeakWindow): boolean {
	if (w.endMin > w.startMin) {
		return minutes >= w.startMin && minutes < w.endMin;
	}
	// Wraps past midnight: [startMin, 24:00) ∪ [00:00, endMin)
	return minutes >= w.startMin || minutes < w.endMin;
}

/** True when the given weekday/minute (schedule tz) falls inside peak hours. */
export function isPeakAt(cfg: ScheduleConfig, weekday: number, minutes: number): boolean {
	if (!cfg.peakWeekdays.includes(weekday)) return false;
	return cfg.windows.some((w) => minutesInWindow(minutes, w));
}

export interface WindowState {
	/** True when now is inside a peak window. */
	peak: boolean;
	/** Real UTC instant of the next transition (strictly after now). */
	nextTransition: Date;
	/** Wall-clock time of the next transition in the schedule timezone. */
	nextTransitionTz: Date;
	/** Whether the period AFTER the next transition is peak. */
	nextIsPeak: boolean;
}

const DAY_MS = 86_400_000;
/** How many days ahead to scan for the next transition. */
const SCAN_DAYS = 10;

/**
 * Evaluate the billing state at `now` (real UTC instant).
 *
 * The schedule is evaluated in the schedule timezone (UTC + utcOffsetMinutes):
 * a window's weekday and wall-clock membership are taken from that tz, and
 * transition boundaries are converted back to real UTC instants.
 */
export function currentState(cfg: ScheduleConfig, now: Date): WindowState {
	const tzNow = new Date(now.getTime() + cfg.utcOffsetMinutes * 60_000);
	const weekday = tzNow.getUTCDay();
	const minutes = tzNow.getUTCHours() * 60 + tzNow.getUTCMinutes();
	const peak = isPeakAt(cfg, weekday, minutes);

	// Midnights (real UTC instants) of the next SCAN_DAYS days in the schedule
	// timezone: the wall-clock day containing now is given by tzNow's UTC fields,
	// and that day's midnight instant is offset back to real UTC.
	const dayStartReal = new Date(
		Date.UTC(tzNow.getUTCFullYear(), tzNow.getUTCMonth(), tzNow.getUTCDate()) -
			cfg.utcOffsetMinutes * 60_000,
	);

	let bestTs = Number.POSITIVE_INFINITY;
	let bestIsPeak = !peak;
	for (let d = 0; d < SCAN_DAYS; d++) {
		const dayStart = dayStartReal.getTime() + d * DAY_MS;
		// Weekday of this day in the schedule timezone (dayStart + offset is
		// exactly wall-clock midnight of the target day).
		const dayWeekday = new Date(dayStart + cfg.utcOffsetMinutes * 60_000).getUTCDay();
		if (!cfg.peakWeekdays.includes(dayWeekday)) continue;
		for (const w of cfg.windows) {
			const startTs = dayStart + w.startMin * 60_000;
			const endTs = dayStart + w.endMin * 60_000 + (w.endMin <= w.startMin ? DAY_MS : 0);
			for (const ts of [startTs, endTs]) {
				if (ts > now.getTime() && ts < bestTs) {
					bestTs = ts;
					bestIsPeak = ts === startTs;
				}
			}
		}
	}
	if (!Number.isFinite(bestTs)) {
		// Unreachable with the default weekday set; guard for pathological configs.
		bestTs = now.getTime() + DAY_MS;
		bestIsPeak = !peak;
	}
	const nextTransition = new Date(bestTs);
	return {
		peak,
		nextTransition,
		nextTransitionTz: new Date(bestTs + cfg.utcOffsetMinutes * 60_000),
		nextIsPeak: bestIsPeak,
	};
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "42m", "3h 12m", "2d 5h" — ceiling to whole minutes. */
export function formatCountdown(ms: number): string {
	const totalMin = Math.max(0, Math.ceil(ms / 60_000));
	if (totalMin < 1) return "<1m";
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh === 0 ? `${d}d` : `${d}d ${rh}h`;
}

/**
 * "HH:MM UTC" (or "HH:MM local" when a non-UTC schedule tz is configured),
 * prefixed with the weekday when the transition is not today.
 */
export function formatTarget(cfg: ScheduleConfig, tz: Date, nowTz: Date): string {
	const hh = String(tz.getUTCHours()).padStart(2, "0");
	const mm = String(tz.getUTCMinutes()).padStart(2, "0");
	const tzLabel = cfg.utcOffsetMinutes === 0 ? " UTC" : " local";
	const sameDay =
		tz.getUTCFullYear() === nowTz.getUTCFullYear() &&
		tz.getUTCMonth() === nowTz.getUTCMonth() &&
		tz.getUTCDate() === nowTz.getUTCDate();
	const day = sameDay ? "" : `${WEEKDAY_NAMES[tz.getUTCDay()]} `;
	return `${day}${hh}:${mm}${tzLabel}`;
}

/** "HH:MM" of a wall-clock time in the schedule tz, plus its weekday name. */
export function formatNow(cfg: ScheduleConfig, nowTz: Date): string {
	const hh = String(nowTz.getUTCHours()).padStart(2, "0");
	const mm = String(nowTz.getUTCMinutes()).padStart(2, "0");
	const tzLabel = cfg.utcOffsetMinutes === 0 ? " UTC" : " local";
	return `${hh}:${mm}${tzLabel} (${WEEKDAY_NAMES[nowTz.getUTCDay()]})`;
}

/** Compact badge shown in the footer: state + next transition + countdown. */
export function badgeText(state: WindowState, cfg: ScheduleConfig, now: Date): string {
	const nowTz = new Date(now.getTime() + cfg.utcOffsetMinutes * 60_000);
	const target = formatTarget(cfg, state.nextTransitionTz, nowTz);
	const countdown = formatCountdown(state.nextTransition.getTime() - now.getTime());
	if (state.peak) {
		return `DSK peak (2× off-peak) · off-peak ${target} in ${countdown}`;
	}
	return `DSK off-peak (-50%) · next peak ${target} in ${countdown}`;
}

/** "$0.003" — keep only the decimals the value actually needs (3 for sub-cent rates). */
function formatUsd(n: number): string {
	return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * Rate-card line shown by /deepseek-hours status: off-peak Flash unit prices
 * (USD per 1M tokens) with peak prices derived as 2x off-peak, e.g.
 * "Flash (per 1M tokens): off-peak $0.003 / $0.15 / $0.6 · peak $0.006 / $0.3 / $1.2".
 */
export function flashRatesText(r: FlashRates): string {
	return `Flash (per 1M tokens): off-peak ${formatUsd(r.cacheHit)} / ${formatUsd(r.cacheMiss)} / ${formatUsd(r.output)} · peak ${formatUsd(r.cacheHit * 2)} / ${formatUsd(r.cacheMiss * 2)} / ${formatUsd(r.output * 2)}`;
}

/** One-line human-readable status for the /deepseek-hours status command. */
export function statusText(
	state: WindowState,
	cfg: ScheduleConfig,
	now: Date,
	activeProvider: string | undefined,
	providerIds: readonly string[],
	rates?: FlashRates,
): string {
	const nowTz = new Date(now.getTime() + cfg.utcOffsetMinutes * 60_000);
	const target = formatTarget(cfg, state.nextTransitionTz, nowTz);
	const countdown = formatCountdown(state.nextTransition.getTime() - now.getTime());
	const stateStr = state.peak
		? "PEAK (2× off-peak rate)"
		: "OFF-PEAK (-50% off)";
	let text = `DeepSeek ${stateStr} · next ${state.nextIsPeak ? "peak" : "off-peak"} ${target} in ${countdown} · now ${formatNow(cfg, nowTz)}`;
	if (rates) text += ` · ${flashRatesText(rates)}`;
	if (activeProvider !== undefined && providerIds.includes(activeProvider)) return text;
	const note =
		activeProvider === undefined
			? `current provider: none — indicator hidden`
			: `current provider: ${activeProvider} (not ${providerIds.join("/")}) — indicator hidden`;
	return `${text} · ${note}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const BADGE_KEY = "deepseek-hours";
const TICK_MS = 30_000;

/** Persisted/requested mode; `full` is a deprecated alias for `badge`. */
type Mode = "badge" | "full" | "off";

/** The mode actually rendered: `full` resolves to `badge`. */
export type ActiveMode = "badge" | "off";

/** Resolve a requested mode to the one that renders (`full` -> `badge`). */
export function resolveMode(mode: Mode): ActiveMode {
	return mode === "full" ? "badge" : mode;
}

/** Agent dir (override with PI_CODING_AGENT_DIR), matching Pi's global layout. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
/** Mode state file (override with DEEPSEEK_HOURS_STATE for tests). */
const MODE_STATE_FILE = process.env.DEEPSEEK_HOURS_STATE ?? join(AGENT_DIR, "deepseek-hours", "mode.json");

/** Persisted mode from the state file; null means the default ("badge"). */
export function loadPersistedMode(file: string): Mode | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown };
		return parsed.mode === "badge" || parsed.mode === "full" || parsed.mode === "off" ? parsed.mode : null;
	} catch {
		return null;
	}
}

/** Persist the footer mode; null clears it back to the default. */
export function savePersistedMode(file: string, mode: Mode | null): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ mode }, null, 2), "utf8");
		renameSync(tmp, file);
	} catch (err) {
		console.warn(`[deepseek-hours] mode persist failed: ${(err as Error).message}`);
	}
}

let cfg: ScheduleConfig;
let providerIds: readonly string[];
let flashRates: FlashRates;
try {
	cfg = loadConfig(process.env as Record<string, string | undefined>);
	providerIds = loadProviderIds(process.env as Record<string, string | undefined>);
	flashRates = loadFlashRates(process.env as Record<string, string | undefined>);
} catch (err) {
	// Never break the extension loader on bad env vars — fall back to defaults.
	console.warn(`[deepseek-hours] invalid config, using defaults: ${(err as Error).message}`);
	cfg = { windows: parseWindows(DEFAULT_PEAK_WINDOWS_STR), utcOffsetMinutes: 0, peakWeekdays: DEFAULT_PEAK_WEEKDAYS };
	providerIds = DEFAULT_PROVIDER_IDS;
	flashRates = parseFlashRates(DEFAULT_FLASH_RATES_STR);
}

function isDeepseek(provider: string | undefined): boolean {
	return provider !== undefined && providerIds.includes(provider);
}

export default function deepseekHoursExtension(pi: ExtensionAPI): void {
	let mode: Mode = loadPersistedMode(MODE_STATE_FILE) ?? "badge";
	let currentCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastBadge = ""; // only call setStatus when the text actually changes

	function windowState(now: Date): WindowState {
		return currentState(cfg, now);
	}

	/** Sync the badge (mode "badge"). */
	function refreshBadge(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		const provider = ctx.model?.provider;
		if (!isDeepseek(provider)) {
			if (lastBadge !== "") {
				lastBadge = "";
				try {
					ctx.ui.setStatus(BADGE_KEY, undefined);
				} catch {
					/* ignore */
				}
			}
			return;
		}
		const now = new Date();
		const state = windowState(now);
		const text = badgeText(state, cfg, now);
		if (text === lastBadge) return;
		lastBadge = text;
		try {
			ctx.ui.setStatus(BADGE_KEY, ctx.ui.theme.fg(state.peak ? "warning" : "success", text));
		} catch {
			/* ignore */
		}
	}

	function tick(): void {
		if (mode !== "off") refreshBadge();
	}

	function startTimer(): void {
		if (timer) return;
		timer = setInterval(tick, TICK_MS);
	}

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	// --- mode switching ------------------------------------------------------

	function applyMode(next: Mode, ctx: ExtensionCommandContext, notify: boolean): void {
		mode = next;
		// `full` is a deprecated alias for `badge`: the built-in footer already
		// shows other extensions' statuses next to the badge.
		const active = resolveMode(mode);
		if (active === "off") {
			try {
				ctx.ui.setStatus(BADGE_KEY, undefined);
			} catch {
				/* ignore */
			}
			lastBadge = "";
		} else {
			refreshBadge();
		}
		if (notify) {
			const msg =
				active === "off"
					? "DeepSeek hours: indicator off"
					: mode === "full"
						? "DeepSeek hours: full footer mode is deprecated — using the badge (built-in footer)"
						: "DeepSeek hours: badge mode (built-in footer)";
			try {
				ctx.ui.notify(msg, "info");
			} catch {
				/* ignore */
			}
		}
	}

	// --- command ---------------------------------------------------------------

	const MODE_ARGS = ["badge", "full", "off", "status", "mode"] as const;
	const MODE_SUBS = ["badge", "full", "off", "reset"] as const;

	function notify(ctx: ExtensionCommandContext, msg: string, type: "info" | "warning" | "error" = "info"): void {
		try {
			ctx.ui.notify(msg, type);
		} catch {
			/* ignore */
		}
	}

	pi.registerCommand("deepseek-hours", {
		description:
			"DeepSeek peak/off-peak footer indicator: /deepseek-hours [badge|full|off|status] (no arg toggles badge on/off; /deepseek-hours mode [badge|full|off|reset] persists the mode)",
		getArgumentCompletions: async (prefix: string) => {
			const p = prefix.toLowerCase();
			if (p.startsWith("mode")) {
				const rest = p.slice(4).trim();
				const candidates = rest === "" ? MODE_SUBS : MODE_SUBS.filter((s) => s.startsWith(rest));
				const items = candidates.map((s) => ({ value: `mode ${s}`, label: `mode ${s}` }));
				return items.length > 0 ? items : null;
			}
			return MODE_ARGS.filter((m) => m.startsWith(p)).map((m) => ({ value: m, label: m }));
		},
		handler: async (rawArgs, ctx) => {
			currentCtx = ctx;
			const arg = rawArgs.trim().toLowerCase();

			// /deepseek-hours mode [badge|full|off|reset] — explicit, persisted.
			if (arg === "mode" || arg.startsWith("mode ")) {
				const sub = arg === "mode" ? "" : arg.slice(5).trim();
				if (sub === "") {
					const origin = loadPersistedMode(MODE_STATE_FILE) !== null ? "persisted" : "default";
					const shown = mode === "full" ? "badge (full deprecated)" : mode;
					notify(ctx, `DeepSeek hours mode: ${shown} (${origin})`, "info");
					return;
				}
				if (sub === "badge" || sub === "full" || sub === "off") {
					savePersistedMode(MODE_STATE_FILE, sub);
					applyMode(sub, ctx, true);
					return;
				}
				if (sub === "reset") {
					savePersistedMode(MODE_STATE_FILE, null);
					applyMode("badge", ctx, true);
					return;
				}
				notify(ctx, `/deepseek-hours mode: unknown "${sub}" — use badge, full, off or reset`, "warning");
				return;
			}

			if (arg === "") {
				const next = mode === "off" ? "badge" : "off";
				savePersistedMode(MODE_STATE_FILE, next);
				applyMode(next, ctx, true);
				return;
			}
			if (!MODE_ARGS.includes(arg as (typeof MODE_ARGS)[number])) {
				notify(ctx, `/deepseek-hours: unknown mode "${arg}" — use badge, full, off, mode or status`, "warning");
				return;
			}
			if (arg === "status") {
				const state = windowState(new Date());
				const active = ctx.model?.provider;
				notify(ctx, statusText(state, cfg, new Date(), active, providerIds, flashRates), "info");
				return;
			}
			savePersistedMode(MODE_STATE_FILE, arg as Mode);
			applyMode(arg as Mode, ctx, true);
		},
	});

	// --- lifecycle events -------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		startTimer();
		tick();
	});

	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
		tick();
	});

	pi.on("agent_end", (_event, ctx) => {
		currentCtx = ctx;
		tick();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		currentCtx = undefined;
		try {
			ctx.ui.setStatus(BADGE_KEY, undefined);
		} catch {
			/* ignore */
		}
		lastBadge = "";
	});
}
