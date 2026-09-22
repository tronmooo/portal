// shared/domain/wellness-window.ts — a score that survives midnight.
//
// The Wellness score read only readings fresh TODAY, so at 00:01 every
// component except sleep went null and the tile said "—" until something was
// logged. This module turns a series of daily scores into one headline with
// a basis the user can read: today's reading, a rolling 7-day average, or the
// last known value with its age.
//
// Pure. Pinned by tests/consistency-layer-wellness.test.ts.

export interface DailyScore { date: string; score: number }

export type WellnessBasis = "today" | "rolling" | "last_known" | "none";

export interface WellnessReadout {
  score: number | null;
  basis: WellnessBasis;
  /** "Based on last 7 days" / "Today" / "Last reading 3 days ago" / "No data yet". */
  label: string;
  windowDays: number;
  /** Days since the newest reading; null when there is none. */
  daysSinceLatest: number | null;
  /** True when the newest reading is older than the window. */
  stale: boolean;
  /** Days that contributed to a rolling score. */
  daysUsed: number;
}

export interface WellnessWindowOptions {
  todayISO: string;
  /** Rolling window length. Default 7. */
  windowDays?: number;
  /** Prefer today's own reading when present. Default true. */
  preferToday?: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}

export function rollingWellness(daily: readonly DailyScore[], opts: WellnessWindowOptions): WellnessReadout {
  const windowDays = opts.windowDays ?? 7;
  const rows = daily
    .filter((d) => d && DAY_RE.test(String(d.date)) && Number.isFinite(d.score) && d.date <= opts.todayISO)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) {
    return { score: null, basis: "none", label: "No data yet", windowDays, daysSinceLatest: null, stale: true, daysUsed: 0 };
  }
  const latest = rows[rows.length - 1];
  const daysSinceLatest = daysBetween(latest.date, opts.todayISO);
  const inWindow = rows.filter((d) => daysBetween(d.date, opts.todayISO) < windowDays);
  if (opts.preferToday !== false && latest.date === opts.todayISO && inWindow.length === 1) {
    return { score: Math.round(latest.score), basis: "today", label: "Today", windowDays, daysSinceLatest: 0, stale: false, daysUsed: 1 };
  }
  if (inWindow.length > 0) {
    const avg = inWindow.reduce((s, d) => s + d.score, 0) / inWindow.length;
    return { score: Math.round(avg), basis: "rolling", label: `Based on last ${windowDays} days`, windowDays, daysSinceLatest, stale: false, daysUsed: inWindow.length };
  }
  return {
    score: Math.round(latest.score), basis: "last_known",
    label: `Last reading ${daysSinceLatest} day${daysSinceLatest === 1 ? "" : "s"} ago`,
    windowDays, daysSinceLatest, stale: true, daysUsed: 1,
  };
}

/** What a streak counts — spelled out so "12-day streak" is never ambiguous. */
export function describeStreak(kind: "habit" | "tracker" | "journal" | "wellness", name: string, days: number): string {
  const n = `${days} day${days === 1 ? "" : "s"}`;
  switch (kind) {
    case "habit": return `${name} completed ${n} in a row`;
    case "tracker": return `${name} logged ${n} in a row`;
    case "journal": return `Journal written ${n} in a row`;
    case "wellness": return `Wellness data recorded ${n} in a row`;
  }
}
