// How an entry felt, beyond its mood (owner request 2026-11-25: "mood,
// energy, emotions … visualize mood, stress, energy and emotional patterns
// over time").
//
// Energy is the entry's own `energy` column (1-5). Stress and the named
// emotions ride in the entry's tags, the way its photos do (W9): one
// `stress:<1-5>` tag and up to EMOTION_MAX `emotion:<name>` tags. No new
// column and no migration; the composer that owns the entry writes them, and
// the entry's own labels never show them (`feelingLabels`).
//
// Trends are COMPUTED from the entries on read (Rule 5: nothing derived is
// stored): a day's figure is the average of that day's entries, a day with
// nothing written is a gap — never a zero.
//
// Pure. Pinned by tests/journal-feelings.test.ts.

export const STRESS_TAG_PREFIX = "stress:";
export const EMOTION_TAG_PREFIX = "emotion:";
export const EMOTION_MAX = 6;

/** The emotions offered as chips. A fixed list: trends can count them. */
export const EMOTIONS = [
  "calm", "grateful", "hopeful", "proud", "joyful", "loved", "content", "excited",
  "anxious", "stressed", "overwhelmed", "sad", "lonely", "angry", "frustrated", "tired", "worried", "guilty",
] as const;
export type Emotion = (typeof EMOTIONS)[number];
const EMOTION_SET = new Set<string>(EMOTIONS);
/** Emotions that count as a strain when the trends name them. */
export const HARD_EMOTIONS = new Set<string>(["anxious", "stressed", "overwhelmed", "sad", "lonely", "angry", "frustrated", "tired", "worried", "guilty"]);

export const LEVEL_LABELS = ["Very low", "Low", "Moderate", "High", "Very high"] as const;
export const levelLabel = (n: number | null | undefined) => (n && n >= 1 && n <= 5 ? LEVEL_LABELS[Math.round(n) - 1] : "Not set");

const level = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

const isStressTag = (t: unknown): t is string => typeof t === "string" && t.startsWith(STRESS_TAG_PREFIX);
const isEmotionTag = (t: unknown): t is string => typeof t === "string" && t.startsWith(EMOTION_TAG_PREFIX);
export const isFeelingTag = (t: unknown): boolean => isStressTag(t) || isEmotionTag(t);

/** The entry's stress level, 1 (very low) to 5 (very high); null when not set. */
export function journalStress(tags: string[] | null | undefined): number | null {
  for (const t of tags || []) if (isStressTag(t)) { const n = level(t.slice(STRESS_TAG_PREFIX.length)); if (n) return n; }
  return null;
}
/** The emotions named on the entry, in the order they were picked. */
export function journalEmotions(tags: string[] | null | undefined): Emotion[] {
  const out: Emotion[] = [];
  for (const t of tags || []) {
    if (!isEmotionTag(t)) continue;
    const name = t.slice(EMOTION_TAG_PREFIX.length).trim().toLowerCase();
    if (EMOTION_SET.has(name) && !out.includes(name as Emotion)) out.push(name as Emotion);
  }
  return out.slice(0, EMOTION_MAX);
}
/** Tags without the stress and emotion pointers. */
export function feelingLabels(tags: string[] | null | undefined): string[] {
  return (tags || []).filter((t) => typeof t === "string" && !isFeelingTag(t));
}
/** The pointer tags for a stress level and a set of emotions. */
export function feelingTags(stress: number | null | undefined, emotions: readonly string[]): string[] {
  const s = level(stress);
  const names = [...new Set(emotions.map((e) => String(e).trim().toLowerCase()).filter((e) => EMOTION_SET.has(e)))].slice(0, EMOTION_MAX);
  return [...(s ? [`${STRESS_TAG_PREFIX}${s}`] : []), ...names.map((e) => `${EMOTION_TAG_PREFIX}${e}`)];
}

// ── Trends ───────────────────────────────────────────────────────────────────

/** Mood on one scale, 1 (terrible) to 5 (amazing). Okay and neutral are the middle. */
export const MOOD_SCORE: Record<string, number> = {
  terrible: 1, awful: 1.5, bad: 2, neutral: 3, okay: 3, good: 4, great: 4.5, amazing: 5,
};
export const moodScore = (mood: unknown): number | null => MOOD_SCORE[String(mood || "")] ?? null;

export interface TrendEntry { date: string; mood?: string | null; energy?: number | null; tags?: string[] | null }
export type TrendMetric = "mood" | "energy" | "stress";
export interface TrendPoint { date: string; value: number; entries: number }
export interface TrendSeries {
  metric: TrendMetric;
  /** One point per day that has a reading, oldest first. Days without one are absent. */
  points: TrendPoint[];
  average: number | null;
  /** Average of the later half minus the earlier half; null under MIN_TREND_DAYS days. */
  change: number | null;
  days: number;
}
/** Under this many days with a reading, a direction is not stated. */
export const MIN_TREND_DAYS = 4;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const day = (d: unknown) => String(d || "").slice(0, 10);

function reading(e: TrendEntry, metric: TrendMetric): number | null {
  if (metric === "mood") return moodScore(e.mood);
  if (metric === "energy") return level(e.energy);
  return journalStress(e.tags);
}

/** One metric over the entries dated from..to (inclusive, YYYY-MM-DD; either may be omitted). */
export function trendSeries(entries: TrendEntry[], metric: TrendMetric, range: { from?: string; to?: string } = {}): TrendSeries {
  const byDay = new Map<string, number[]>();
  for (const e of entries) {
    const d = day(e.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (range.from && d < range.from) continue;
    if (range.to && d > range.to) continue;
    const v = reading(e, metric);
    if (v == null) continue;
    const list = byDay.get(d);
    if (list) list.push(v); else byDay.set(d, [v]);
  }
  const points = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, vs]) => ({ date, value: round1(mean(vs)), entries: vs.length }));
  if (points.length === 0) return { metric, points, average: null, change: null, days: 0 };
  const values = points.map((p) => p.value);
  let change: number | null = null;
  if (points.length >= MIN_TREND_DAYS) {
    const half = Math.floor(points.length / 2);
    change = round1(mean(values.slice(points.length - half)) - mean(values.slice(0, half)));
  }
  return { metric, points, average: round1(mean(values)), change, days: points.length };
}

export interface EmotionCount { emotion: Emotion; entries: number; hard: boolean }
/** How many entries name each emotion in the range, most frequent first. */
export function emotionCounts(entries: TrendEntry[], range: { from?: string; to?: string } = {}): EmotionCount[] {
  const counts = new Map<Emotion, number>();
  for (const e of entries) {
    const d = day(e.date);
    if (range.from && d < range.from) continue;
    if (range.to && d > range.to) continue;
    for (const emo of journalEmotions(e.tags)) counts.set(emo, (counts.get(emo) || 0) + 1);
  }
  return [...counts.entries()].map(([emotion, n]) => ({ emotion, entries: n, hard: HARD_EMOTIONS.has(emotion) }))
    .sort((a, b) => b.entries - a.entries || a.emotion.localeCompare(b.emotion));
}

/** "up 0.6", "down 1.2", "steady": how a change reads. Under 0.3 is steady. */
export function describeChange(change: number | null): string {
  if (change == null) return "Not enough days yet to see a direction";
  if (Math.abs(change) < 0.3) return "Steady";
  return `${change > 0 ? "Up" : "Down"} ${Math.abs(change).toFixed(1)}`;
}

/** Days written on, longest run of consecutive days, and the current run ending at `today`. */
export function writingStreaks(entries: TrendEntry[], today: string): { daysWritten: number; longest: number; current: number } {
  const days = [...new Set(entries.map((e) => day(e.date)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (days.length === 0) return { daysWritten: 0, longest: 0, current: 0 };
  const next = (d: string) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) { run = next(days[i - 1]) === days[i] ? run + 1 : 1; if (run > longest) longest = run; }
  let current = 0;
  const set = new Set(days);
  const prev = (d: string) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
  // A run still counts when today has nothing written yet.
  let cursor = set.has(today) ? today : prev(today);
  while (set.has(cursor)) { current++; cursor = prev(cursor); }
  return { daysWritten: days.length, longest, current };
}
