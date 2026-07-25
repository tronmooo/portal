// shared/calendar-occurrences.ts — THE calendar occurrence engine.
//
// One engine generates every date the app shows: birthdays, anniversaries,
// subscriptions, liabilities/bills, reminders, habits, recurring tasks and
// plain calendar events. Every surface (the calendar grid, the recurring
// manager, the dashboard's upcoming stream, notifications) consumes what this
// module returns and renders nothing it computed itself.
//
// Why this exists (user report, 2026-07-25 — see the calendar screenshot):
//
//   "Joe's birthday is appearing twice. Every recurring event should only
//    generate a single occurrence for each date."
//
// Joe's birthday genuinely lived in two systems: the profile's date-of-birth
// field AND a manually-created recurring calendar event. The old aggregator
// deduped on `owner + category + nextDate` — but the two sources had computed
// DIFFERENT next dates (Feb 11 2027 from the profile, Feb 11 2029 from the
// event), so the key never collided and the user saw both. Keying on a date
// that the duplicates disagree about cannot deduplicate them.
//
// The model here is three separate ideas, kept separate on purpose:
//
//   1. IDENTITY  — what real-world date is this? `seriesIdentityKey` answers
//      it WITHOUT consulting any computed date, so two systems describing the
//      same birthday always collide no matter how their arithmetic differs.
//   2. SOURCE    — which record owns it, and where does tapping it go?
//      Carried on every occurrence, so navigation is never a guess.
//   3. HORIZON   — how far ahead to generate, per kind, with an auto-extend
//      signal so recurring dates never quietly run out.
//
// Recurrence expansion itself is delegated to shared/recurring-dates, which
// uses the clamped, base-anchored arithmetic in shared/date-math — so a
// "monthly on day 31" subscription cannot drift onto the 1st.
//
// Pure, dependency-free, no I/O. Pinned by tests/calendar-occurrences.test.ts.

import { expandRecurrenceDates, addDaysISO } from "./recurring-dates";
import { addYearsISO } from "./date-math";

// ─── Kinds ───────────────────────────────────────────────────────────────────

/** What KIND of date this is. Drives the horizon, the icon, and the label. */
export type OccurrenceKind =
  | "birthday"
  | "anniversary"
  | "subscription"
  | "liability"
  | "bill"
  | "renewal"
  | "maintenance"
  | "appointment"
  | "reminder"
  | "task"
  | "habit"
  | "document"
  | "event"
  | "custom";

/** Which system physically stores the record. Drives `href` and edit routing. */
export type SourceSystem =
  | "event"
  | "profile"
  | "obligation"
  | "liability"
  | "task"
  | "reminder"
  | "habit"
  | "document"
  | "goal";

export const KIND_LABELS: Record<OccurrenceKind, string> = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  subscription: "Subscription",
  liability: "Liability",
  bill: "Bill",
  renewal: "Renewal",
  maintenance: "Maintenance",
  appointment: "Appointment",
  reminder: "Reminder",
  task: "Task",
  habit: "Habit",
  document: "Document Expiration",
  event: "Event",
  custom: "Custom",
};

// ─── Horizons ────────────────────────────────────────────────────────────────
//
// How far ahead each kind generates. From the product requirement:
//   Subscriptions ....... at least the next 12 months
//   Liabilities ......... at least the next 12 months (or until the end date)
//   Birthdays ........... at least 5 years
//   Anniversaries ....... at least 5 years
//   Everything else ..... at least 1 year, unless an end date says otherwise

export const HORIZON_DAYS: Record<OccurrenceKind, number> = {
  birthday: 366 * 5,
  anniversary: 366 * 5,
  subscription: 366,
  liability: 366,
  bill: 366,
  renewal: 366,
  maintenance: 366,
  appointment: 366,
  reminder: 366,
  task: 366,
  habit: 366,
  document: 366,
  event: 366,
  custom: 366,
};

/** Days of future coverage this kind must always have. */
export function horizonDaysFor(kind: OccurrenceKind): number {
  return HORIZON_DAYS[kind] ?? 366;
}

/**
 * Once generated coverage drops below this fraction of the kind's horizon, the
 * window is "nearly exhausted" and callers should widen it. Keeps a recurring
 * date from silently vanishing off the end of the calendar.
 */
export const HORIZON_REFRESH_RATIO = 0.25;

// ─── Series ──────────────────────────────────────────────────────────────────

/** Where an occurrence came from, and where tapping it must go. */
export interface OccurrenceSource {
  system: SourceSystem;
  /** Record id inside that system. */
  id: string;
  /** The profile this date belongs to (a person, a vehicle, a liability…). */
  profileId?: string;
  /** Display name of the source ("Joe", "Netflix", "Honda CR-V"). */
  label?: string;
  /** Route to the source record. Always set — see `sourceHref`. */
  href: string;
}

/**
 * A normalized recurring series, whatever system it came from. Adapters convert
 * profiles / obligations / events / tasks into this one shape; everything
 * downstream only ever sees `CalendarSeries`.
 */
export interface CalendarSeries {
  /** Stable id of the SERIES: `${system}:${recordId}` plus a discriminator. */
  id: string;
  kind: OccurrenceKind;
  title: string;
  subtitle?: string;
  source: OccurrenceSource;
  /** First date of the series, YYYY-MM-DD. */
  baseDate: string;
  /** none | daily | weekdays | weekends | weekly | biweekly | monthly | yearly */
  recurrence: string;
  /** Hard end of the series (a liability's payoff date, a fixed-term plan). */
  recurrenceEnd?: string;
  /** Occurrences checked off, by canonical date. */
  completedDates?: string[];
  /** Occurrences skipped, by canonical date. */
  skippedDates?: string[];
  /** Canonical date → the date it was moved to. */
  movedDates?: Record<string, string>;
  paused?: boolean;
  archived?: boolean;
  /** Money amount, for bills/subscriptions/liabilities. */
  amount?: number;
  /**
   * Set when this series is a SHADOW of a record that another system owns —
   * e.g. a manually-created "Joe's Birthday" event when Joe's profile already
   * carries his date of birth. Shadows lose deduplication to the canonical
   * source. Adapters set this; `dedupeSeries` enforces it.
   */
  shadow?: boolean;
}

// ─── Identity ────────────────────────────────────────────────────────────────
//
// The dedup key. It deliberately does NOT include any computed date: the whole
// point is to collapse two sources that disagree about the date.

/** Kinds whose identity is "this person/thing has ONE of these, ever". */
const SINGLETON_KINDS = new Set<OccurrenceKind>(["birthday", "anniversary"]);

const slug = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

/**
 * The semantic identity of a series — what real-world recurring date it is.
 *
 * Two series with the same key are the SAME date and must render once:
 *
 *   • Birthdays and anniversaries are singletons per profile. A person has one
 *     birthday; whether it arrives from their profile's DOB field or from a
 *     recurring event someone typed in, it is `birthday:<profileId>`.
 *   • Everything else is identified by profile + kind + normalized title, so
 *     "Netflix" the subscription and "Netflix" the liability collapse, while
 *     "Netflix" and "Spotify" stay distinct.
 *   • With no profile and no title, identity falls back to the record itself,
 *     which can never over-merge.
 */
export function seriesIdentityKey(series: CalendarSeries): string {
  const owner = series.source.profileId || "";
  if (SINGLETON_KINDS.has(series.kind) && owner) {
    return `${series.kind}:${owner}`;
  }
  const name = slug(series.title);
  if (owner && name) return `${series.kind}:${owner}:${name}`;
  if (name) return `${series.kind}::${name}`;
  return `${series.kind}:record:${series.source.system}:${series.source.id}`;
}

/**
 * Which system is the AUTHORITY for a kind. When duplicates collide, the
 * record in the authoritative system wins, because that's where editing it
 * actually takes effect — a birthday belongs to the profile, a subscription
 * charge belongs to its obligation.
 */
const AUTHORITY: Partial<Record<OccurrenceKind, SourceSystem>> = {
  birthday: "profile",
  anniversary: "profile",
  subscription: "obligation",
  bill: "obligation",
  liability: "liability",
  document: "document",
  task: "task",
  habit: "habit",
  reminder: "reminder",
};

/**
 * Rank a series as a dedup candidate — HIGHER wins. Explicit `shadow` loses
 * outright; otherwise the authoritative system wins; ties break toward the
 * series carrying more information (per-occurrence state, an amount).
 */
export function seriesPriority(series: CalendarSeries): number {
  if (series.shadow) return 0;
  let score = 1;
  if (AUTHORITY[series.kind] === series.source.system) score += 100;
  if (series.source.profileId) score += 10;
  if (series.amount != null) score += 2;
  if ((series.completedDates?.length || 0) + (series.skippedDates?.length || 0) > 0) score += 1;
  if (series.recurrenceEnd) score += 1;
  return score;
}

/**
 * Collapse series that describe the same real-world date, keeping the
 * highest-priority one. This is what stops Joe's birthday rendering twice.
 *
 * Returns the survivors plus, for each, the ids it absorbed — so the UI can
 * say "also tracked as a calendar event" instead of silently hiding a record
 * the user created.
 */
export interface DedupedSeries {
  series: CalendarSeries;
  /** Series ids collapsed into this one (never includes `series.id`). */
  duplicateIds: string[];
}

export function dedupeSeries(list: readonly CalendarSeries[]): DedupedSeries[] {
  const byIdentity = new Map<string, DedupedSeries>();
  for (const s of list || []) {
    if (!s) continue;
    const key = seriesIdentityKey(s);
    const held = byIdentity.get(key);
    if (!held) {
      byIdentity.set(key, { series: s, duplicateIds: [] });
      continue;
    }
    if (seriesPriority(s) > seriesPriority(held.series)) {
      byIdentity.set(key, { series: s, duplicateIds: [...held.duplicateIds, held.series.id] });
    } else {
      held.duplicateIds.push(s.id);
    }
  }
  return [...byIdentity.values()];
}

// ─── Occurrences ─────────────────────────────────────────────────────────────

export type OccurrenceStatus = "done" | "skipped" | "overdue" | "past" | "today" | "upcoming";

export interface CalendarOccurrence {
  /** Unique per rendered row: `${seriesId}@${date}`. */
  id: string;
  seriesId: string;
  /** Semantic identity of the parent series — equal across duplicates. */
  identityKey: string;
  kind: OccurrenceKind;
  title: string;
  subtitle?: string;
  source: OccurrenceSource;
  /** The on-grid date this occurrence belongs to (never changes). */
  date: string;
  /** Where it actually falls after a move. Equals `date` unless moved. */
  effectiveDate: string;
  moved: boolean;
  status: OccurrenceStatus;
  amount?: number;
  /** The series this came from, for the detail panel. */
  series: CalendarSeries;
}

function statusFor(
  series: CalendarSeries,
  date: string,
  todayISO: string,
  requireComplete: boolean,
): OccurrenceStatus {
  if (series.completedDates?.includes(date)) return "done";
  if (series.skippedDates?.includes(date)) return "skipped";
  if (date < todayISO) return requireComplete ? "overdue" : "past";
  if (date === todayISO) return "today";
  return "upcoming";
}

export interface GenerateOptions {
  /** Caller's tz-local today, YYYY-MM-DD. */
  todayISO: string;
  /** Days of history to include. Default 0 (future only). */
  lookbackDays?: number;
  /** Override the kind's horizon. Use to honour an auto-extend request. */
  horizonDays?: number;
  /** Hard cap on generated rows per series. Default 400. */
  cap?: number;
  /** Treat missed occurrences as overdue rather than merely past. */
  requireComplete?: boolean;
}

/**
 * Every occurrence of ONE series inside its horizon.
 *
 * Paused and archived series generate nothing — they must vanish from every
 * surface at once, which is only guaranteed if the generator itself refuses.
 */
export function generateSeriesOccurrences(
  series: CalendarSeries,
  opts: GenerateOptions,
): CalendarOccurrence[] {
  if (!series || !series.baseDate) return [];
  if (series.paused || series.archived) return [];

  const today = opts.todayISO;
  const lookback = Math.max(0, opts.lookbackDays ?? 0);
  const horizon = opts.horizonDays ?? horizonDaysFor(series.kind);
  const windowStart = addDaysISO(today, -lookback);
  const windowEnd = addDaysISO(today, horizon);
  const identityKey = seriesIdentityKey(series);
  const moved = series.movedDates || {};

  const dates = expandRecurrenceDates(series.baseDate, series.recurrence || "none", {
    recurrenceEnd: series.recurrenceEnd,
    windowStart,
    windowEnd,
    cap: opts.cap ?? 400,
  });

  return dates.map((date) => {
    const effectiveDate = moved[date] || date;
    return {
      id: `${series.id}@${date}`,
      seriesId: series.id,
      identityKey,
      kind: series.kind,
      title: series.title,
      subtitle: series.subtitle,
      source: series.source,
      date,
      effectiveDate,
      moved: effectiveDate !== date,
      status: statusFor(series, date, today, !!opts.requireComplete),
      amount: series.amount,
      series,
    };
  });
}

/**
 * The whole calendar: dedupe the series, expand each one, and return a single
 * date-sorted stream with no duplicate occurrences.
 *
 * The second dedup pass (by identity + date) is a belt-and-braces guarantee.
 * Series-level dedup already collapses two sources of Joe's birthday, but if
 * an adapter ever emits the same identity twice with different series ids,
 * this still yields ONE row per date rather than two.
 */
export function buildCalendarOccurrences(
  list: readonly CalendarSeries[],
  opts: GenerateOptions,
): CalendarOccurrence[] {
  const survivors = dedupeSeries(list);
  const out: CalendarOccurrence[] = [];
  const seen = new Set<string>();
  for (const { series } of survivors) {
    for (const occ of generateSeriesOccurrences(series, opts)) {
      const dedupKey = `${occ.identityKey}@${occ.date}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      out.push(occ);
    }
  }
  out.sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate) || a.title.localeCompare(b.title));
  return out;
}

/** Occurrences falling on one calendar day (by effective date). */
export function occurrencesOnDate(
  occurrences: readonly CalendarOccurrence[],
  dateISO: string,
): CalendarOccurrence[] {
  return occurrences.filter((o) => o.effectiveDate === dateISO);
}

/** The next occurrence of a series on/after today that isn't done or skipped. */
export function nextOccurrenceOf(
  occurrences: readonly CalendarOccurrence[],
  seriesId: string,
  todayISO: string,
): CalendarOccurrence | null {
  for (const o of occurrences) {
    if (o.seriesId !== seriesId) continue;
    if (o.effectiveDate < todayISO) continue;
    if (o.status === "done" || o.status === "skipped") continue;
    return o;
  }
  return null;
}

// ─── Auto-extend ─────────────────────────────────────────────────────────────

/**
 * Does this series need a wider window?
 *
 * True when its furthest generated occurrence is closer than
 * HORIZON_REFRESH_RATIO of the kind's required horizon — i.e. the calendar is
 * running out of future dates and would soon show the series as "finished"
 * when it isn't. A series with a real end date that has genuinely passed is
 * NOT extended; it's over.
 *
 * Non-recurring series never need extension.
 */
export function needsHorizonExtension(
  series: CalendarSeries,
  occurrences: readonly CalendarOccurrence[],
  todayISO: string,
): boolean {
  if (!series || !series.recurrence || series.recurrence === "none") return false;
  if (series.paused || series.archived) return false;
  const own = occurrences.filter((o) => o.seriesId === series.id);
  const required = horizonDaysFor(series.kind);
  const threshold = addDaysISO(todayISO, Math.floor(required * HORIZON_REFRESH_RATIO));
  const furthest = own.reduce((max, o) => (o.date > max ? o.date : max), "");
  // The series ends before the threshold anyway — that's a finished series,
  // not an exhausted window.
  if (series.recurrenceEnd && series.recurrenceEnd <= threshold) return false;
  if (!furthest) return true; // nothing generated at all
  return furthest < threshold;
}

/**
 * The horizon to regenerate with, for a series that ran short. Doubles the
 * required horizon so the extension doesn't immediately need extending again.
 */
export function extendedHorizonFor(kind: OccurrenceKind): number {
  return horizonDaysFor(kind) * 2;
}

// ─── Source routing ──────────────────────────────────────────────────────────

/**
 * Where tapping an occurrence must navigate.
 *
 * User requirement: "Every calendar event should always know where it came
 * from. Pressing Joe's Birthday should open Joe's profile, not a generic
 * page." The old aggregator hard-coded `#/calendar` for every event and
 * `#/obligations` for every bill, so every tap landed on a list.
 *
 * A profile-owned date always routes to that profile — that is the record the
 * user edits. Only when there is no profile do we fall back to the owning
 * system's own page.
 */
export function sourceHref(
  system: SourceSystem,
  recordId: string,
  profileId?: string,
): string {
  if (profileId) return `#/profiles/${profileId}`;
  switch (system) {
    case "profile": return recordId ? `#/profiles/${recordId}` : "#/profiles";
    case "liability": return recordId ? `#/profiles/${recordId}` : "#/liabilities";
    case "obligation": return recordId ? `#/obligations?focus=${recordId}` : "#/obligations";
    case "task": return recordId ? `#/tasks?focus=${recordId}` : "#/tasks";
    case "document": return recordId ? `#/documents?focus=${recordId}` : "#/documents";
    case "goal": return recordId ? `#/goals?focus=${recordId}` : "#/goals";
    case "habit": return recordId ? `#/habits?focus=${recordId}` : "#/habits";
    case "reminder": return "#/calendar";
    case "event": return recordId ? `#/calendar?event=${recordId}` : "#/calendar";
    default: return "#/calendar";
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/** "in 3 days" / "today" / "2 days ago" for an occurrence date. */
export function relativeDayLabel(dateISO: string, todayISO: string): string {
  const days = Math.round(
    (new Date(`${dateISO}T12:00:00`).getTime() - new Date(`${todayISO}T12:00:00`).getTime()) / 86400000,
  );
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days < 30) return `in ${days} days`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `in ${months} mo`;
  return `in ${Math.round(days / 365.25)} yr`;
}

/** A yearly series' next anniversary of `baseDate`, on/after today. */
export function nextAnnual(baseDate: string, todayISO: string): string | null {
  const base = String(baseDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const todayYear = Number(todayISO.slice(0, 4));
  const baseYear = Number(base.slice(0, 4));
  for (let y = Math.max(0, todayYear - baseYear); y <= todayYear - baseYear + 2; y++) {
    const candidate = addYearsISO(base, y);
    if (candidate >= todayISO) return candidate;
  }
  return null;
}
