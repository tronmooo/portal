// shared/dated-items.ts — the one windowed roll-up every counter reads.
//
// The complaint, 2026-08-04: "The Executive Dashboard should never report
// 0 Tasks if there are tasks with due dates… Every badge, counter, and card
// must use the exact same source of truth."
//
// It was reporting different numbers because three surfaces answered the same
// question from three datasets:
//
//   Recurring Dates chips  → useCalendarOccurrences (the occurrence engine)
//   Calendar Today/Week/30 → a hand-rolled loop over /api/calendar/timeline
//   Executive Dashboard    → its own re-scan of the raw tasks/events arrays
//
// This module is not a fourth. It takes the occurrence stream the engine
// ALREADY produces — which `seriesFromAll` builds from every date source in the
// app (events, recurring events, tasks, reminders, bills, subscriptions,
// liabilities, birthdays, anniversaries, document expirations) — and buckets it
// by urgency. Anything the engine can see is therefore counted by construction,
// and nothing counts a date the calendar would not draw.
//
// WHY WINDOWED, NOT TOTAL. The account this was reported on holds 3,481 open
// tasks, nearly all bulk-seeded rows due on one long-past date. "Count every
// actionable task" would render `Tasks 3,481` and an Overdue count in the
// thousands — technically complete and useless. The dashboard answers "what
// requires my attention, when does it happen, how urgent is it", so the counts
// are Overdue / Today / next 7 / next 30, with the total kept alongside for
// callers that genuinely want it.
//
// Pure, dependency-free, no I/O. Pinned by tests/dated-items.test.ts.

import type { CalendarOccurrence, OccurrenceKind } from "./calendar-occurrences";

export interface DatedBuckets {
  /** Past its date and not done/skipped. */
  overdue: number;
  /** Falls today. */
  today: number;
  /** Today through today+7, inclusive. Includes `today`. */
  next7: number;
  /** Today through today+30, inclusive. Includes `today` and `next7`. */
  next30: number;
  /** overdue + next30 — what the card badge should read. */
  attention: number;
}

export interface DatedRollup extends DatedBuckets {
  /** Every occurrence considered, including far-future and completed ones. */
  total: number;
  /** The same buckets per source kind, so a Tasks card can read `byKind.task`. */
  byKind: Partial<Record<OccurrenceKind, DatedBuckets>>;
}

const emptyBuckets = (): DatedBuckets => ({
  overdue: 0, today: 0, next7: 0, next30: 0, attention: 0,
});

const shiftISO = (todayISO: string, days: number): string => {
  const d = new Date(`${todayISO.slice(0, 10)}T12:00:00`);
  if (isNaN(d.getTime())) return todayISO;
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};

/**
 * Which bucket one occurrence falls in, or null when it is settled (done or
 * skipped) or sits beyond the 30-day horizon.
 *
 * Dates are compared as YYYY-MM-DD strings, which sort lexically — the same
 * comparison the calendar grid and the occurrence engine use, so a boundary
 * date can never land in one and not the other.
 */
function classify(
  occ: CalendarOccurrence,
  todayISO: string,
  weekEnd: string,
  horizonEnd: string,
): Array<keyof DatedBuckets> | null {
  if (!occ) return null;
  // A checked-off or skipped occurrence needs nothing from the user.
  if (occ.status === "done" || occ.status === "skipped") return null;
  // An UNDATED occurrence has no deadline, so it cannot be overdue, due today,
  // or due within any horizon. The timeline still emits it (pinned to the
  // record's creation day) so the calendar can list it, but every urgency
  // counter has to ignore that placement date.
  //
  // Reported 2026-08-13: a brand-new account showed "3 overdue tasks" and
  // "3 need action" with no dated task anywhere. All three were tasks with a
  // NULL due_date — pinned to their creation date four days earlier, which the
  // line below then read as four days past due. Two of them were already
  // marked done; see the matching `completed` fix in getCalendarTimeline.
  if (occ.undated) return null;
  const date = String(occ.effectiveDate || occ.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  if (date < todayISO) return ["overdue", "attention"];
  if (date === todayISO) return ["today", "next7", "next30", "attention"];
  if (date <= weekEnd) return ["next7", "next30", "attention"];
  if (date <= horizonEnd) return ["next30", "attention"];
  return null; // beyond the horizon — real, but not what needs attention now
}

/**
 * Bucket an occurrence stream by urgency, overall and per kind.
 *
 * Pass the engine's deduplicated occurrences (`useCalendarOccurrences().occurrences`).
 * Because they are deduplicated, a birthday that exists both as a profile field
 * and as a typed-in event is counted once — the guarantee that makes two
 * surfaces reading this function agree.
 */
export function rollupOccurrences(
  occurrences: readonly CalendarOccurrence[] | null | undefined,
  todayISO: string,
): DatedRollup {
  const today = String(todayISO || "").slice(0, 10);
  const weekEnd = shiftISO(today, 7);
  const horizonEnd = shiftISO(today, 30);

  const rollup: DatedRollup = { total: 0, ...emptyBuckets(), byKind: {} };
  for (const occ of occurrences || []) {
    if (!occ) continue;
    rollup.total += 1;
    const hits = classify(occ, today, weekEnd, horizonEnd);
    if (!hits) continue;
    const kindBuckets = rollup.byKind[occ.kind] ?? (rollup.byKind[occ.kind] = emptyBuckets());
    for (const k of hits) {
      rollup[k] += 1;
      kindBuckets[k] += 1;
    }
  }
  return rollup;
}

/** The buckets for one kind, zeroed rather than undefined so callers can render. */
export function bucketsForKind(rollup: DatedRollup, kind: OccurrenceKind): DatedBuckets {
  return rollup.byKind[kind] ?? emptyBuckets();
}

/**
 * Sum several kinds into one card's buckets — the Tasks card counts tasks AND
 * the habit schedules that behave like them (`shared/calendar-categories` maps
 * both to the "tasks" chip, and the two must not disagree).
 */
export function bucketsForKinds(
  rollup: DatedRollup,
  kinds: readonly OccurrenceKind[],
): DatedBuckets {
  const out = emptyBuckets();
  for (const kind of kinds) {
    const b = rollup.byKind[kind];
    if (!b) continue;
    out.overdue += b.overdue;
    out.today += b.today;
    out.next7 += b.next7;
    out.next30 += b.next30;
    out.attention += b.attention;
  }
  return out;
}

/**
 * The breakdown line the dashboard shows under a count:
 * "Today 1 · Upcoming 2 · Overdue 1". Empty when nothing needs attention, so a
 * caller can drop the line rather than print three zeros.
 */
export function breakdownLabel(b: DatedBuckets): string {
  const parts: string[] = [];
  if (b.overdue > 0) parts.push(`Overdue ${b.overdue}`);
  if (b.today > 0) parts.push(`Today ${b.today}`);
  const upcoming = b.next30 - b.today;
  if (upcoming > 0) parts.push(`Upcoming ${upcoming}`);
  return parts.join(" · ");
}
