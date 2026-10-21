// client/src/lib/habit-visuals.ts — what the Habits page draws.
//
// Pure, no I/O. Every "is this day done / scheduled?" question is answered by
// shared/habit-progress.ts (habitDayProgress), and streaks are the server's
// figures (habit.currentStreak / habit.longestStreak, computed by
// shared/streak.ts). This module only aggregates those answers over a window
// and picks colors — it never re-decides completion or recomputes a streak.

import { habitDayProgress, type HabitProgressShape } from "@shared/habit-progress";
import { dayKeyOf, dayLabel, shiftDay, type DayPoint } from "@shared/tracker-analytics";

// ── Time frame ───────────────────────────────────────────────────────────────

export type HabitRange = "7d" | "30d" | "90d";
export const HABIT_RANGE_DAYS: Record<HabitRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
export const HABIT_RANGE_OPTIONS: ReadonlyArray<{ value: HabitRange; label: string }> = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
];

// ── Color ────────────────────────────────────────────────────────────────────

/** The page's accent pair: habits are green across the app (HABITS_ACCENT on the
 *  page header, the Executive and Wellness habit cards), so the summary is too. */
export const HABITS_HS: readonly [string, string] = ["155 65%", "178 70%"];

/** Accent pairs ("H S%") for habits without a color of their own. */
export const HABIT_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["265 75%", "300 68%"],
  ["152 62%", "178 70%"],
  ["200 85%", "225 80%"],
  ["24 92%", "350 82%"],
  ["330 72%", "280 62%"],
  ["38 92%", "15 88%"],
  ["190 75%", "245 70%"],
  ["350 78%", "15 85%"],
];

/** The color a habit is created with — not a choice, so it gets a palette color. */
const DEFAULT_HABIT_COLOR = "#4f98a3";

/** "#E8545A" → { h: 358, s: 76 }; null for anything that isn't a hex color. */
export function hexToHueSat(hex: string | null | undefined): { h: number; s: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const raw = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s: Math.round(s * 100) };
}

/** Stable small hash so a habit keeps its palette slot across renders and devices. */
function stableIndex(id: string, n: number): number {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) >>> 0;
  return x % n;
}

/**
 * The habit's accent as an "H S%" pair, rendered through tone() so lightness
 * adapts to light/dark mode. A chosen hex color keeps its hue (saturation is
 * clamped so a muted pick still reads as a color); the default color or a
 * grey falls back to a fixed palette slot picked by id.
 */
export function habitAccent(habit: { id: string; color?: string | null }): { hs: string; hs2: string } {
  const color = String(habit.color ?? "").trim().toLowerCase();
  const hsv = color && color !== DEFAULT_HABIT_COLOR ? hexToHueSat(color) : null;
  if (hsv && hsv.s >= 12) {
    const s = Math.max(55, Math.min(90, hsv.s));
    return { hs: `${hsv.h} ${s}%`, hs2: `${(hsv.h + 35) % 360} ${s}%` };
  }
  const [hs, hs2] = HABIT_PALETTE[stableIndex(String(habit.id || ""), HABIT_PALETTE.length)];
  return { hs, hs2 };
}

// ── Windows ──────────────────────────────────────────────────────────────────

export interface HabitWindowShape extends HabitProgressShape {
  createdAt?: string | null;
}

/**
 * The first day a habit can be judged on: its creation day, pulled earlier by
 * a back-dated check-in. A habit created last week is not "3% complete over
 * 90 days" — the days before it existed are not misses.
 */
export function habitFirstDay(habit: HabitWindowShape, tz: string): string | null {
  let first: string | null = null;
  if (habit.createdAt) {
    const t = new Date(habit.createdAt);
    if (!Number.isNaN(t.getTime())) first = dayKeyOf(t, tz);
  }
  for (const c of habit.checkins || []) {
    const d = String(c?.date ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!first || d < first)) first = d;
  }
  return first;
}

export interface HabitCompletion {
  /** Scheduled days in the window that are settled (over, or done today). */
  scheduled: number;
  /** Of those, days whose target was met. */
  complete: number;
  /** Whole percent, or null when nothing in the window could be judged yet. */
  percent: number | null;
}

/**
 * Share of scheduled days in the last `days` (ending today) whose target was
 * met, per habitDayProgress. Today counts only once it's complete — an open
 * day isn't a miss yet, so checking in mid-morning never drags the rate down.
 */
export function habitCompletion(habit: HabitWindowShape, today: string, days: number, tz: string): HabitCompletion {
  const first = habitFirstDay(habit, tz);
  let scheduled = 0, complete = 0;
  for (let i = days - 1; i >= 0; i--) {
    const day = shiftDay(today, -i);
    if (first && day < first) continue;
    const p = habitDayProgress(habit, day);
    if (!p.isScheduled) continue;
    if (day === today && !p.isComplete) continue;
    scheduled++;
    if (p.isComplete) complete++;
  }
  return { scheduled, complete, percent: scheduled > 0 ? Math.round((complete / scheduled) * 100) : null };
}

/** The same rate across several habits: every habit-day weighs the same. */
export function habitsCompletion(habits: readonly HabitWindowShape[], today: string, days: number, tz: string): HabitCompletion {
  let scheduled = 0, complete = 0;
  for (const h of habits || []) {
    const c = habitCompletion(h, today, days, tz);
    scheduled += c.scheduled;
    complete += c.complete;
  }
  return { scheduled, complete, percent: scheduled > 0 ? Math.round((complete / scheduled) * 100) : null };
}

/**
 * One point per finished day (yesterday back `days`) that had at least one
 * habit scheduled: value = % of those habits whose target was met. Today is
 * left off — it isn't over, and the hero's ring already shows it.
 */
export function dailyCompletionSeries(habits: readonly HabitWindowShape[], today: string, days: number, tz: string): DayPoint[] {
  const firsts = (habits || []).map((h) => habitFirstDay(h, tz));
  const out: DayPoint[] = [];
  for (let i = days; i >= 1; i--) {
    const day = shiftDay(today, -i);
    let scheduled = 0, complete = 0;
    (habits || []).forEach((h, idx) => {
      const first = firsts[idx];
      if (first && day < first) return;
      const p = habitDayProgress(h, day);
      if (!p.isScheduled) return;
      scheduled++;
      if (p.isComplete) complete++;
    });
    if (scheduled === 0) continue;
    out.push({ day, label: dayLabel(day), value: Math.round((complete / scheduled) * 100), entries: scheduled, entryIds: [] });
  }
  return out;
}

/**
 * Check-ins per day for the CalendarHeatmap, from `fromDay` to `today`. Days
 * with none are absent, so the heatmap leaves them plain. `entries` is 1 on
 * purpose: the value already IS the count, and the heatmap's tooltip would
 * otherwise repeat it as "· 3 entries".
 */
export function habitCheckinPoints(habit: HabitProgressShape, fromDay: string, today: string): DayPoint[] {
  const byDay = new Map<string, string[]>();
  for (const c of habit.checkins || []) {
    const d = String(c?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < fromDay || d > today) continue;
    const ids = byDay.get(d) || [];
    ids.push(String(c?.id ?? ""));
    byDay.set(d, ids);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, ids]) => ({ day, label: dayLabel(day), value: ids.length, entries: 1, entryIds: ids.filter(Boolean) }));
}

/** First day shown by a `weeks`-column heatmap ending today (weeks start Monday). */
export function heatmapStartDay(today: string, weeks: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return shiftDay(today, -(dow + 7 * (weeks - 1)));
}
