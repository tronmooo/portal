// Mood over time, from the mood stamped on each journal entry.
//
// Moods are words, not numbers, so a chart needs a scale: terrible = 1 …
// amazing = 8, in the order of MoodLevel. A day with several entries takes
// the LAST one (how the day ended); a day without an entry is absent, never
// "neutral". Pure — the Journal page and its tests read it.

import type { MoodLevel } from "./schema";
import { dayLabel, type DayPoint } from "./tracker-analytics";

export const MOOD_ORDER: MoodLevel[] = ["terrible", "awful", "bad", "neutral", "okay", "good", "great", "amazing"];

export function moodScore(m: MoodLevel | undefined | null): number | null {
  if (!m) return null;
  const i = MOOD_ORDER.indexOf(m);
  return i < 0 ? null : i + 1;
}

export function moodForScore(score: number): MoodLevel {
  const i = Math.max(0, Math.min(MOOD_ORDER.length - 1, Math.round(score) - 1));
  return MOOD_ORDER[i];
}

interface MoodEntry { id?: string; date: string; mood?: MoodLevel | null; createdAt?: string }

/** One point per day that has a mood, in date order. */
export function moodSeries(entries: MoodEntry[], fromDay: string | null = null, toDay: string | null = null): DayPoint[] {
  const byDay = new Map<string, { e: MoodEntry; n: number; ids: string[] }>();
  for (const e of entries) {
    if (!e?.date || moodScore(e.mood) == null) continue;
    if (fromDay && e.date < fromDay) continue;
    if (toDay && e.date > toDay) continue;
    const cur = byDay.get(e.date);
    const later = !cur || String(e.createdAt || "") >= String(cur.e.createdAt || "");
    byDay.set(e.date, { e: later ? e : cur!.e, n: (cur?.n || 0) + 1, ids: [...(cur?.ids || []), ...(e.id ? [e.id] : [])] });
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, label: dayLabel(day), value: moodScore(b.e.mood)!, entries: b.n, entryIds: b.ids }));
}

export interface MoodSummary {
  days: number;
  average: number | null;
  averageMood: MoodLevel | null;
  /** Days per mood, most common first. */
  distribution: Array<{ mood: MoodLevel; days: number; share: number }>;
  /** Share of days at "good" or better. */
  goodShare: number | null;
}

export function moodSummary(points: DayPoint[]): MoodSummary {
  if (points.length === 0) return { days: 0, average: null, averageMood: null, distribution: [], goodShare: null };
  const avg = points.reduce((s, p) => s + p.value, 0) / points.length;
  const counts = new Map<MoodLevel, number>();
  for (const p of points) {
    const m = moodForScore(p.value);
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  const goodFrom = moodScore("good")!;
  return {
    days: points.length,
    average: Math.round(avg * 10) / 10,
    averageMood: moodForScore(avg),
    distribution: [...counts.entries()]
      .map(([mood, days]) => ({ mood, days, share: Math.round((days / points.length) * 100) }))
      .sort((a, b) => b.days - a.days || moodScore(b.mood)! - moodScore(a.mood)!),
    goodShare: Math.round((points.filter((p) => p.value >= goodFrom).length / points.length) * 100),
  };
}
