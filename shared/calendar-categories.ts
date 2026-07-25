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

export type CalendarCategory =
  | "all"
  | "birthdays"
  | "important"
  | "bills"
  | "subscriptions"
  | "liabilities"
  | "tasks"
  | "reminders";

export interface CalendarCategoryDef {
  id: CalendarCategory;
  label: string;
  /** Short label for narrow chips. */
  short: string;
}

/** Chip order, left to right. */
export const CALENDAR_CATEGORIES: CalendarCategoryDef[] = [
  { id: "all", label: "All", short: "All" },
  { id: "birthdays", label: "Birthdays", short: "Birthdays" },
  { id: "important", label: "Important Dates", short: "Important" },
  { id: "bills", label: "Bills", short: "Bills" },
  { id: "subscriptions", label: "Subscriptions", short: "Subs" },
  { id: "liabilities", label: "Liabilities", short: "Liabilities" },
  { id: "tasks", label: "Tasks", short: "Tasks" },
  { id: "reminders", label: "Reminders", short: "Reminders" },
];

/**
 * Which chip a kind belongs under.
 *
 * "Important Dates" is the home for the dates that matter but aren't money,
 * people, or to-dos: anniversaries, renewals, appointments, maintenance,
 * document expirations, and plain recurring events.
 */
const KIND_TO_CATEGORY: Record<OccurrenceKind, Exclude<CalendarCategory, "all">> = {
  birthday: "birthdays",
  anniversary: "important",
  renewal: "important",
  maintenance: "important",
  appointment: "important",
  document: "important",
  event: "important",
  custom: "important",
  bill: "bills",
  subscription: "subscriptions",
  liability: "liabilities",
  task: "tasks",
  habit: "tasks",
  reminder: "reminders",
};

export function categoryForKind(kind: OccurrenceKind): Exclude<CalendarCategory, "all"> {
  return KIND_TO_CATEGORY[kind] ?? "important";
}

/** Does a series belong under this chip? "all" matches everything. */
export function seriesInCategory(series: CalendarSeries, category: CalendarCategory): boolean {
  if (category === "all") return true;
  return categoryForKind(series.kind) === category;
}

/** Just the series under one chip. */
export function filterSeriesByCategory(
  list: readonly CalendarSeries[],
  category: CalendarCategory,
): CalendarSeries[] {
  if (category === "all") return [...list];
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
export function countRules(series: readonly CalendarSeries[]): CalendarCategoryCounts {
  const counts: CalendarCategoryCounts = {
    all: 0, birthdays: 0, important: 0, bills: 0,
    subscriptions: 0, liabilities: 0, tasks: 0, reminders: 0,
  };
  const seen = new Set<string>();
  for (const s of series || []) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    counts.all += 1;
    counts[categoryForKind(s.kind)] += 1;
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
