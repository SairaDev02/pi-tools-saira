/**
 * Functional tests for pi-deepseek-hours core logic.
 * Run: node --experimental-strip-types tests/deepseek-hours.test.ts
 *
 * Covers config parsing, window membership, next-transition computation
 * (weekdays, weekends, wrap-around windows, timezone offsets) and the
 * formatting helpers — all pure functions, no pi runtime needed.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	badgeText,
	currentState,
	flashRatesText,
	formatCountdown,
	formatNow,
	formatTarget,
	isPeakAt,
	loadConfig,
	loadFlashRates,
	loadPersistedMode,
	loadProviderIds,
	parseFlashRates,
	parseWindows,
	savePersistedMode,
	statusText,
	type FlashRates,
	type ScheduleConfig,
} from "../src/deepseek-hours.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name} ${extra}`);
	}
}

const UTC = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo, d, h, mi));

// --- 1. parseWindows -------------------------------------------------------
console.log("\n== parseWindows ==");

{
	const w = parseWindows("01:00-04:00,06:00-10:00");
	check("default string -> 2 windows", w.length === 2, JSON.stringify(w));
	check("window 1 start 60", w[0].startMin === 60);
	check("window 1 end 240", w[0].endMin === 240);
	check("window 2 start 360", w[1].startMin === 360);
	check("window 2 end 600", w[1].endMin === 600);
}

{
	const w = parseWindows("22:00-02:00");
	check("wrapping window parses", w.length === 1 && w[0].startMin === 1320 && w[0].endMin === 120, JSON.stringify(w));
}

{
	let threw = false;
	try {
		parseWindows("25:00-26:00");
	} catch {
		threw = true;
	}
	check("out-of-range times throw", threw);
}

{
	let threw = false;
	try {
		parseWindows("");
	} catch {
		threw = true;
	}
	check("empty windows string throws", threw);
}

{
	let threw = false;
	try {
		parseWindows("01:00");
	} catch {
		threw = true;
	}
	check("malformed window throws", threw);
}

// --- 2. loadConfig / loadProviderIds ---------------------------------------
console.log("\n== loadConfig ==");

{
	const cfg = loadConfig({});
	check("defaults: offset 0", cfg.utcOffsetMinutes === 0);
	check("defaults: 2 windows", cfg.windows.length === 2);
	check("defaults: Mon-Fri weekdays", JSON.stringify(cfg.peakWeekdays) === JSON.stringify([1, 2, 3, 4, 5]));
}

{
	const cfg = loadConfig({ DEEPSEEK_UTC_OFFSET: "8" });
	check("offset +8 -> 480 min", cfg.utcOffsetMinutes === 480);
	const cfg2 = loadConfig({ DEEPSEEK_UTC_OFFSET: "-5.5" });
	check("offset -5.5 -> -330 min", cfg2.utcOffsetMinutes === -330);
}

{
	let threw = false;
	try {
		loadConfig({ DEEPSEEK_UTC_OFFSET: "abc" });
	} catch {
		threw = true;
	}
	check("invalid offset throws", threw);
}

{
	const cfg = loadConfig({ DEEPSEEK_PEAK_WINDOWS: "02:00-03:00" });
	check("window override applies", cfg.windows.length === 1 && cfg.windows[0].startMin === 120 && cfg.windows[0].endMin === 180);
}

{
	check("provider ids default", JSON.stringify(loadProviderIds({})) === JSON.stringify(["deepseek"]));
	check("provider ids override", JSON.stringify(loadProviderIds({ DEEPSEEK_PROVIDER_IDS: "deepseek,deepseek2" })) === JSON.stringify(["deepseek", "deepseek2"]));
	check("provider ids empty -> default", JSON.stringify(loadProviderIds({ DEEPSEEK_PROVIDER_IDS: "  " })) === JSON.stringify(["deepseek"]));
}

// --- 3. isPeakAt ------------------------------------------------------------
console.log("\n== isPeakAt ==");
const cfg: ScheduleConfig = {
	windows: parseWindows("01:00-04:00,06:00-10:00"),
	utcOffsetMinutes: 0,
	peakWeekdays: [1, 2, 3, 4, 5],
};

check("Mon 01:00 peak", isPeakAt(cfg, 1, 60));
check("Mon 01:30 peak", isPeakAt(cfg, 1, 90));
check("Mon 03:59 peak", isPeakAt(cfg, 1, 239));
check("Mon 04:00 NOT peak (end exclusive)", !isPeakAt(cfg, 1, 240));
check("Mon 05:00 NOT peak", !isPeakAt(cfg, 1, 300));
check("Mon 06:00 peak", isPeakAt(cfg, 1, 360));
check("Mon 09:59 peak", isPeakAt(cfg, 1, 599));
check("Mon 10:00 NOT peak (end exclusive)", !isPeakAt(cfg, 1, 600));
check("Mon 00:30 NOT peak", !isPeakAt(cfg, 1, 30));
check("Sun 08:00 NOT peak (weekend)", !isPeakAt(cfg, 0, 480));
check("Sat 02:00 NOT peak (weekend)", !isPeakAt(cfg, 6, 120));

{
	// Wrapping window 22:00-02:00
	const wrap: ScheduleConfig = { windows: parseWindows("22:00-02:00"), utcOffsetMinutes: 0, peakWeekdays: [1, 2, 3, 4, 5] };
	check("wrap: Tue 23:00 peak", isPeakAt(wrap, 2, 1380));
	check("wrap: Wed 01:00 peak", isPeakAt(wrap, 3, 60));
	check("wrap: Wed 02:00 NOT peak", !isPeakAt(wrap, 3, 120));
	check("wrap: Wed 03:00 NOT peak", !isPeakAt(wrap, 3, 180));
}

// --- 4. currentState ---------------------------------------------------------
console.log("\n== currentState ==");

// 2026-08-17 is a Monday; 2026-08-16 is a Sunday.
check("2026-08-17 is Monday", UTC(2026, 7, 17).getUTCDay() === 1, String(UTC(2026, 7, 17).getUTCDay()));

{
	const st = currentState(cfg, UTC(2026, 7, 17, 2, 0)); // Mon 02:00 UTC
	check("Mon 02:00 peak", st.peak);
	check("next transition 04:00 UTC", st.nextTransition.getTime() === UTC(2026, 7, 17, 4, 0).getTime(), st.nextTransition.toISOString());
	check("after next is off-peak", st.nextIsPeak === false);
}

{
	const st = currentState(cfg, UTC(2026, 7, 17, 4, 30)); // Mon 04:30 UTC
	check("Mon 04:30 NOT peak", !st.peak);
	check("next transition 06:00 UTC", st.nextTransition.getTime() === UTC(2026, 7, 17, 6, 0).getTime(), st.nextTransition.toISOString());
	check("after next is peak", st.nextIsPeak === true);
}

{
	const st = currentState(cfg, UTC(2026, 7, 17, 23, 0)); // Mon 23:00 UTC
	check("Mon 23:00 NOT peak", !st.peak);
	check("next transition Tue 01:00 UTC", st.nextTransition.getTime() === UTC(2026, 7, 18, 1, 0).getTime(), st.nextTransition.toISOString());
}

{
	const st = currentState(cfg, UTC(2026, 7, 16, 12, 0)); // Sun 12:00 UTC — weekend
	check("Sun 12:00 NOT peak (weekend)", !st.peak);
	check("weekend -> next peak Mon 01:00 UTC", st.nextTransition.getTime() === UTC(2026, 7, 17, 1, 0).getTime(), st.nextTransition.toISOString());
	check("after weekend transition is peak", st.nextIsPeak === true);
}

{
	const st = currentState(cfg, UTC(2026, 7, 21, 12, 0)); // Fri 12:00 UTC
	check("Fri 12:00 NOT peak", !st.peak);
	check("Fri evening -> next peak Mon 01:00 UTC", st.nextTransition.getTime() === UTC(2026, 7, 24, 1, 0).getTime(), st.nextTransition.toISOString());
}

{
	// UTC+8 schedule: Beijing Mon 01:00 == UTC Sun 17:00.
	const c8: ScheduleConfig = { windows: parseWindows("01:00-04:00"), utcOffsetMinutes: 480, peakWeekdays: [1, 2, 3, 4, 5] };
	const st = currentState(c8, UTC(2026, 7, 16, 17, 0)); // Sun 17:00 UTC
	check("UTC+8: Beijing Mon 01:00 is peak", st.peak);
	check("UTC+8: next transition Beijing 04:00 == UTC 20:00", st.nextTransition.getTime() === UTC(2026, 7, 16, 20, 0).getTime(), st.nextTransition.toISOString());
}

// --- 5. formatting -----------------------------------------------------------
console.log("\n== formatCountdown / formatTarget / formatNow ==");

check("countdown 0 -> <1m", formatCountdown(0) === "<1m");
check("countdown 30s -> 1m", formatCountdown(30_000) === "1m");
check("countdown 90s -> 2m", formatCountdown(90_000) === "2m");
check("countdown 1h -> 1h", formatCountdown(3_600_000) === "1h");
check("countdown 1h5m -> 1h 5m", formatCountdown(3_900_000) === "1h 5m");
check("countdown 24h -> 1d", formatCountdown(86_400_000) === "1d");
check("countdown 25h -> 1d 1h", formatCountdown(90_000_000) === "1d 1h");

{
	const tz = UTC(2026, 7, 17, 4, 0);
	const nowTz = UTC(2026, 7, 17, 2, 0);
	check("target same day -> 04:00 UTC", formatTarget(cfg, tz, nowTz) === "04:00 UTC", formatTarget(cfg, tz, nowTz));
	const tz2 = UTC(2026, 7, 18, 1, 0);
	const nowTz2 = UTC(2026, 7, 17, 12, 0);
	check("target next day -> Tue 01:00 UTC", formatTarget(cfg, tz2, nowTz2) === "Tue 01:00 UTC", formatTarget(cfg, tz2, nowTz2));
}

{
	const c8: ScheduleConfig = { windows: parseWindows("01:00-04:00"), utcOffsetMinutes: 480, peakWeekdays: [1, 2, 3, 4, 5] };
	const tz = UTC(2026, 7, 17, 4, 0); // Beijing wall clock 04:00 (stored in UTC fields)
	const nowTz = UTC(2026, 7, 17, 1, 0);
	check("non-UTC tz label -> 04:00 local", formatTarget(c8, tz, nowTz) === "04:00 local", formatTarget(c8, tz, nowTz));
	check("formatNow -> 01:00 local (Mon)", formatNow(c8, nowTz) === "01:00 local (Mon)", formatNow(c8, nowTz));
}

// --- 6. badgeText / statusText -------------------------------------------------
console.log("\n== badgeText / statusText ==");

{
	const st = currentState(cfg, UTC(2026, 7, 17, 2, 0)); // Mon 02:00 UTC — peak
	const text = badgeText(st, cfg, UTC(2026, 7, 17, 2, 0));
	check("badge (peak) has state", text.includes("DSK peak (2× off-peak)"), text);
	check("badge (peak) has target", text.includes("off-peak 04:00 UTC"), text);
	check("badge (peak) has countdown", text.includes("in 2h"), text);
}

{
	const st = currentState(cfg, UTC(2026, 7, 17, 4, 30)); // Mon 04:30 UTC — off-peak
	const text = badgeText(st, cfg, UTC(2026, 7, 17, 4, 30));
	check("badge (off-peak) has state", text.includes("DSK off-peak (-50%)"), text);
	check("badge (off-peak) has target", text.includes("next peak 06:00 UTC"), text);
}

{
	const st = currentState(cfg, UTC(2026, 7, 16, 0, 30)); // Sun 00:30 UTC — weekend off-peak
	const text = badgeText(st, cfg, UTC(2026, 7, 16, 0, 30));
	check("weekend badge -> Mon 01:00 UTC", text.includes("Mon 01:00 UTC"), text);
	check("weekend badge countdown ~ days", text.includes("in 1d"), text);
}

{
	const st = currentState(cfg, UTC(2026, 7, 17, 2, 0));
	const active = statusText(st, cfg, UTC(2026, 7, 17, 2, 0), "deepseek", ["deepseek"]);
	check("status (active) mentions PEAK", active.includes("DeepSeek PEAK"), active);
	check("status (active) no hidden note", !active.includes("indicator hidden"), active);
	const inactive = statusText(st, cfg, UTC(2026, 7, 17, 2, 0), "anthropic", ["deepseek"]);
	check("status (inactive) has provider note", inactive.includes("anthropic") && inactive.includes("indicator hidden"), inactive);
}

// --- 7. Flash-series rate card ---------------------------------------------
console.log("\n== flash rate card ==");

const FLASH_DEFAULTS: FlashRates = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };

{
	const r = parseFlashRates("0.003,0.15,0.6");
	check("parse default rates", r.cacheHit === 0.003 && r.cacheMiss === 0.15 && r.output === 0.6, JSON.stringify(r));
	check("loadFlashRates: missing -> defaults", JSON.stringify(loadFlashRates({})) === JSON.stringify(FLASH_DEFAULTS));
	check("loadFlashRates: empty -> defaults", JSON.stringify(loadFlashRates({ DEEPSEEK_FLASH_RATES: "  " })) === JSON.stringify(FLASH_DEFAULTS));
	check("loadFlashRates: override", JSON.stringify(loadFlashRates({ DEEPSEEK_FLASH_RATES: "0.007,0.22,0.66" })) === JSON.stringify({ cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }));
}

{
	let threw = false;
	try {
		parseFlashRates("0.003,0.15");
	} catch {
		threw = true;
	}
	check("malformed rates (2 values) throw", threw);
	threw = false;
	try {
		parseFlashRates("a,b,c");
	} catch {
		threw = true;
	}
	check("malformed rates (non-numeric) throw", threw);
	threw = false;
	try {
		parseFlashRates("");
	} catch {
		threw = true;
	}
	check("empty rates string throws", threw);
	threw = false;
	try {
		loadFlashRates({ DEEPSEEK_FLASH_RATES: "a,b,c" });
	} catch {
		threw = true;
	}
	check("loadFlashRates: invalid -> throws", threw);
}

{
	const r = parseFlashRates("0.003,0.15,0.6");
	const text = flashRatesText(r);
	check("rates text shows off-peak prices", text.includes("off-peak $0.003 / $0.15 / $0.6"), text);
	check("rates text derives peak as 2x off-peak", text.includes("peak $0.006 / $0.3 / $1.2"), text);
}

{
	const st = currentState(cfg, UTC(2026, 7, 17, 2, 0)); // Mon 02:00 UTC — peak
	const rates = parseFlashRates("0.003,0.15,0.6");
	const active = statusText(st, cfg, UTC(2026, 7, 17, 2, 0), "deepseek", ["deepseek"], rates);
	check("status (active) includes rate card", active.includes("Flash (per 1M tokens)"), active);
	check("status (active) shows an off-peak price", active.includes("$0.15"), active);
	const plain = statusText(st, cfg, UTC(2026, 7, 17, 2, 0), "deepseek", ["deepseek"]);
	check("status without rates is unchanged", !plain.includes("Flash (per 1M tokens)"), plain);
}

// --- 8. mode persistence -----------------------------------------------------
console.log("\n== mode persistence ==");

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-mode-"));
const stateFile = path.join(stateDir, "mode.json");
check("loadPersistedMode: missing -> null", loadPersistedMode(stateFile) === null);
savePersistedMode(stateFile, "full");
check("loadPersistedMode: roundtrip full", loadPersistedMode(stateFile) === "full");
savePersistedMode(stateFile, "off");
check("loadPersistedMode: roundtrip off", loadPersistedMode(stateFile) === "off");
savePersistedMode(stateFile, null);
check("loadPersistedMode: cleared -> null", loadPersistedMode(stateFile) === null);
await fs.writeFile(stateFile, JSON.stringify({ mode: "badge" }), "utf8");
check("loadPersistedMode: badge", loadPersistedMode(stateFile) === "badge");
await fs.writeFile(stateFile, JSON.stringify({ mode: "sometimes" }), "utf8");
check("loadPersistedMode: invalid -> null", loadPersistedMode(stateFile) === null);
await fs.rm(stateDir, { recursive: true, force: true });

// -----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
