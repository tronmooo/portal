// What the Executive tab's Needs Attention card shows, and how its rows group.
//
// Requested 2026-10-21: "change that up — except for bills due, I want it to
// be more like documents that are about to expire and more important stuff."
// Bills have their own home (the Money card, overdue first, with Pay) and
// overdue tasks have theirs (the Tasks card, overdue first). Needs Attention is
// the place for the dated things that are easy to forget and costly to miss:
// expiring or expired documents, renewals, registrations, policy ends, filing
// deadlines, a goal past its deadline, a dose not taken, a reading out of range.
//
// Pure — ExecutiveBriefing renders it, tests/executive-attention.test.ts pins it.

import type { AttentionItem, AttentionTier } from "./attention";

const TIER_RANK: Record<AttentionTier, number> = { immediate: 0, soon: 1, upcoming: 2 };

/** Record kinds that live in another card, never here. */
const ELSEWHERE_KINDS = new Set(["bill", "task", "habit"]);
/**
 * A bell alert DERIVED from one of those records (`obligation:<id>`, a
 * "bill due" notification, an overdue-task notification) belongs to that card
 * too — otherwise switching bills out would let them back in as "Dismiss" rows.
 */
const ELSEWHERE_SOURCE = /^(obligation|bill|expense|task|habit|income|paycheck):/;

export function belongsInAttention(item: AttentionItem): boolean {
  if (ELSEWHERE_KINDS.has(item.kind)) return false;
  // Only ALERTS are judged by their source: a medication dose or an
  // appointment is also an obligation row, and those belong here.
  if (item.kind === "alert" && ELSEWHERE_SOURCE.test(item.sourceKey || "")) return false;
  return true;
}

export interface AttentionSections {
  /** Overdue records and alerts (`computeAttention`, already deduped). */
  immediate: AttentionItem[];
  /** Health items; only those due today or earlier are urgent. */
  health: AttentionItem[];
  /** Expiring / expired documents, renewals and other document dates. */
  documents: AttentionItem[];
}

/**
 * The card's rows, most urgent first: past-due before today before later, and
 * undated alerts at the very top (an alert is happening now). `minTier` is the
 * user's Urgency filter — it now applies to documents too, which it silently
 * did not before.
 */
export function selectAttentionRows(s: AttentionSections, minTier: AttentionTier = "upcoming"): AttentionItem[] {
  const urgentHealth = s.health.filter((i) => (i.daysUntil ?? 0) <= 0);
  const seen = new Set<string>();
  const rows: AttentionItem[] = [];
  for (const i of [...s.immediate, ...urgentHealth, ...s.documents]) {
    if (!belongsInAttention(i)) continue;
    if (TIER_RANK[i.tier] > TIER_RANK[minTier]) continue;
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    rows.push(i);
  }
  return rows.sort((a, b) => (a.daysUntil ?? -999) - (b.daysUntil ?? -999));
}

export type AttentionBand = "overdue" | "week" | "month" | "later";

export const ATTENTION_BANDS: Array<{ id: AttentionBand; label: string; hs: string }> = [
  { id: "overdue", label: "Overdue · act now", hs: "0 72%" },
  { id: "week", label: "This week", hs: "25 90%" },
  { id: "month", label: "This month", hs: "43 96%" },
  { id: "later", label: "Later", hs: "213 90%" },
];

/** Which urgency band a row sits in. Undated alerts are happening now. */
export function attentionBand(i: Pick<AttentionItem, "daysUntil">): AttentionBand {
  const d = i.daysUntil;
  if (d == null || d < 0) return "overdue";
  if (d <= 7) return "week";
  if (d <= 31) return "month";
  return "later";
}

/** Rows split into bands, in band order, empty bands left out. */
export function groupAttentionRows<T extends Pick<AttentionItem, "daysUntil">>(rows: T[]): Array<{ band: (typeof ATTENTION_BANDS)[number]; rows: T[] }> {
  return ATTENTION_BANDS
    .map((band) => ({ band, rows: rows.filter((r) => attentionBand(r) === band.id) }))
    .filter((g) => g.rows.length > 0);
}
