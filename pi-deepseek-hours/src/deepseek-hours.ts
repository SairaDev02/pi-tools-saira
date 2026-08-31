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
 * Modes (toggle with /deepseek-hours):
 *   badge  (default)  colored status item in the built-in footer
 *   full               replaces the footer with a custom component that also
 *                      shows token usage, model, branch and other extension
 *                      statuses (so the ci badge etc. stay visible)
 *   off                no indicator
 *   status             print the current window state as plain text
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
 *
 * The pure schedule/format logic lives in exported functions so the tests
 * (tests/deepseek-hours.test.ts) run with plain node, no pi runtime needed.
 */

import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Schedule facts (official, as of the pricing page above)
// ---------------------------------------------------------------------------

/** Default peak windows: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
export const DEFAULT_PEAK_WINDOWS_STR = "01:00-04:00,06:00-10:00";
/** JS Date.getDay() values that count as peak weekdays (1=Mon .. 5=Fri). */
export const DEFAULT_PEAK_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
export const DEFAULT_PROVIDER_IDS: readonly string[] = ["deepseek"];

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

/** One-line human-readable status for the /deepseek-hours status command. */
export function statusText(
	state: WindowState,
	cfg: ScheduleConfig,
	now: Date,
	activeProvider: string | undefined,
	providerIds: readonly string[],
): string {
	const nowTz = new Date(now.getTime() + cfg.utcOffsetMinutes * 60_000);
	const target = formatTarget(cfg, state.nextTransitionTz, nowTz);
	const countdown = formatCountdown(state.nextTransition.getTime() - now.getTime());
	const stateStr = state.peak
		? "PEAK (2× off-peak rate)"
		: "OFF-PEAK (-50% off)";
	const base = `DeepSeek ${stateStr} · next ${state.nextIsPeak ? "peak" : "off-peak"} ${target} in ${countdown} · now ${formatNow(cfg, nowTz)}`;
	if (activeProvider !== undefined && providerIds.includes(activeProvider)) return base;
	const note =
		activeProvider === undefined
			? `current provider: none — indicator hidden`
			: `current provider: ${activeProvider} (not ${providerIds.join("/")}) — indicator hidden`;
	return `${base} · ${note}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const BADGE_KEY = "deepseek-hours";
const TICK_MS = 30_000;
const MIN_PAD = 2;

type Mode = "badge" | "full" | "off";

let cfg: ScheduleConfig;
let providerIds: readonly string[];
try {
	cfg = loadConfig(process.env as Record<string, string | undefined>);
	providerIds = loadProviderIds(process.env as Record<string, string | undefined>);
} catch (err) {
	// Never break the extension loader on bad env vars — fall back to defaults.
	console.warn(`[deepseek-hours] invalid config, using defaults: ${(err as Error).message}`);
	cfg = { windows: parseWindows(DEFAULT_PEAK_WINDOWS_STR), utcOffsetMinutes: 0, peakWeekdays: DEFAULT_PEAK_WEEKDAYS };
	providerIds = DEFAULT_PROVIDER_IDS;
}

function isDeepseek(provider: string | undefined): boolean {
	return provider !== undefined && providerIds.includes(provider);
}

export default function deepseekHoursExtension(pi: ExtensionAPI): void {
	let mode: Mode = "badge";
	let currentCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastBadge = ""; // only call setStatus when the text actually changes
	let footerTui: { requestRender(): void } | undefined;
	let lastFullKey = "";

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

	/** Sync the full footer (mode "full") — re-render only when content changed. */
	function refreshFull(): void {
		if (!footerTui) return;
		const provider = currentCtx?.model?.provider;
		const state = windowState(new Date());
		const key = JSON.stringify([
			currentCtx?.model?.id,
			currentCtx?.model?.provider,
			isDeepseek(provider) ? badgeText(state, cfg, new Date()) : "",
		]);
		if (key === lastFullKey) return;
		lastFullKey = key;
		try {
			footerTui.requestRender();
		} catch {
			/* ignore */
		}
	}

	function tick(): void {
		if (mode === "badge") refreshBadge();
		else if (mode === "full") refreshFull();
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

	// --- footer component (mode "full") ------------------------------------

	function setFullFooter(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			lastFullKey = "";
			return {
				invalidate() {},
				dispose() {
					if (footerTui === tui) footerTui = undefined;
				},
				render(width: number): string[] {
					return renderFullFooter(theme, footerData, width);
				},
			};
		});
	}

	function renderFullFooter(theme: Theme, footerData: ReadonlyFooterDataProvider, width: number): string[] {
		const ctx = currentCtx;
		const model = ctx?.model;
		const lines: string[] = [];

		// Line 1: cwd + branch + session name (dim).
		let pwd = ctx?.cwd ? formatCwd(ctx.cwd) : "";
		const branch = footerData.getGitBranch();
		if (branch) pwd = pwd ? `${pwd} (${branch})` : branch;
		const sessionName = ctx?.sessionManager.getSessionName();
		if (sessionName) pwd = pwd ? `${pwd} • ${sessionName}` : sessionName;
		lines.push(truncateToWidth(theme.fg("dim", pwd || "(no cwd)"), width, theme.fg("dim", "...")));

		// Line 2: token stats left, model + DeepSeek window right.
		let input = 0,
			output = 0,
			cost = 0;
		for (const e of ctx?.sessionManager.getBranch() ?? []) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cost += m.usage.cost.total;
			}
		}
		const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
		const statsParts: string[] = [];
		if (input) statsParts.push(`↑${fmt(input)}`);
		if (output) statsParts.push(`↓${fmt(output)}`);
		if (cost || input || output) statsParts.push(`$${cost.toFixed(3)}`);
		const ctxUsage = ctx?.getContextUsage();
		if (ctxUsage && ctxUsage.tokens !== null && model) {
			const pct = Math.round((ctxUsage.tokens / ctxUsage.contextWindow) * 100);
			statsParts.push(`${pct}%/${fmt(ctxUsage.contextWindow)}`);
		}
		const statsLeft = theme.fg("dim", statsParts.join(" ") || "∅");

		let rightSide = "";
		if (model) {
			const label = footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ${model.id}` : model.id;
			rightSide = theme.fg("dim", label);
		}
		if (isDeepseek(model?.provider)) {
			const state = windowState(new Date());
			const color = state.peak ? "warning" : "success";
			rightSide += ` ${theme.fg(color, badgeText(state, cfg, new Date()))}`;
		}

		const statsLeftWidth = visibleWidth(statsLeft);
		const rightWidth = visibleWidth(rightSide);
		const pad = " ".repeat(Math.max(MIN_PAD, width - statsLeftWidth - rightWidth));
		lines.push(truncateToWidth(statsLeft + pad + rightSide, width));

		// Line 3: other extension statuses (ci badge etc.), sorted by key.
		const statuses = footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			const sorted = Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, t]) => sanitizeStatus(t));
			lines.push(truncateToWidth(sorted.join(" "), width, theme.fg("dim", "...")));
		}
		return lines;
	}

	function formatCwd(cwd: string): string {
		const home = homedir();
		return cwd === home ? "~" : cwd.startsWith(home + "\\") || cwd.startsWith(home + "/") ? `~${cwd.slice(home.length)}` : cwd;
	}

	function sanitizeStatus(text: string): string {
		return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	}

	// --- mode switching ------------------------------------------------------

	function applyMode(next: Mode, ctx: ExtensionCommandContext, notify: boolean): void {
		mode = next;
		if (mode !== "full") {
			// Restore the built-in footer if we replaced it.
			try {
				ctx.ui.setFooter(undefined);
			} catch {
				/* ignore */
			}
			footerTui = undefined;
			lastFullKey = "";
		}
		if (mode !== "badge") {
			try {
				ctx.ui.setStatus(BADGE_KEY, undefined);
			} catch {
				/* ignore */
			}
			lastBadge = "";
		}
		if (mode === "full") setFullFooter();
		else refreshBadge();
		if (notify) {
			const msg =
				mode === "badge"
					? "DeepSeek hours: badge mode (built-in footer)"
					: mode === "full"
						? "DeepSeek hours: full footer mode"
						: "DeepSeek hours: indicator off";
			try {
				ctx.ui.notify(msg, "info");
			} catch {
				/* ignore */
			}
		}
	}

	// --- command ---------------------------------------------------------------

	const MODE_ARGS = ["badge", "full", "off", "status"] as const;

	pi.registerCommand("deepseek-hours", {
		description:
			"DeepSeek peak/off-peak footer indicator: /deepseek-hours [badge|full|off|status] (no arg toggles badge on/off)",
		getArgumentCompletions: async (prefix: string) => {
			const p = prefix.toLowerCase();
			return MODE_ARGS.filter((m) => m.startsWith(p)).map((m) => ({ value: m, label: m }));
		},
		handler: async (rawArgs, ctx) => {
			currentCtx = ctx;
			const arg = rawArgs.trim().toLowerCase();
			if (arg === "") {
				applyMode(mode === "off" ? "badge" : "off", ctx, true);
				return;
			}
			if (!MODE_ARGS.includes(arg as (typeof MODE_ARGS)[number])) {
				try {
					ctx.ui.notify(
						`/deepseek-hours: unknown mode "${arg}" — use badge, full, off or status`,
						"warning",
					);
				} catch {
					/* ignore */
				}
				return;
			}
			if (arg === "status") {
				const state = windowState(new Date());
				const active = ctx.model?.provider;
				try {
					ctx.ui.notify(statusText(state, cfg, new Date(), active, providerIds), "info");
				} catch {
					/* ignore */
				}
				return;
			}
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
		// Token stats changed — re-render the full footer if in full mode.
		if (mode === "full" && footerTui) {
			try {
				footerTui.requestRender();
			} catch {
				/* ignore */
			}
		}
		tick();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		currentCtx = undefined;
		try {
			ctx.ui.setStatus(BADGE_KEY, undefined);
			ctx.ui.setFooter(undefined);
		} catch {
			/* ignore */
		}
		footerTui = undefined;
		lastBadge = "";
		lastFullKey = "";
	});
}
