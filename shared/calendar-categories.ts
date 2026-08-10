// shared/calendar-categories.ts — the filter chips, and what their numbers mean.
//
// User report 2026-07-25: "Do not show Upcoming 135 as though there are 135
// different items. That number is counting future occurrences and duplicates,
// which is misleading."
//
// Exactly right, and it points at the distinction this module exists to keep:
//
//   A RULE is a thing you own — "Netflix, $9.99, monthly on day 2". You have
//   three subscriptions.
//   An OCCURRENCE is one generated date — Aug 2, Sep 2, Oct 2. You have
//   hundreds, and counting them tells the user nothing.
//
// Chip counts are therefore ALWAYS over deduplicated rules. `countRules` takes
// the surviving series (post-dedup) and refuses to accept occurrences at all —
// the types make the mistake impossible rather than merely discouraged.
//
// Pure, dependency-free. Pinned by tests/calendar-categories.test.ts.

import type { CalendarSeries, OccurrenceKind } from "./calendar-occurrences";

/**
 * Source-type categories, plus the one STATUS filter.
 *
 * User report 2026-07-25: "Important contains routine monthly bills and
 * renewals and is massively overpopulated… 'Important' is not a source type.
 * It is a status/filter."
 *
 * It had been a dumping ground for every kind that wasn't money, people, or
 * to-dos — anniversaries, renewals, appointments, documents, plain events —
 * which is why it read 40 of 49. Those now have their own categories, and
 * `important` is computed from urgency and starring instead (see
 * `isImportant`).
 */
export type CalendarCategory =
  | "all"
  | "birthdays"
  | "anniversaries"
  | "bills"
  | "subscriptions"
  | "liabilities"
  | "income"
  | "documents"
  | "tasks"
  | "events"
  | "other"
  | "important";

export interface CalendarCategoryDef {
  id: CalendarCategory;
  label: string;
  /** Short label for narrow chips. */
  short: string;
}

/** Chip order, left to right. */
export const CALENDAR_CATEGORIES: CalendarCategoryDef[] = [
  { id: "all", label: "All", short: "All" },
  // Status filter first — it answers "what needs me?", not "what kind is it?".
  { id: "important", label: "Important", short: "Important" },
  { id: "birthdays", label: "Birthdays", short: "Birthdays" },
  { id: "anniversaries", label: "Anniversaries", short: "Anniversaries" },
  { id: "bills", label: "Bills", short: "Bills" },
  { id: "subscriptions", label: "Subscriptions", short: "Subs" },
  { id: "liabilities", label: "Liabilities", short: "Liabilities" },
  // Money coming IN gets its own chip, next to the money going out.
  { id: "income", label: "Income", short: "Income" },
  { id: "documents", label: "Document Expirations", short: "Documents" },
  { id: "tasks", label: "Tasks", short: "Tasks" },
  { id: "events", label: "Events", short: "Events" },
  { id: "other", label: "Other", short: "Other" },
];

/** The categories that describe WHAT a record is (everything except all/important). */
export const SOURCE_CATEGORIES = CALENDAR_CATEGORIES
  .filter((c) => c.id !== "all" && c.id !== "important")
  .map((c) => c.id) as Array<Exclude<CalendarCategory, "all" | "important">>;

/**
 * Which chip a kind belongs under.
 *
 * "Important Dates" is the home for the dates that matter but aren't money,
 * people, or to-dos: anniversaries, renewals, appointments, maintenance,
 * document expirations, and plain recurring events.
 */
type SourceCategory = Exclude<CalendarCategory, "all" | "important">;

const KIND_TO_CATEGORY: Record<OccurrenceKind, SourceCategory> = {
  birthday: "birthdays",
  anniversary: "anniversaries",
  bill: "bills",
  subscription: "subscriptions",
  liability: "liabilities",
  income: "income",
  document: "documents",
  task: "tasks",
  habit: "tasks",
  // Renewals, maintenance and appointments are calendar events with a flavour;
  // none of them is inherently "important".
  renewal: "events",
  maintenance: "events",
  appointment: "events",
  event: "events",
  custom: "other",
};

export function categoryForKind(kind: OccurrenceKind): SourceCategory {
  return KIND_TO_CATEGORY[kind] ?? "other";
}

// ─── Important: a STATUS, computed ───────────────────────────────────────────

/** Days ahead within which an upcoming date counts as needing attention. */
export const IMPORTANT_WINDOW_DAYS = 14;

export interface ImportanceContext {
  todayISO: string;
  /** The next live date for this series, if any. */
  nextDate?: string | null;
  /** User-starred series ids. */
  starred?: ReadonlySet<string>;
  /** How far ahead still counts as urgent. */
  windowDays?: number;
}

/**
 * Is this rule important RIGHT NOW?
 *
 * Only three things qualify: the user starred it, it is overdue, or it falls
 * inside the warning window. A routine monthly bill six months out is not
 * important — that was the bug.
 */
export function isImportant(series: CalendarSeries, ctx: ImportanceContext): boolean {
  if (ctx.starred?.has(series.id)) return true;
  const next = ctx.nextDate;
  if (!next) return false;
  if (next < ctx.todayISO) return true; // overdue
  const window = ctx.windowDays ?? IMPORTANT_WINDOW_DAYS;
  const limit = new Date(`${ctx.todayISO}T12:00:00`);
  limit.setDate(limit.getDate() + window);
  return next <= limit.toLocaleDateString("en-CA");
}

/**
 * Does a series belong under this chip? "all" matches everything, and
 * "important" needs urgency context (pass `ctx`, or it matches nothing).
 */
export function seriesInCategory(
  series: CalendarSeries,
  category: CalendarCategory,
  ctx?: ImportanceContext,
): boolean {
  if (category === "all") return true;
  if (category === "important") return ctx ? isImportant(series, ctx) : false;
  return categoryForKind(series.kind) === category;
}

/** Just the series under one chip. */
export function filterSeriesByCategory(
  list: readonly CalendarSeries[],
  category: CalendarCategory,
  nextDateFor?: (series: CalendarSeries) => string | null | undefined,
  ctx?: Omit<ImportanceContext, "nextDate">,
): CalendarSeries[] {
  if (category === "all") return [...list];
  if (category === "important") {
    if (!ctx) return [];
    return list.filter((s) =>
      isImportant(s, { ...ctx, nextDate: nextDateFor?.(s) ?? null }));
  }
  return list.filter((s) => seriesInCategory(s, category));
}

export type CalendarCategoryCounts = Record<CalendarCategory, number>;

/**
 * How many unique recurring RULES sit under each chip.
 *
 * Pass the DEDUPLICATED series list (the output of `dedupeSeries`). Because a
 * merged ChatGPT Pro survives as one series with one kind, it is counted once,
 * under one chip — never once as a subscription and again as a liability.
 *
 * `all` is the number of distinct rules, not the sum of the other chips
 * (identical either way, since every kind maps to exactly one category — the
 * test pins that).
 */
export function countRules(
  series: readonly CalendarSeries[],
  importance?: {
    todayISO: string;
    nextDateFor: (series: CalendarSeries) => string | null | undefined;
    starred?: ReadonlySet<string>;
    windowDays?: number;
  },
): CalendarCategoryCounts {
  const counts: CalendarCategoryCounts = {
    all: 0, important: 0, birthdays: 0, anniversaries: 0, bills: 0,
    subscriptions: 0, liabilities: 0, income: 0, documents: 0, tasks: 0,
    events: 0, other: 0,
  };
  const seen = new Set<string>();
  for (const s of series || []) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    counts.all += 1;
    counts[categoryForKind(s.kind)] += 1;
    // `important` overlaps the source categories by design — it is a status,
    // so it is NOT part of the all-equals-the-sum invariant.
    if (importance && isImportant(s, {
      todayISO: importance.todayISO,
      nextDate: importance.nextDateFor(s),
      starred: importance.starred,
      windowDays: importance.windowDays,
    })) counts.important += 1;
  }
  return counts;
}

/**
 * Chips to render, with their counts.
 *
 * `hideEmpty` drops zero-count chips EXCEPT "all", so a user with no
 * liabilities isn't offered a dead filter — while "Important 0" can still be
 * shown deliberately when the caller wants the full, stable row.
 */
export function categoryChips(
  counts: CalendarCategoryCounts,
  opts: { hideEmpty?: boolean } = {},
): Array<CalendarCategoryDef & { count: number }> {
  return CALENDAR_CATEGORIES
    .map((c) => ({ ...c, count: counts[c.id] ?? 0 }))
    .filter((c) => (opts.hideEmpty ? c.id === "all" || c.count > 0 : true));
}
