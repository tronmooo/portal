// shared/temporal-rules.ts — THE TEMPORAL LAYER.
//
// The second half of the unified router. Once the semantic layer has decided
// WHAT the user meant and the canonical record has been written, exactly one
// question remains:
//
//   Does this object contain ACTIONABLE time? If so, what Date Rule does it
//   own, and what identifies that rule so we never create it twice?
//
// ─── WHERE DATE RULES LIVE IN THIS APP ──────────────────────────────────────
//
// There is no `date_rules` table and this module does not add one. In Portol a
// Date Rule is DERIVED, not stored: shared/calendar-adapters turns every
// canonical record (profile DOB, document expiration, task due date, liability
// schedule, obligation, event recurrence) into a `CalendarSeries`, and
// shared/calendar-occurrences expands those series into the dates the Calendar,
// Upcoming, Recurring & Important Dates and Executive surfaces all draw.
//
// That is already ONE temporal system, and it is the right one — a stored rule
// table would be a second copy of the truth that has to be kept in sync with
// the record it describes, which is precisely the class of bug (Joe's birthday
// appearing twice, from a profile field AND an event) the occurrence engine was
// built to end.
//
// So "create/update the Date Rule" means: make sure the CANONICAL RECORD
// carries the temporal fields the adapters read, then re-derive. This module is
// the contract for that — it names the rule types, computes the idempotency
// key, states which entities never produce a rule and why, and re-derives rules
// for one entity through the same adapters every surface uses.
//
// Pure, dependency-free, no I/O. Pinned by tests/temporal-rules.test.ts.

import type { CalendarSeries, OccurrenceKind } from "./calendar-occurrences";
import { seriesFromAll, type CalendarInputs } from "./calendar-adapters";
import { classifyDateField } from "./date-rules";

// ─── Rule vocabulary ─────────────────────────────────────────────────────────

/**
 * What KIND of temporal behaviour a rule expresses. Deliberately open-ended:
 * the spec asks for the list to stay extensible, and every entry here maps onto
 * an `OccurrenceKind` the calendar already knows how to draw.
 */
export type DateRuleType =
  | "task_due"
  | "recurring_task"
  | "birthday"
  | "anniversary"
  | "expiration"
  | "renewal"
  | "appointment"
  | "event"
  | "payment"
  | "subscription"
  | "liability"
  | "habit"
  | "deadline"
  | "follow_up";

/** Which canonical system owns the record a rule was derived from. */
export type RuleSourceSystem =
  | "task" | "event" | "profile" | "document" | "obligation" | "liability" | "habit" | "goal";

export interface DateRule {
  /** Idempotency key — see `dateRuleKey`. Stable across re-derivations. */
  key: string;
  ruleType: DateRuleType;
  /** The occurrence kind the calendar draws this as. */
  kind: OccurrenceKind;
  title: string;
  source: {
    system: RuleSourceSystem;
    /** Record id inside that system. */
    id: string;
    /** Which FIELD of the record carries the date. Part of the identity. */
    field: string;
    /** Every profile the rule belongs to — profile isolation is enforced here. */
    ownerIds: string[];
    href: string;
  };
  /** First date, YYYY-MM-DD. */
  baseDate: string;
  /** none | daily | weekly | biweekly | monthly | yearly | weekdays | … */
  recurrence: string;
  recurrenceEnd?: string;
  /** True when the rule repeats — these are what "Recurring & Important Dates" lists. */
  recurring: boolean;
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

/**
 * The identity of a Date Rule, exactly as the spec specifies it:
 *
 *   user + source entity + source field + rule type
 *
 * A retried chat turn, a re-run import and a manual edit that lands on the same
 * record all compute the SAME key, so they update one rule instead of stacking
 * three. The record id is in the key, which is why re-deriving is safe: the
 * rule cannot fork just because the derivation ran twice.
 */
export function dateRuleKey(
  userId: string,
  system: RuleSourceSystem,
  sourceId: string,
  field: string,
  ruleType: DateRuleType,
): string {
  const part = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return [part(userId), part(system), part(sourceId), part(field), part(ruleType)].join("|");
}

// ─── Entities that never produce a rule ──────────────────────────────────────

/**
 * NOTES AND JOURNAL ENTRIES DO NOT OWN DATE RULES.
 *
 * A journal entry's `entry_date` says WHEN THE EXPERIENCE HAPPENED. It is not
 * an upcoming commitment, and promoting it to the calendar would put every
 * diary entry the user has ever written onto their schedule. Likewise a note
 * that records "Robert moved to California in 2018" holds a year, not a date to
 * be reminded about.
 *
 * Actionable time found INSIDE that content is a different matter: it belongs
 * to a Task, an Event or a structured record, created alongside the Note or
 * Journal Entry — never instead of it, and never by silently rewriting the
 * content the user asked to save.
 */
export const NON_TEMPORAL_ENTITIES: ReadonlySet<string> = new Set(["note", "journal", "memory", "artifact"]);

export function ownsDateRules(entityKind: string): boolean {
  return !NON_TEMPORAL_ENTITIES.has(String(entityKind ?? "").toLowerCase());
}

// ─── Deriving the rules a record owns ────────────────────────────────────────

const RULE_TYPE_BY_KIND: Partial<Record<OccurrenceKind, DateRuleType>> = {
  birthday: "birthday",
  anniversary: "anniversary",
  subscription: "subscription",
  liability: "liability",
  bill: "payment",
  renewal: "renewal",
  maintenance: "follow_up",
  appointment: "appointment",
  habit: "habit",
  document: "expiration",
  event: "event",
  custom: "event",
};

/** Which FIELD of the source record carried the date, per occurrence kind. */
const RULE_FIELD_BY_KIND: Partial<Record<OccurrenceKind, string>> = {
  birthday: "fields.birthday",
  anniversary: "fields.anniversary",
  document: "expirationDate",
  subscription: "nextPaymentDate",
  liability: "dueDate",
  bill: "dueDate",
  renewal: "renewalDate",
  appointment: "date",
  event: "date",
  habit: "schedule",
  task: "dueDate",
};

const REPEATS = (recurrence: string): boolean =>
  !!recurrence && recurrence !== "none" && recurrence !== "once";

/** One CalendarSeries → one DateRule descriptor. */
export function ruleFromSeries(userId: string, series: CalendarSeries): DateRule {
  const kind = series.kind;
  const recurring = REPEATS(series.recurrence);
  const ruleType: DateRuleType =
    kind === "task" ? (recurring ? "recurring_task" : "task_due")
      : (RULE_TYPE_BY_KIND[kind] ?? "event");
  const field = RULE_FIELD_BY_KIND[kind] ?? "date";
  const system = series.source.system as RuleSourceSystem;
  const ownerIds = Array.from(
    new Set([...(series.source.ownerIds || []), series.source.profileId].filter(Boolean) as string[]),
  );
  return {
    key: dateRuleKey(userId, system, series.source.id, field, ruleType),
    ruleType,
    kind,
    title: series.title,
    source: { system, id: series.source.id, field, ownerIds, href: series.source.href },
    baseDate: series.baseDate,
    recurrence: series.recurrence || "none",
    recurrenceEnd: series.recurrenceEnd,
    recurring,
  };
}

/**
 * Every Date Rule the given records own, derived through the SAME adapters the
 * calendar uses. Callers pass only the slice they changed (one task, one
 * profile) and get back the rules that slice produces.
 *
 * A task with no due date yields NOTHING — that is the correct and intended
 * answer, and it is why "Buy dog food" never lands on the calendar.
 */
export function deriveDateRules(userId: string, inputs: CalendarInputs): DateRule[] {
  return seriesFromAll(inputs)
    .filter((s) => !s.archived)
    .map((s) => ruleFromSeries(userId, s));
}

/** The rules owned by ONE record, keyed by its system. */
export function deriveDateRulesForRecord(
  userId: string,
  system: RuleSourceSystem,
  record: any,
): DateRule[] {
  if (!record) return [];
  const inputs: CalendarInputs =
    system === "task" ? { tasks: [record] }
      : system === "event" ? { events: [record] }
      : system === "profile" ? { profiles: [record] }
      : system === "document" ? { documents: [record] }
      : system === "obligation" ? { obligations: [record] }
      : system === "liability" ? { profiles: [record] }
      : {};
  return deriveDateRules(userId, inputs).filter((r) => r.source.id === String(record.id ?? ""));
}

// ─── Reference, don't duplicate ──────────────────────────────────────────────
//
// The rule the whole architecture rests on: a date that a canonical record
// ALREADY owns must not also be copied into a second record.
//
// The document-extraction door is where this went wrong. It saves an extracted
// field to the document/profile AND creates a standalone CalendarEvent for the
// same date. But `seriesFromDocuments` already derives a rule from a document's
// expiration key, and `seriesFromProfiles` already derives a yearly rule from a
// profile's date-of-birth — so the calendar drew the fact twice, from two
// records that will drift apart the moment either is edited. (This is the same
// shape as the original "Joe's birthday appears twice" bug, arriving through a
// different door.)
//
// These predicates name the fields the adapters already read, so the extraction
// path can skip the copy and let the canonical record be the calendar entry.

// (The three hard-coded key lists that used to live here — DOCUMENT_RULE_KEYS,
// PROFILE_RULE_KEYS, PROFILE_ANNIVERSARY_KEYS — are gone. Enumerating spellings
// is the failure this whole layer exists to end: a fourth list disagrees with
// the other three the moment a document says `exp_date` instead of
// `expirationDate`. `classifyDateField` (shared/date-rules) is the one
// vocabulary, and it reads any spelling.)

export interface CanonicalDateCoverage {
  /** True when a canonical record already puts this date on the calendar. */
  covered: boolean;
  /** Which record owns it, when covered. */
  system?: RuleSourceSystem;
  ruleType?: DateRuleType;
  /** Why — safe to show in an extraction summary. */
  reason?: string;
}

/**
 * Would saving this extracted field ALREADY produce a calendar date on its own?
 *
 * When the answer is yes, the caller must NOT also create a standalone event:
 * the canonical record is the calendar entry, and everything else references it.
 *
 * `hasDocument` distinguishes "this field is being written onto a document
 * record" (whose expiration the document adapter reads) from a loose field.
 */
export function canonicalDateCoverage(
  fieldKey: string,
  opts: { hasDocument?: boolean; hasProfile?: boolean } = {},
): CanonicalDateCoverage {
  const key = String(fieldKey ?? "").trim();
  if (!key) return { covered: false };
  const cls = classifyDateField(key);

  if (opts.hasProfile !== false && cls.ruleType === "birthday") {
    return {
      covered: true, system: "profile", ruleType: "birthday",
      reason: "the profile's date of birth already generates a yearly birthday on the calendar",
    };
  }
  if (opts.hasProfile !== false && cls.ruleType === "anniversary") {
    return {
      covered: true, system: "profile", ruleType: "anniversary",
      reason: "the profile's anniversary field already generates a yearly date on the calendar",
    };
  }
  if (opts.hasDocument && (cls.ruleType === "expiration" || cls.ruleType === "renewal")) {
    return {
      covered: true, system: "document", ruleType: "expiration",
      reason: "the document's expiration field already generates its expiry on the calendar",
    };
  }
  return { covered: false };
}

// ─── Actionable time inside prose ────────────────────────────────────────────

/**
 * Does this Note/Journal text mention a date that a reasonable person would
 * expect on their calendar?
 *
 * Used for SUGGESTION ONLY. The spec is explicit that an explicitly-requested
 * Note is never silently replaced by a Task, so a hit here is reported back to
 * the model as "this may also deserve a Task/Event" and the user's Note is
 * written either way.
 *
 * Deliberately narrow. A bare year ("moved to California in 2018") and a past
 * date are informational; a future-dated appointment, deadline or due date is
 * not.
 */
const ACTIONABLE_DATE_CUES =
  /\b(?:appointment|due|deadline|expires?|expiration|renew(?:al|s)?|meeting|follow[-\s]?up|come\s+back|check[-\s]?up|starts?|ends?|closing|court|interview|flight|surgery)\b/i;

const CALENDAR_DATE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|tomorrow|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

export interface ActionableTimeHint {
  /** True when the text carries a date AND a cue that the date is actionable. */
  actionable: boolean;
  /** The matched date-ish text, for the model to resolve to an ISO date. */
  dateText: string | null;
  /** The cue word that made it actionable. */
  cue: string | null;
}

export function findActionableTime(text: string): ActionableTimeHint {
  const raw = String(text ?? "");
  const date = raw.match(CALENDAR_DATE);
  const cue = raw.match(ACTIONABLE_DATE_CUES);
  // A bare year is informational — "moved to California in 2018" is a fact.
  if (!date || !cue) return { actionable: false, dateText: date?.[0] ?? null, cue: cue?.[0] ?? null };
  return { actionable: true, dateText: date[0], cue: cue[0] };
}
