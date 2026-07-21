// ── Recurring Dates engine (2026-07-21) ───────────────────────────────────────
// Pure, no I/O. The single source of truth for the app-wide Recurring Dates
// system: anniversaries, birthdays, bills, renewals, maintenance reminders,
// appointments, subscriptions, and custom repeating dates.
//
// STORAGE MODEL — zero migration. A recurring date IS a CalendarEvent whose
// `recurrence` is set; its recurring-date metadata and per-OCCURRENCE state
// live in the event's existing `tags` array (the same trick the task
// recurrence engine uses), so everything persists through the normal events
// API and automatically shows up everywhere events already do: the calendar
// timeline, the dashboard's Upcoming Dates stream, notifications, and the
// linked profile/asset pages (via linkedProfiles).
//
// Tag vocabulary:
//   rdate                 managed Recurring Date (created via the manager)
//   rd:kind:<kind>        anniversary | birthday | bill | renewal | maintenance
//                         | appointment | subscription | custom
//   rd:remind:<n>         reminder lead time in days (0 = on the day)
//   rd:require            completion required — missed occurrences go overdue
//   rd:paused             series paused — future occurrences hidden everywhere
//   rd:archived           archived — hidden everywhere except the manager
//   rd:done:<YYYY-MM-DD>  that ONE occurrence is checked off (series stays live)
//   rd:skip:<YYYY-MM-DD>  that ONE occurrence is skipped/removed
//
// Checking off this year's anniversary marks only that date done — next
// year's occurrence stays active automatically, because occurrences are
// expanded on the fly from the recurrence pattern and each date's state is
// looked up independently.
//
// Pinned by tests/recurring-dates.test.ts.

import type { RecurrencePattern, EventCategory } from "./schema";

export type RecurringKind =
  | "anniversary" | "birthday" | "bill" | "renewal"
  | "maintenance" | "appointment" | "subscription" | "custom";

export interface RecurringKindDef {
  kind: RecurringKind;
  label: string;
  /** CalendarEvent.category the kind maps to (drives existing color surfaces). */
  eventCategory: EventCategory;
  /** HSL triplet "H S% L%" for manager UI accents. */
  hsl: string;
}

export const RECURRING_KINDS: RecurringKindDef[] = [
  { kind: "anniversary", label: "Anniversary", eventCategory: "family", hsl: "330 75% 60%" },
  { kind: "birthday", label: "Birthday", eventCategory: "family", hsl: "262 75% 64%" },
  { kind: "bill", label: "Bill", eventCategory: "finance", hsl: "0 72% 58%" },
  { kind: "renewal", label: "Renewal", eventCategory: "finance", hsl: "38 92% 52%" },
  { kind: "maintenance", label: "Maintenance", eventCategory: "other", hsl: "199 85% 55%" },
  { kind: "appointment", label: "Appointment", eventCategory: "health", hsl: "155 62% 44%" },
  { kind: "subscription", label: "Subscription", eventCategory: "finance", hsl: "220 80% 62%" },
  { kind: "custom", label: "Custom", eventCategory: "personal", hsl: "240 8% 60%" },
];

export const kindDef = (k: string | null | undefined): RecurringKindDef =>
  RECURRING_KINDS.find(d => d.kind === k) || RECURRING_KINDS[RECURRING_KINDS.length - 1];

export const RD_TAG = "rdate";
const RD_PREFIX = "rd:";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RecurringMeta {
  /** true when the event was created/adopted by the Recurring Dates manager. */
  isRecurringDate: boolean;
  kind: RecurringKind | null;
  /** days before an occurrence to remind; null = no reminder configured. */
  remindDays: number | null;
  requireComplete: boolean;
  paused: boolean;
  archived: boolean;
  completedDates: string[];
  skippedDates: string[];
}

export function parseRecurringMeta(tags: string[] | null | undefined): RecurringMeta {
  const t = Array.isArray(tags) ? tags : [];
  const meta: RecurringMeta = {
    isRecurringDate: t.includes(RD_TAG),
    kind: null,
    remindDays: null,
    requireComplete: t.includes("rd:require"),
    paused: t.includes("rd:paused"),
    archived: t.includes("rd:archived"),
    completedDates: [],
    skippedDates: [],
  };
  for (const tag of t) {
    if (!tag.startsWith(RD_PREFIX)) continue;
    if (tag.startsWith("rd:kind:")) {
      const k = tag.slice(8);
      if (RECURRING_KINDS.some(d => d.kind === k)) meta.kind = k as RecurringKind;
    } else if (tag.startsWith("rd:remind:")) {
      const n = parseInt(tag.slice(10), 10);
      if (Number.isFinite(n) && n >= 0) meta.remindDays = n;
    } else if (tag.startsWith("rd:done:")) {
      const d = tag.slice(8);
      if (DATE_RE.test(d)) meta.completedDates.push(d);
    } else if (tag.startsWith("rd:skip:")) {
      const d = tag.slice(8);
      if (DATE_RE.test(d)) meta.skippedDates.push(d);
    }
  }
  return meta;
}

/** Rebuild the rd:* tags from meta, preserving every non-rd tag. */
export function metaToTags(meta: RecurringMeta, existingTags: string[] | null | undefined): string[] {
  const base = (Array.isArray(existingTags) ? existingTags : [])
    .filter(t => t !== RD_TAG && !t.startsWith(RD_PREFIX));
  const out = [...base];
  if (meta.isRecurringDate) out.push(RD_TAG);
  if (meta.kind) out.push(`rd:kind:${meta.kind}`);
  if (meta.remindDays != null && meta.remindDays >= 0) out.push(`rd:remind:${meta.remindDays}`);
  if (meta.requireComplete) out.push("rd:require");
  if (meta.paused) out.push("rd:paused");
  if (meta.archived) out.push("rd:archived");
  for (const d of Array.from(new Set(meta.completedDates)).sort()) out.push(`rd:done:${d}`);
  for (const d of Array.from(new Set(meta.skippedDates)).sort()) out.push(`rd:skip:${d}`);
  return out;
}

/** Mark ONE occurrence done/skipped (or clear its marks) without touching the
 * rest of the series. */
export function markOccurrence(
  tags: string[] | null | undefined,
  dateISO: string,
  action: "done" | "skip" | "clear",
): string[] {
  const meta = parseRecurringMeta(tags);
  meta.completedDates = meta.completedDates.filter(d => d !== dateISO);
  meta.skippedDates = meta.skippedDates.filter(d => d !== dateISO);
  if (action === "done") meta.completedDates.push(dateISO);
  if (action === "skip") meta.skippedDates.push(dateISO);
  return metaToTags(meta, tags);
}

export function setSeriesFlag(
  tags: string[] | null | undefined,
  flag: "paused" | "archived",
  on: boolean,
): string[] {
  const meta = parseRecurringMeta(tags);
  meta[flag] = on;
  return metaToTags(meta, tags);
}

/** Drop done/skip marks older than `keepDays` (and hard-cap the count) so a
 * daily series can't grow its tags without bound. Yearly marks stay well
 * within the window that matters for display. */
export function pruneOccurrenceTags(
  tags: string[] | null | undefined,
  todayISO: string,
  keepDays = 400,
  maxMarks = 250,
): string[] {
  const meta = parseRecurringMeta(tags);
  const cutoff = addDaysISO(todayISO, -keepDays);
  meta.completedDates = meta.completedDates.filter(d => d >= cutoff).slice(-maxMarks);
  meta.skippedDates = meta.skippedDates.filter(d => d >= cutoff).slice(-maxMarks);
  return metaToTags(meta, tags);
}

// ─── Occurrence expansion ─────────────────────────────────────────────────────

function parseLocal(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}
function toISO(d: Date): string {
  return d.toLocaleDateString("en-CA");
}
export function addDaysISO(iso: string, days: number): string {
  const d = parseLocal(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

/**
 * All occurrence dates of a series inside [windowStart, windowEnd], including
 * the base date when it falls in the window. Mirrors the server calendar
 * timeline's expansion semantics exactly (same pattern switch, same cap).
 */
export function expandRecurrenceDates(
  baseDate: string,
  recurrence: RecurrencePattern | string,
  opts: { recurrenceEnd?: string; windowStart: string; windowEnd: string; cap?: number },
): string[] {
  const base = String(baseDate || "").slice(0, 10);
  if (!DATE_RE.test(base)) return [];
  const { windowStart, windowEnd, recurrenceEnd } = opts;
  const cap = opts.cap ?? 500;
  const out: string[] = [];
  if (base >= windowStart && base <= windowEnd) out.push(base);
  if (!recurrence || recurrence === "none") return out;
  const d = parseLocal(base);
  for (let i = 0; i < cap; i++) {
    switch (recurrence) {
      case "daily": d.setDate(d.getDate() + 1); break;
      case "weekdays": do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); break;
      case "weekends": do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 0 && d.getDay() !== 6); break;
      case "weekly": d.setDate(d.getDate() + 7); break;
      case "biweekly": d.setDate(d.getDate() + 14); break;
      case "monthly": d.setMonth(d.getMonth() + 1); break;
      case "yearly": d.setFullYear(d.getFullYear() + 1); break;
      default: return out;
    }
    const iso = toISO(d);
    if (iso > windowEnd) break;
    if (recurrenceEnd && iso > recurrenceEnd) break;
    if (iso >= windowStart) out.push(iso);
  }
  return out;
}

export interface RecurringEventLike {
  date: string;
  recurrence: RecurrencePattern | string;
  recurrenceEnd?: string | null;
  tags?: string[] | null;
}

/**
 * The next ACTIVE occurrence on/after `todayISO` — skipped and already-checked
 * -off dates are passed over (checking off this year's anniversary makes next
 * year's the "next"). Returns null when the series is paused, archived, or has
 * ended.
 */
export function nextOccurrence(ev: RecurringEventLike, todayISO: string): string | null {
  const meta = parseRecurringMeta(ev.tags);
  if (meta.paused || meta.archived) return null;
  const skip = new Set([...meta.skippedDates, ...meta.completedDates]);
  // Look ahead up to 3 years — covers yearly series with a couple of skips.
  const windowEnd = addDaysISO(todayISO, 366 * 3);
  const dates = expandRecurrenceDates(ev.date, ev.recurrence, {
    recurrenceEnd: ev.recurrenceEnd || undefined,
    windowStart: todayISO,
    windowEnd,
    cap: 1200,
  });
  for (const d of dates) if (!skip.has(d)) return d;
  return null;
}

// ─── Status derivation ────────────────────────────────────────────────────────

export type OccurrenceStatus = "done" | "skipped" | "overdue" | "past" | "today" | "upcoming";

export function occurrenceStatus(meta: RecurringMeta, dateISO: string, todayISO: string): OccurrenceStatus {
  if (meta.completedDates.includes(dateISO)) return "done";
  if (meta.skippedDates.includes(dateISO)) return "skipped";
  if (dateISO < todayISO) return meta.requireComplete ? "overdue" : "past";
  if (dateISO === todayISO) return "today";
  return "upcoming";
}

export type SeriesStatus = "archived" | "paused" | "overdue" | "upcoming" | "completed";

/** How far back the overdue scan looks — bounded so daily series stay cheap. */
const OVERDUE_LOOKBACK_DAYS = 92;

/**
 * Overall series state for the manager's Upcoming / Overdue / Completed /
 * Paused / Archived buckets. "completed" = the series has no future
 * occurrence left (ended by recurrenceEnd or every remaining date handled).
 */
export function seriesStatus(ev: RecurringEventLike, todayISO: string): SeriesStatus {
  const meta = parseRecurringMeta(ev.tags);
  if (meta.archived) return "archived";
  if (meta.paused) return "paused";
  if (meta.requireComplete) {
    const from = addDaysISO(todayISO, -OVERDUE_LOOKBACK_DAYS);
    const windowStart = ev.date > from ? ev.date.slice(0, 10) : from;
    const past = expandRecurrenceDates(ev.date, ev.recurrence, {
      recurrenceEnd: ev.recurrenceEnd || undefined,
      windowStart,
      windowEnd: addDaysISO(todayISO, -1),
      cap: OVERDUE_LOOKBACK_DAYS + 2,
    });
    if (past.some(d => occurrenceStatus(meta, d, todayISO) === "overdue")) return "overdue";
  }
  return nextOccurrence(ev, todayISO) ? "upcoming" : "completed";
}

/** Missed required occurrences in the recent window (drives notifications). */
export function missedOccurrences(ev: RecurringEventLike, todayISO: string, lookbackDays = 45): string[] {
  const meta = parseRecurringMeta(ev.tags);
  if (!meta.requireComplete || meta.archived) return [];
  const from = addDaysISO(todayISO, -lookbackDays);
  const windowStart = ev.date > from ? ev.date.slice(0, 10) : from;
  return expandRecurrenceDates(ev.date, ev.recurrence, {
    recurrenceEnd: ev.recurrenceEnd || undefined,
    windowStart,
    windowEnd: addDaysISO(todayISO, -1),
    cap: lookbackDays + 2,
  }).filter(d => occurrenceStatus(meta, d, todayISO) === "overdue");
}

// ─── Labels ───────────────────────────────────────────────────────────────────

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function humanRecurrenceLabel(recurrence: string, baseDate?: string): string {
  const d = baseDate && DATE_RE.test(baseDate.slice(0, 10)) ? parseLocal(baseDate) : null;
  switch (recurrence) {
    case "daily": return "Every day";
    case "weekdays": return "Every weekday (Mon–Fri)";
    case "weekends": return "Every weekend";
    case "weekly": return d ? `Weekly on ${DOW[d.getDay()]}` : "Weekly";
    case "biweekly": return d ? `Every 2 weeks on ${DOW[d.getDay()]}` : "Every 2 weeks";
    case "monthly": return d ? `Monthly on day ${d.getDate()}` : "Monthly";
    case "yearly": return d ? `Every year on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Yearly";
    default: return "Does not repeat";
  }
}

export const REMINDER_PRESETS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "No reminder" },
  { value: 0, label: "On the day" },
  { value: 1, label: "1 day before" },
  { value: 3, label: "3 days before" },
  { value: 7, label: "1 week before" },
  { value: 14, label: "2 weeks before" },
  { value: 30, label: "1 month before" },
];
