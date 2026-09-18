// ── "Needs attention" — what the words mean ───────────────────────────────────
// QA 2026-09-18 (F-40): the Trackers page listed 31 of 34 trackers under
// NEEDS ATTENTION, including ones badged "In range" and "This month". The
// bucket was "anything not logged in the last seven days", which is not
// attention — a monthly weigh-in logged three weeks ago is on schedule.
//
// A tracker needs attention when ONE of these holds:
//   1. its latest reading is out of range (a clinical status badge), or a
//      reading is incomplete, or a dose is due;
//   2. it is OVERDUE for a log against its OWN cadence — logged regularly
//      (three or more entries) and now silent for more than twice its usual
//      gap;
//   3. its trend is moving the wrong way for the metric (weight up, sleep
//      down, steps down) by a meaningful margin.
//
// Merely having data, or not being logged today, never qualifies. Pure and
// shared so the page and any future badge count the same set.

export interface AttentionInput {
  /** The card's status badge label, when it has one. */
  statusLabel?: string | null;
  /** Every entry timestamp for the tracker (any order). */
  entryTimestamps: Array<string | number | Date>;
  /** Week-over-week change of the primary metric, in percent (positive = up). */
  trendPct?: number | null;
  /** Which way is GOOD for this metric. "neutral" = a trend is never a concern. */
  favorableDirection?: "up" | "down" | "neutral";
  now?: number;
}

export type AttentionReason = "out_of_range" | "overdue" | "negative_trend";

/** Badges that describe the READING, not its freshness. */
const OUT_OF_RANGE_LABELS = new Set([
  "High", "Crisis", "Elevated", "Low", "Incomplete", "Due", "Stage 1 high", "Stage 2 high", "Moderate",
]);

const DAY = 86400000;
/** A trend smaller than this is noise, not a direction. */
export const NEGATIVE_TREND_PCT = 10;

/** Median gap in days between consecutive entries, or null under three entries. */
export function usualGapDays(entryTimestamps: AttentionInput["entryTimestamps"]): number | null {
  const ts = entryTimestamps
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (ts.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / DAY);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/** Overdue = silent for more than twice the usual gap (and at least two days). */
export function isOverdueForLog(entryTimestamps: AttentionInput["entryTimestamps"], now: number = Date.now()): boolean {
  const gap = usualGapDays(entryTimestamps);
  if (gap == null) return false;
  const last = Math.max(...entryTimestamps.map((t) => new Date(t).getTime()).filter((t) => Number.isFinite(t)));
  if (!Number.isFinite(last)) return false;
  const silentDays = (now - last) / DAY;
  return silentDays > Math.max(2, gap * 2);
}

export function attentionReason(input: AttentionInput): AttentionReason | null {
  if (input.statusLabel && OUT_OF_RANGE_LABELS.has(input.statusLabel)) return "out_of_range";
  if (isOverdueForLog(input.entryTimestamps, input.now ?? Date.now())) return "overdue";
  const dir = input.favorableDirection ?? "neutral";
  const pct = input.trendPct;
  if (dir !== "neutral" && pct != null && Number.isFinite(pct) && Math.abs(pct) >= NEGATIVE_TREND_PCT) {
    if ((dir === "up" && pct < 0) || (dir === "down" && pct > 0)) return "negative_trend";
  }
  return null;
}

export function trackerNeedsAttention(input: AttentionInput): boolean {
  return attentionReason(input) != null;
}

/**
 * Which way is good for a tracker, from its name. Mirrors the private rule in
 * shared/tracker-insights (kept in step by the regression test) so the
 * attention bucket and the insight engine agree about what "worse" means.
 */
export function favorableDirectionFor(name: string | null | undefined, category?: string | null): "up" | "down" | "neutral" {
  const n = String(name || "").toLowerCase();
  const cat = String(category || "").toLowerCase();
  if (/\bweight\b|\bbmi\b|blood pressure|\bbp\b|systolic|diastolic|resting heart|\brhr\b|cholesterol|\bldl\b|a1c|glucose|screen time|body fat/.test(n)) return "down";
  if (cat === "finance" && /debt|spending|expense/.test(n)) return "down";
  if (/\bstep|walk|exercise|workout|sleep|water|hydration|\bread|study|meditat|savings|net worth|income|credit score/.test(n)) return "up";
  return "neutral";
}
