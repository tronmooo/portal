// shared/date-rules.ts — THE Date Rule engine.
//
// ─── Why this file exists ────────────────────────────────────────────────────
//
// User report (2026-08-20): "I extracted somebody's date of birth and their
// driver's license expiration date. The information itself was saved, but no
// rules were created" — the Recurring & Important Dates screen read "All 0".
//
// Two root causes, both proven by probe:
//
//   1. WRITE SIDE. Extraction saves a date exactly as the document printed it
//      ("07/10/1994"). Every downstream date consumer requires ISO
//      (`/^\d{4}-\d{2}-\d{2}/`), so the value was stored, displayed on the
//      profile… and invisible to every calendar/upcoming/recurring surface.
//      Nothing was "missing a rule" — the rule could not see the date at all.
//
//   2. READ SIDE. Three independent vocabularies decided which field on which
//      entity is a meaningful date:
//        • shared/calendar-adapters   — profiles: birthday + anniversary ONLY;
//                                       documents: 10 expiry key spellings.
//        • shared/upcoming-dates      — profiles: license/passport/registration/
//                                       warranty/lease…; documents: ONE key
//                                       spelling (`expirationDate`).
//        • supabase-storage timeline  — documents: `doc.expirationDate`, a
//                                       field `rowToDocument` never populates,
//                                       so it was dead code: document
//                                       expirations never reached the Calendar.
//      A profile-carried licence expiration therefore showed in Upcoming and
//      nowhere else; a document-carried one showed in Recurring and nowhere
//      else; a snake_case one showed nowhere.
//
// This module replaces all three vocabularies with ONE.
//
// ─── The model ───────────────────────────────────────────────────────────────
//
//   Entity owns the data.      (profile.fields.dateOfBirth = 1994-07-10)
//   Date Rule owns behaviour.  (birthday · yearly · Jul 10 · countdown off)
//   Calendar derives dates.    (2026-07-10, 2027-07-10, …)
//
// Date Rules are DERIVED, not stored. That is a deliberate architectural
// choice, not a shortcut — the user asked for "a reliable, queryable
// representation" and explicitly said to use the architecture that fits the
// codebase. A derived rule gets, by construction and with no sync code:
//
//   • idempotency        — the id is a pure function of (entity, field, type),
//                          so re-running extraction can never mint a second
//                          rule for the same real-world date;
//   • lifecycle sync     — change the DOB and the rule moves; delete the
//                          document and its rule is simply not derived again.
//                          An orphaned rule is unrepresentable;
//   • zero backfill      — historical rows produce their rules on the first
//                          read, including the non-ISO ones (this engine
//                          normalizes on read as well as on write).
//
// Rules are still first-class and queryable: `GET /api/date-rules` serves them,
// and the Recurring & Important Dates screen lists them as rules.
//
// Pure, dependency-free. Pinned by tests/date-rules.test.ts.

import { normalizeDateString } from "./extraction-normalize";
import type { CalendarSeries, OccurrenceKind } from "./calendar-occurrences";
import { sourceHref } from "./calendar-occurrences";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * What a date MEANS. Extensible: adding a member here plus a matcher in
 * `FIELD_MATCHERS` teaches the whole app — calendar, upcoming, important
 * dates, executive, countdowns — about a new kind of date at once.
 */
export type DateRuleType =
  | "birthday"
  | "anniversary"
  | "expiration"
  | "renewal"
  | "payment"
  | "income"
  | "due"
  | "appointment"
  | "deadline"
  | "reminder"
  | "event"
  | "start"
  | "end"
  | "cancellation"
  | "maintenance"
  | "informational";

/** One-off important date vs a genuinely repeating rule. */
export type OccurrenceType = "one_time" | "recurring";

/** The systems a rule can be derived from. Mirrors `SourceSystem`. */
export type DateRuleSourceType =
  | "profile"
  | "document"
  | "obligation"
  | "liability"
  | "task"
  | "event"
  | "income";

export interface DateRule {
  /**
   * Deterministic identity — a pure function of what the rule describes, never
   * of when it was created. THIS is the duplicate prevention: extraction, chat
   * and the manual form all land on the same string, so re-processing the same
   * document resolves to the same rule rather than creating another.
   *
   *   `${sourceEntityType}:${sourceEntityId}:${sourceField}:${ruleType}`
   */
  id: string;
  ruleType: DateRuleType;
  /** e.g. "drivers_license", "passport", "vehicle_registration". */
  ruleSubtype?: string;
  occurrenceType: OccurrenceType;

  // ── Traceability: every rule points back at its origin ──
  sourceEntityType: DateRuleSourceType;
  sourceEntityId: string;
  /** The exact field on the source entity that carries the date. */
  sourceField: string;
  /** Dotted path when the field lives inside a nested group. */
  sourcePath: string;
  /** The value exactly as the source entity stores it, before normalization. */
  rawValue: string;

  profileId?: string;
  ownerIds: string[];
  label: string;
  subtitle?: string;
  /**
   * Documents that wrote this field onto the record (`fields._docFields`).
   * A copy is suppressed while the document that made it still holds the date —
   * see `suppressDocumentCopies`.
   */
  provenanceDocIds?: string[];

  /** Canonical ISO anchor: the DOB, the expiration, the next due date. */
  date: string;
  /** "none" for one-time rules; "yearly"/"monthly"/… for recurring ones. */
  recurrence: string;
  recurrenceEnd?: string;
  amount?: number;

  // ── Visibility: which surfaces this rule belongs on ──
  calendarVisible: boolean;
  upcomingVisible: boolean;
  importantVisible: boolean;
  countdownEnabled: boolean;
  active: boolean;

  href?: string;
}

// ─── Classification ──────────────────────────────────────────────────────────

interface FieldMatcher {
  ruleType: DateRuleType;
  /** Matched against the NORMALIZED field key (lowercase, no separators). */
  match: RegExp;
  /** Disqualifiers checked before `match`. */
  exclude?: RegExp;
  /** Recurring rules declare their cadence; one-time rules leave it out. */
  recurrence?: string;
  /** Overrides the generic subtype inference. */
  subtype?: string;
}

/**
 * Normalize a field key so every spelling collapses to one comparable form:
 *   "expiration_date" | "expirationDate" | "Expiration Date" → "expirationdate"
 *
 * This is the single fix for the three-vocabulary divergence: the matchers
 * below never have to enumerate spellings.
 */
/**
 * What a date field is ABOUT, with the date-words removed.
 *
 *   "expiration_date" | "expirationDate" | "expiry" | "validUntil" → ""
 *   "autoInsuranceExpiration"                                      → "autoinsurance"
 *   "homeInsuranceExpiration"                                      → "homeinsurance"
 *
 * Two spellings of one fact collapse to the same qualifier; two different facts
 * keep different ones. Used to decide which dates on a single entity are the
 * same date said twice.
 */
const DATE_WORDS = /(date|expiration|expires|expiry|expire|valid|until|thru|through|renewal|renews|renew|due|next|on|of)/g;

export function dateFieldQualifier(key: unknown): string {
  return String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .replace(DATE_WORDS, "")
    .replace(/\s+/g, "");
}

export function normalizeFieldKey(key: unknown): string {
  return String(key ?? "").replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
}

/**
 * Ordered — FIRST match wins, so specific patterns precede generic ones.
 *
 * Deliberately semantic rather than per-document-type: a "renewal date" means
 * the same thing on an insurance policy, a membership card and a domain name,
 * so one matcher covers document kinds this app has never seen.
 */
const FIELD_MATCHERS: FieldMatcher[] = [
  // ── Informational first: these must never reach the calendar ──
  // "Document generated on May 4" is metadata, not something to act on.
  //
  // Anything explicitly BACKWARD-looking is the same. `lastServiceDate` and
  // `previousRenewal` classify as maintenance and renewal on their nouns alone,
  // and then arrive as overdue things to act on — a service you already had.
  { ruleType: "informational", match: /^(last|previous|prior|former|past|completed|performed|paid)/ },
  {
    ruleType: "informational",
    match: /^(created|updated|modified|uploaded|scanned|printed|generated|issued?|issuedate|dateissued|dateofissue|effective|recorded|filed|entered|logged|observed|reported|timestamp|lastupdated|lastmodified|dateadded|addedon|photodate|captured|verified|dateverified|signed|datesigned|asof|asofdate)/,
  },
  // A period's own start marker is informational unless something else gives
  // it meaning (a lease start is captured by the lease matcher below).
  { ruleType: "informational", match: /^(policystart|coveragestart|periodstart|statementstart|billingperiodstart|termstart)/ },

  // ── Birthdays & anniversaries: genuinely yearly ──
  {
    ruleType: "birthday",
    match: /^(dob|dateofbirth|birthdate|birthday|birthdayd?ate|dateofbirthdob)$|^(birth)(date|day)?$/,
    recurrence: "yearly",
  },
  { ruleType: "anniversary", match: /anniversar/, recurrence: "yearly" },

  // ── Expirations: one-time important dates, NOT yearly ──
  // A driver's licence expires once. It becomes a new date when renewed; it
  // does not repeat every year, and pretending it does corrupts recurrence.
  { ruleType: "expiration", match: /^warrant(y|ies)/, subtype: "warranty" },
  { ruleType: "expiration", match: /lease(end|expir|termination|enddate)|endoflease/, subtype: "lease" },
  {
    ruleType: "expiration",
    // `expdate` / `…exp` are the abbreviated spellings the two deleted
    // vocabularies both enumerated (`exp_date`), and which
    // notification-service and insights-engine still treat as expirations.
    // Without them an `exp_date` reached no surface at all.
    match: /(expir|expiry|expires|expdate|exp$|validuntil|validthru|validthrough|validto|goodthru|goodthrough|useby|bestbefore)/,
  },

  // ── Renewals: one-time until the thing is renewed, same as expirations ──
  { ruleType: "renewal", match: /(renew|reregistration|nextregistration|registrationdue)/ },

  // ── Money ──
  // No cadence, for the same reason the income matcher carries none: a field
  // holding a date says WHEN, never how often. Forcing "monthly" turned a
  // one-off `paymentDueDate` on an invoice into an endless monthly bill. A
  // genuinely recurring charge is an obligation or a liability with its own
  // frequency, and those keep their dedicated adapters.
  {
    ruleType: "payment",
    match: /(nextpayment|nextbilling|nextcharge|billingdate|paymentdate|chargedate|nextduedate|paymentdue|billdue|autopay)/,
  },
  // Anchored, and with NO cadence. Unanchored, `depositdate` matched inside
  // `securityDepositDate` on a lease, and the biweekly default then repeated
  // that one-off forever as a paycheck. A field holding a date says WHEN, never
  // how often; a genuinely recurring paycheck is an Income record with its own
  // frequency (seriesFromIncomes), not a date scraped off a document.
  { ruleType: "income", match: /^(payday|paydate|paycheck|payschedule|nextpayday|nextpaycheck|paymentreceived)$/ },
  { ruleType: "due", match: /(duedate|due$|maturity|payoff|balancedue)/ },

  // ── Calendar-shaped ──
  //
  // The five below existed in the hand-written walker this engine replaced
  // (shared/upcoming-dates), and without them a pet's vaccination, a
  // prescription refill, a court date, a flight and a school enrolment all
  // classified as metadata and left the Upcoming feed. They are matched ahead
  // of the generic appointment/deadline patterns so their subtype survives —
  // that subtype is what names the category the dashboard shows.
  { ruleType: "appointment", match: /(vaccin|immuniz|booster)/, subtype: "vaccination" },
  { ruleType: "due", match: /(refill)/, subtype: "medication" },
  { ruleType: "deadline", match: /(court|hearing|arraign|trialdate)/, subtype: "court" },
  { ruleType: "event", match: /(departure|departs|flight|travel|checkin|checkout|reservation|itinerary)/, subtype: "travel" },
  { ruleType: "deadline", match: /(enrollment|enrolment|applicationdeadline|semesterstart|termbegins)/, subtype: "school" },
  { ruleType: "appointment", match: /(appointment|visitdate|followup|nextvisit|vetvisit|nextvet|checkup|consultation|surgery|procedure)/ },
  { ruleType: "deadline", match: /(deadline|filingdate|filingdeadline|submitby|respondby|applicationdue)/ },
  { ruleType: "maintenance", match: /(service|maintenance|inspection|oilchange|nextservice|smog)/ },
  { ruleType: "reminder", match: /(remind|alert)/ },

  // ── Period boundaries ──
  { ruleType: "cancellation", match: /(cancel|termination|terminationdate)/ },
  { ruleType: "end", match: /(enddate|endson|contractend|employmentend|coverageend|policyend|termend)/ },
  { ruleType: "start", match: /(startdate|startson|begins|employmentstart|hiredate|movein)/, },
];

/** Rules that describe a future deadline the user should be counting down to. */
const COUNTDOWN_TYPES = new Set<DateRuleType>([
  "expiration", "renewal", "due", "deadline", "cancellation", "end",
]);

/** Rules that belong in the "Important Dates" half of the recurring screen. */
/**
 * The types that belong on the Important Dates half of the recurring screen.
 *
 * `start` is not one of them. A start date is a fact about when something
 * began — it is on the calendar, but listing it under dates to watch made a
 * subscription that started three years ago read as overdue.
 */
const IMPORTANT_TYPES = new Set<DateRuleType>([
  "expiration", "renewal", "due", "deadline", "cancellation", "end", "maintenance",
]);

/**
 * The rule types that describe something running OUT — what belongs in an
 * "expirations" list. Narrower than `countdownEnabled`, which also covers due
 * dates and deadlines: those are bills and tasks, not documents about to lapse.
 *
 * `renewal` is not here either. A subscription's `renewalDate` is the day it
 * renews — it carries on — and listing it among documents about to expire read
 * as a warning about something that was never at risk. Renewals still appear on
 * the calendar and under Important Dates.
 */
export const EXPIRY_RULE_TYPES = new Set<DateRuleType>([
  "expiration", "end", "cancellation",
]);

/**
 * How far ahead a dated record counts as "coming up" — the Executive tab's
 * due/expiring list, the Immediate Attention window, and the badge the
 * extraction review shows against a date.
 *
 * Forty-five days, not thirty, and the parking citation that prompted it is
 * exactly why: issued 25 August, due 25 September — "next month" in every
 * human sense, and 31 days, so a 30-day window said nothing about it at all.
 * "A month out" is 28–31 days depending on the month, and a window that can
 * miss it by a day is the wrong window. Forty-five covers this month and next
 * with room to act, and still keeps the narrower promise: anything due within
 * 30 days is inside it.
 *
 * The user can still narrow or widen it (Attention filters → Documents).
 */
export const DOC_UPCOMING_WINDOW_DAYS = 45;

/**
 * A DOCUMENT's own time-sensitive dates: the ones that make the record itself
 * something to act on before a date passes.
 *
 * Deliberately separate from `EXPIRY_RULE_TYPES`. A parking citation does not
 * "expire" — it is DUE, and a due date is exactly what the user is asked to
 * act on. Restricted to document-carried dates on purpose: a `premiumDueDate`
 * typed onto an insurance PROFILE is a bill and belongs on the bills surface,
 * which is why `isDocumentAttentionRule` also tests the source.
 */
export const DOCUMENT_DUE_RULE_TYPES = new Set<DateRuleType>([
  "due", "deadline", "payment", "renewal", "maintenance",
]);

/**
 * Does this rule belong in the Executive tab's "expiring & due documents"
 * list? Something running out anywhere, or something a DOCUMENT says is due.
 */
export function isDocumentAttentionRule(
  rule: { ruleType: DateRuleType; sourceEntityType?: DateRuleSourceType },
): boolean {
  if (EXPIRY_RULE_TYPES.has(rule.ruleType)) return true;
  return rule.sourceEntityType === "document" && DOCUMENT_DUE_RULE_TYPES.has(rule.ruleType);
}

/**
 * Does this rule belong in an ALERT surface — the notification bell and the
 * dashboard's insight cards? Something running out anywhere (expiration, end,
 * cancellation), a renewal, a deadline — and, on a DOCUMENT, anything it says
 * is due (a parking citation). Money dates on a PROFILE (`payment`, `due`)
 * belong to the bills surface, and a profile's maintenance or appointment
 * dates are calendar entries, so neither raises an alert here.
 *
 * Wider than `isDocumentAttentionRule` on purpose: that list is "documents
 * about to lapse", where a renewal does not belong because the thing carries
 * on. An alert is about ACTING before a date, and every insurance definition
 * in the app names its only date `renewal_date` — a policy renewing in two
 * days, or lapsed three days ago, is exactly what a bell is for.
 */
export function isAlertDateRule(
  rule: { ruleType: DateRuleType; sourceEntityType?: DateRuleSourceType },
): boolean {
  if (ALERT_RULE_TYPES.has(rule.ruleType)) return true;
  return rule.sourceEntityType === "document" && DOCUMENT_DUE_RULE_TYPES.has(rule.ruleType);
}
const ALERT_RULE_TYPES = new Set<DateRuleType>(["expiration", "end", "cancellation", "renewal", "deadline"]);

/**
 * How an alert reads for each kind of date:
 * `[past title, ≤7-day title, later title, future verb, past verb]`.
 */
export function dateRuleAlertWords(ruleType: DateRuleType): [string, string, string, string, string] {
  return ALERT_WORDS[ruleType] || ["Overdue", "Due soon", "Due", "is due", "was due"];
}
const ALERT_WORDS: Partial<Record<DateRuleType, [string, string, string, string, string]>> = {
  expiration: ["Expired", "Expiring soon", "Expiring", "expires", "expired"],
  end: ["Ended", "Ending soon", "Ending", "ends", "ended"],
  cancellation: ["Cancelled", "Cancelling soon", "Cancelling", "cancels", "was cancelled"],
  renewal: ["Renewal passed", "Renews soon", "Renewing", "renews", "was due to renew"],
};

/**
 * The verb a countdown on this kind of date reads with — so a due date says
 * "Due in 31 days" and never "Expires in 31 days". `[future, past]`.
 */
export function dateRuleVerbs(ruleType: DateRuleType): [string, string] {
  return VERB[ruleType] || ["Due", "Was due"];
}

/** Every actionable type — i.e. everything except pure metadata. */
export function isActionableRuleType(t: DateRuleType): boolean {
  return t !== "informational";
}

export interface FieldClassification {
  ruleType: DateRuleType;
  ruleSubtype?: string;
  occurrenceType: OccurrenceType;
  recurrence: string;
  actionable: boolean;
}

/**
 * What does this field's date MEAN?
 *
 * `contextKey` is the surrounding entity's type/name ("drivers_license",
 * "Passport", "vehicle") and only ever refines the SUBTYPE — never the rule
 * type — so an unfamiliar document kind still classifies correctly.
 */
export function classifyDateField(
  fieldKey: unknown,
  contextKey?: unknown,
): FieldClassification {
  const key = normalizeFieldKey(fieldKey);
  const ctx = normalizeFieldKey(contextKey);

  for (const m of FIELD_MATCHERS) {
    if (m.exclude && m.exclude.test(key)) continue;
    if (!m.match.test(key)) continue;
    const recurrence = m.recurrence || "none";
    return {
      ruleType: m.ruleType,
      // The RAW keys, so camel-case boundaries survive: matching an
      // abbreviation like `dl` needs word edges, and the normalized form has
      // none ("dlexpiration").
      ruleSubtype: m.subtype || inferSubtype(String(fieldKey ?? ""), String(contextKey ?? "")),
      occurrenceType: recurrence === "none" ? "one_time" : "recurring",
      recurrence,
      actionable: isActionableRuleType(m.ruleType),
    };
  }

  // An unmatched date field is metadata by default. This is the "do not clutter
  // the calendar" rule: a date has to say what it is before it earns a place.
  return {
    ruleType: "informational",
    occurrenceType: "one_time",
    recurrence: "none",
    actionable: false,
  };
}

/** The THING the date is about — read from the field key, then its context. */
function inferSubtype(key: string, ctx: string): string | undefined {
  // SPACED, so `\b` means something. Both arguments arrive separator-stripped
  // ("dlexpiration"), and a pattern like `\bdl\b` could never match one — so a
  // `dlExpiration` field got no subtype, mislabelled, and (since dedupe wants
  // subtypes to agree) rendered the same expiration twice.
  const spaced = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ");
  const both = `${spaced(key)} ${spaced(ctx)}`.toLowerCase();
  if (/driver|dl\b|driving/.test(both)) return "drivers_license";
  if (/passport/.test(both)) return "passport";
  if (/visa/.test(both)) return "visa";
  if (/registration|regist/.test(both)) return "vehicle_registration";
  if (/insurance|policy|coverage/.test(both)) return "insurance";
  if (/warrant/.test(both)) return "warranty";
  if (/lease|tenanc/.test(both)) return "lease";
  if (/member/.test(both)) return "membership";
  if (/subscription/.test(both)) return "subscription";
  // A bare "license" is deliberately left UNKNOWN: it could be a driver's
  // licence, a professional one, or a software one, and naming it wrongly is
  // worse than not naming it. `dedupeRules` requires subtypes to AGREE, so an
  // unnamed one stays its own rule rather than merging into — and possibly
  // erasing — a named one. Only words that genuinely mean a credential claim
  // the subtype. (`both` is word-SPACED — see the note in `inferSubtype` — so a
  // multi-word phrase matches and `\b` on an abbreviation means something.)
  if (/certification|certificate|professional licen[sc]e|permit/.test(both)) return "certification";
  if (/mortgage|loan|credit/.test(both)) return "loan";
  if (/prescription|medication|refill|rx\b/.test(both)) return "medication";
  if (/contract|agreement/.test(both)) return "contract";
  if (/employment|job|hire/.test(both)) return "employment";
  return undefined;
}

// ─── Countdown ───────────────────────────────────────────────────────────────

const VERB: Partial<Record<DateRuleType, [string, string]>> = {
  // [future, past]
  expiration: ["Expires", "Expired"],
  renewal: ["Renews", "Renewed"],
  due: ["Due", "Was due"],
  deadline: ["Due", "Was due"],
  cancellation: ["Cancels", "Cancelled"],
  end: ["Ends", "Ended"],
  start: ["Starts", "Started"],
  maintenance: ["Due", "Was due"],
  payment: ["Due", "Was due"],
  appointment: ["In", "Was"],
  birthday: ["In", "Was"],
  anniversary: ["In", "Was"],
};

/**
 * Days between two ISO dates, calendar-exact (no DST/timezone drift — both
 * sides are read at noon UTC).
 */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/**
 * The distance to a date in years + months + days, computed by calendar
 * arithmetic rather than by dividing days (365-day years drift by a week over
 * a decade — a 2034 licence would have read "in 7 years, 9 months" when the
 * true answer is 10 months).
 */
export function calendarDelta(fromISO: string, toISO: string): {
  past: boolean; years: number; months: number; days: number; totalDays: number;
} {
  const totalDays = daysBetweenISO(fromISO, toISO);
  const past = totalDays < 0;
  const [a, b] = past ? [toISO, fromISO] : [fromISO, toISO];
  // Count WHOLE months by walking from `a`, clamping each step to the end of
  // the target month, and stop at the last one that has not passed `b`. Then
  // the remainder is a plain day count from that anchor.
  //
  // Subtracting the calendar components and borrowing once gets this wrong
  // whenever the borrow is not enough: Jan 31 → Mar 1 borrowed February's 28
  // days from a difference of -30 and produced days: -2, which the label then
  // hid by only printing days when positive — so a 29-day gap read as a bare
  // "in 1 month".
  const ay = +a.slice(0, 4), am = +a.slice(5, 7), ad = +a.slice(8, 10);
  const clampedStep = (n: number): string => {
    const total = (am - 1) + n;
    const y = ay + Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;              // 0-based
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = Math.min(ad, lastDay);
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let steps = 0;
  while (clampedStep(steps + 1) <= b) steps++;
  const years = Math.floor(steps / 12);
  const months = steps % 12;
  const days = daysBetweenISO(clampedStep(steps), b);
  return { past, years, months, days, totalDays: Math.abs(totalDays) };
}

/**
 * The human countdown, ALWAYS computed from the stored date and today —
 * never stored, never hard-coded.
 *
 *   "Expires in 7 years, 10 months"   "Expires in 92 days"
 *   "Expires tomorrow"                "Expires today"
 *   "Expired 12 days ago"
 */
export function countdownLabel(
  dateISO: string,
  todayISO: string,
  ruleType: DateRuleType = "expiration",
): string {
  const [future, pastVerb] = VERB[ruleType] || ["Due", "Was due"];
  const d = calendarDelta(todayISO, dateISO);
  if (d.totalDays === 0) return `${future} today`;
  if (!d.past && d.totalDays === 1) return `${future} tomorrow`;
  if (d.past && d.totalDays === 1) return `${pastVerb} yesterday`;

  const phrase = (() => {
    if (d.years > 0) {
      return d.months > 0
        ? `${d.years} year${d.years === 1 ? "" : "s"}, ${d.months} month${d.months === 1 ? "" : "s"}`
        : `${d.years} year${d.years === 1 ? "" : "s"}`;
    }
    if (d.months > 0) {
      return d.days > 0
        ? `${d.months} month${d.months === 1 ? "" : "s"}, ${d.days} day${d.days === 1 ? "" : "s"}`
        : `${d.months} month${d.months === 1 ? "" : "s"}`;
    }
    return `${d.totalDays} day${d.totalDays === 1 ? "" : "s"}`;
  })();

  return d.past ? `${pastVerb} ${phrase} ago` : `${future} in ${phrase}`;
}

// ─── Scanning entities for dates ─────────────────────────────────────────────

/** Month names, so "Jun 4, 2029" counts as a bare date and "after" does not. */
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/**
 * The ISO date a value IS, or null when the value merely CONTAINS one.
 *
 * `normalizeDateString` searches anywhere in a string, which is right for
 * parsing a field a user typed and wrong for deciding what a field means.
 * "Expires 30 days after 6/4/2029" is a sentence about a term, not a date; a
 * "2026-08-20T14:32:11Z" timestamp is a moment, not a day.
 *
 * Both the write path (which would otherwise replace the sentence with the
 * date, irreversibly) and the read path (which would otherwise derive a rule
 * on the wrong day) ask this same question, so they cannot disagree about it.
 */
/** A day that exists: real month, real day-of-month, plausible year. */
function isRealDay(iso: string): boolean {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The spelling every write path produces for a person's own singleton date. */
const CANONICAL_SINGLETON_FIELD = /^(dateofbirth|anniversary)$/;

const DATEISH_TOKEN = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}/g;

export function bareDateOf(value: unknown): string | null {
  const t = String(value ?? "").trim();
  if (!t) return null;
  // ISO-SHAPED is not the same as valid. "2029-13-45" and "0000-00-00" were
  // returned verbatim and became rules that sorted to the top of every
  // expiring list as "Expired 740000 days ago".
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isRealDay(t) ? t : null;
  // A full ISO timestamp IS a day — the day it names. Rejecting it outright
  // meant a date stored as "2027-01-01T00:00:00Z" produced no rule anywhere,
  // where the adapter this replaced read it fine. (The WRITE path still leaves
  // such a value alone: truncating it there would throw away the clock.)
  // Both forms: "2027-01-01T00:00:00Z" and the space-separated
  // "2027-01-01 00:00:00" Postgres hands back. Only the `T` form was accepted,
  // so the other derived no rule where the prefix test it replaced clipped it
  // happily.
  const stamp = t.match(/^(\d{4}-\d{2}-\d{2})[T ][\d:.]+(?:\s*Z|\s*[+-]\d{2}(?::?\d{2})?)?$/);
  if (stamp) return isRealDay(stamp[1]) ? stamp[1] : null;
  if (/\d{1,2}:\d{2}/.test(t)) return null;                    // carries a time
  // A RANGE is not a date. "01/01/2026 - 12/31/2026" is a coverage period, and
  // collapsing it to one end destroyed the other — in every storage write path,
  // irreversibly, which is the exact harm this function exists to prevent.
  // (Un-spaced, `normalizeDateString`'s mid-string search even picked the wrong
  // end.) Two date-looking tokens means this value is not a day.
  const tokens = t.match(DATEISH_TOKEN) || [];
  if (tokens.length > 1) return null;
  // …and a range whose far end has no year is still a range: "1/1/2026 to
  // 12/31" carries one full date, so the count above lets it through, and the
  // value was then rewritten to its first day in every storage write path.
  //
  // The guard must not fire on a date that IS the whole string, though —
  // "07-18-2034" is one date whose separator happens to be a dash, and
  // rejecting it left that date on no surface at all, which is the exact class
  // of bug this module exists to remove.
  const isWholeString = tokens.length === 1 && tokens[0].trim() === t;
  if (!isWholeString && /\d\s*(?:-|–|—|to|through|thru|till|until)\s*\d/i.test(t)) return null;
  // Any word that is not a month name means this is prose.
  const withoutMonths = t.replace(/[A-Za-z]{3,9}\.?(?=\s|,|$)/g, (w) => (MONTH_WORD.test(w) ? "" : w));
  if (/[A-Za-z]{3,}/.test(withoutMonths)) return null;
  if (t.split(/\s+/).filter(Boolean).length > 3) return null;   // a phrase
  // …and a day that does not exist is not a date either. `normalizeDateString`
  // accepts day 1-31 for any month, so "6/31/2026" became "2026-06-31" and the
  // write path stored it — irreversibly.
  const parsed = normalizeDateString(t);
  return parsed && isRealDay(parsed) ? parsed : null;
}


const clip = (v: unknown): string => String(v ?? "").slice(0, 10);

function uniq(ids: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * The key a Date Rule claims on a surface that shows each record ONCE.
 *
 * The same expiration reaches the Executive tab twice — as a calendar item and
 * in the expirations list — and reaches Immediate Attention alongside both.
 * They have to claim the same thing, or one date renders in two sections.
 * Defined here so `shared/attention` and `shared/executive-sections` can share
 * it without importing each other.
 */
export function ruleClaimKey(ruleId: string): string {
  return `rule:${ruleId}`;
}

/** The deterministic rule id. Duplicate prevention lives here and nowhere else. */
export function dateRuleId(
  sourceEntityType: DateRuleSourceType,
  sourceEntityId: string,
  sourceField: string,
  ruleType: DateRuleType,
): string {
  // `sourceField` may be a dotted PATH. Two fields with the same name in
  // different nested groups — `identity.expirationDate` and
  // `insurance.expirationDate` — are two different dates, and keying on the
  // leaf name alone collided them: the second existed on no surface at all.
  // A top-level field's path is its own name, so those ids are unchanged.
  const path = String(sourceField ?? "").split(".").map(normalizeFieldKey).filter(Boolean).join(".");
  return `${sourceEntityType}:${sourceEntityId}:${path}:${ruleType}`;
}

export interface ScanContext {
  entityType: DateRuleSourceType;
  entityId: string;
  /** Human label for the rule ("Jane Doe", "Sample Driver License"). */
  entityLabel: string;
  /** Refines subtypes: the document's `type`, the profile's `type_key`. */
  contextKey?: string;
  profileId?: string;
  ownerIds?: string[];
  /** Prefix for one-line rule labels: `${namePrefix} — Expiration`. */
  namePrefix?: string;
  /** field key (normalized) → documents that wrote it. From `_docFields`. */
  provenance?: Record<string, string[]>;
  href?: string;
}

/**
 * Walk an arbitrary field bag, find every date, classify it, and emit the
 * actionable ones as rules.
 *
 * Normalization happens HERE as well as at the write path, deliberately: it is
 * what makes every historical row — the ones already stored as "07/18/2034" —
 * produce its rule on the very first read, with no migration and no backfill
 * job to run or re-run.
 */
export function scanEntityDates(
  fields: unknown,
  ctx: ScanContext,
  opts: {
    maxDepth?: number;
    skipRuleTypes?: ReadonlySet<DateRuleType>;
    /**
     * Field keys/paths the user explicitly told us NOT to put on the calendar
     * during extraction review. Normalized on both sides, so a leaf name, a
     * dotted path or a different spelling all match. The rule is still derived
     * — it stays an Important Date and keeps its countdown — it is only
     * `calendarVisible: false`. That is the whole point: opting out of the
     * calendar must not delete the date.
     */
    calendarOptOut?: ReadonlySet<string>;
  } = {},
): DateRule[] {
  const out: DateRule[] = [];
  const seen = new Set<string>();
  /** singleton key → the rule id currently holding it, so a later spelling wins. */
  const singletonHolders = new Map<string, string>();
  const maxDepth = opts.maxDepth ?? 2;

  const visit = (obj: any, depth: number, path: string) => {
    if (!obj || typeof obj !== "object" || depth > maxDepth) return;
    for (const [key, value] of Object.entries(obj)) {
      // Reserved metadata (`_docFields`, `_mileageHistory`) is bookkeeping.
      if (key.startsWith("_")) continue;
      const here = path ? `${path}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value, depth + 1, here);
        continue;
      }
      if (typeof value !== "string" && typeof value !== "number") continue;
      const raw = String(value).trim();
      if (!raw) continue;
      // The value must BE a date, not merely mention one — the same question
      // the write path asks, so a field holding "Expires 30 days after
      // 6/4/2029" does not quietly become an important date on 4 June.
      const iso = bareDateOf(raw);
      if (!iso) continue;

      const cls = classifyDateField(key, `${ctx.contextKey ?? ""} ${path}`);
      if (!cls.actionable) continue;
      if (opts.skipRuleTypes?.has(cls.ruleType)) continue;

      const id = dateRuleId(ctx.entityType, ctx.entityId, here, cls.ruleType);
      // Two spellings of ONE fact collapse; two different facts do not.
      //
      // A profile carrying both `dateOfBirth` and `birthday` (extraction writes
      // both) is one birthday — same type, same VALUE. A vehicle carrying
      // `autoInsuranceExpiration` and `registrationExpiration` is two dates,
      // and an earlier version of this key dropped the second because it
      // compared type alone: with the first present, the second produced no
      // rule at all. The qualifier is what the field name says the date is
      // ABOUT once the date-words are stripped, so `expiration_date`,
      // `expirationDate` and `expiry` agree while `autoInsuranceExpiration`
      // and `homeInsuranceExpiration` stay two different policies.
      const valueKey = `${cls.ruleType}:${path}${dateFieldQualifier(key)}:${clip(iso)}`;
      // A person has ONE birthday and ONE anniversary however many spellings
      // carry it, so those two still collapse on type even when the values
      // disagree — otherwise a stale `birthday` beside a corrected
      // `dateOfBirth` would put two birthdays on the calendar.
      const singletonKey = cls.ruleType === "birthday" || cls.ruleType === "anniversary"
        ? `singleton:${cls.ruleType}` : "";
      if (seen.has(id) || seen.has(valueKey)) continue;
      seen.add(id);
      seen.add(valueKey);
      // A singleton keeps the CANONICAL spelling, not whichever came first or
      // last in key order.
      //
      // A profile can hold both `dateOfBirth` and a stale `birthday`, and key
      // order does not say which is current: a spread keeps a pre-existing key
      // in place, so neither "first" nor "last" is the correction. The write
      // paths all produce `dateOfBirth`, so that is the one to believe; when
      // neither is canonical the first still wins.
      if (singletonKey) {
        const prior = singletonHolders.get(singletonKey);
        if (prior !== undefined) {
          const at = out.findIndex((r) => r.id === prior);
          const incomingIsCanonical = CANONICAL_SINGLETON_FIELD.test(normalizeFieldKey(key));
          const heldIsCanonical = at >= 0
            && CANONICAL_SINGLETON_FIELD.test(normalizeFieldKey(out[at].sourceField));
          if (heldIsCanonical || !incomingIsCanonical) continue;
          if (at >= 0) out.splice(at, 1);
        }
      }

      const optedOut = isCalendarOptedOut(opts.calendarOptOut, key, here);
      out.push(buildRule({ ...ctx, cls, id, field: key, path: here, raw, iso, calendarOptOut: optedOut }));
      if (singletonKey) singletonHolders.set(singletonKey, id);
    }
  };

  visit(fields, 0, "");

  // Within ONE record, a GENERIC date field and a qualified one describing the
  // same thing on the same day are one fact: a licence document carrying both
  // `expirationDate` and `licenseExpiration` has one expiration, not two. The
  // qualified name is the more informative of the pair, so it survives.
  //
  // Two qualified names that differ (auto vs home insurance) are two facts and
  // both stay — which is why this cannot be done by type alone.
  const byTypeAndDate = new Map<string, DateRule[]>();
  for (const r of out) {
    // The GROUP is part of the identity. Ignoring it collapsed
    // `registration.expirationDate` into `insurance.policyExpiration` whenever
    // they fell on the same day, and the registration then existed nowhere.
    const group = r.sourcePath.includes(".") ? r.sourcePath.split(".")[0] : "";
    const k = `${r.ruleType}:${group}:${r.date}`;
    const arr = byTypeAndDate.get(k);
    if (arr) arr.push(r); else byTypeAndDate.set(k, [r]);
  }
  const dropped = new Set<string>();
  for (const group of byTypeAndDate.values()) {
    if (group.length < 2) continue;
    const qualified = group.filter((r) => dateFieldQualifier(r.sourceField) !== "");
    if (qualified.length === 0) continue;
    for (const r of group) {
      if (dateFieldQualifier(r.sourceField) === "") dropped.add(r.id);
    }
  }
  return dropped.size > 0 ? out.filter((r) => !dropped.has(r.id)) : out;
}

/**
 * Was this field opted out of the calendar? Matched on the leaf key AND the
 * dotted path, both normalized, so `dueDate`, `due_date` and
 * `payment.dueDate` all answer for the same decision.
 */
export function isCalendarOptedOut(
  optOut: ReadonlySet<string> | undefined,
  key: string,
  path: string,
): boolean {
  if (!optOut || optOut.size === 0) return false;
  const norm = (v: string) => String(v ?? "").split(".").map(normalizeFieldKey).filter(Boolean).join(".");
  return optOut.has(norm(key)) || optOut.has(norm(path));
}

/** The stored opt-out list on a field bag → a set the scanner can test. */
export function calendarOptOutSet(fields: unknown): ReadonlySet<string> {
  const raw = (fields && typeof fields === "object")
    ? (fields as any)[CALENDAR_OPT_OUT_KEY] : undefined;
  if (!Array.isArray(raw)) return new Set<string>();
  const norm = (v: unknown) => String(v ?? "").split(".").map(normalizeFieldKey).filter(Boolean).join(".");
  return new Set(raw.map(norm).filter(Boolean));
}

/**
 * Where an entity records the date fields the user kept OFF the calendar.
 * Underscore-prefixed, so `scanEntityDates` already treats it as bookkeeping
 * and never mistakes the list itself for data.
 */
export const CALENDAR_OPT_OUT_KEY = "_calendarOptOut";

function buildRule(a: ScanContext & {
  cls: FieldClassification; id: string; field: string; path: string; raw: string; iso: string;
  calendarOptOut?: boolean;
}): DateRule {
  const { cls } = a;
  const recurring = cls.occurrenceType === "recurring";
  return {
    id: a.id,
    ruleType: cls.ruleType,
    ruleSubtype: cls.ruleSubtype,
    occurrenceType: cls.occurrenceType,
    sourceEntityType: a.entityType,
    sourceEntityId: a.entityId,
    sourceField: a.field,
    sourcePath: a.path,
    rawValue: a.raw,
    profileId: a.profileId,
    ownerIds: uniq(a.ownerIds || []),
    provenanceDocIds: a.provenance?.[normalizeFieldKey(a.field)],
    label: ruleLabel(a.namePrefix ?? a.entityLabel, cls, a.field,
      a.path.includes(".") ? a.path.split(".")[0] : undefined),
    subtitle: a.entityLabel,
    date: clip(a.iso),
    recurrence: cls.recurrence,
    // The user's explicit "don't put this on my calendar" from extraction
    // review. Everything else about the rule survives.
    calendarVisible: !a.calendarOptOut,
    upcomingVisible: true,
    // The recurring screen shows recurring rules in one half and important
    // future dates in the other; a birthday is the former, an expiration the
    // latter, and neither pretends to be the other.
    importantVisible: recurring || IMPORTANT_TYPES.has(cls.ruleType),
    countdownEnabled: COUNTDOWN_TYPES.has(cls.ruleType),
    active: true,
    href: a.href,
  };
}

const TYPE_LABEL: Record<DateRuleType, string> = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  expiration: "Expiration",
  renewal: "Renewal",
  payment: "Payment",
  income: "Income",
  due: "Due",
  appointment: "Appointment",
  deadline: "Deadline",
  reminder: "Reminder",
  event: "Event",
  start: "Start",
  end: "End",
  cancellation: "Cancellation",
  maintenance: "Service",
  informational: "Date",
};

export function ruleTypeLabel(t: DateRuleType): string {
  return TYPE_LABEL[t] || "Date";
}

const SUBTYPE_LABEL: Record<string, string> = {
  drivers_license: "Driver's License",
  passport: "Passport",
  visa: "Visa",
  vehicle_registration: "Registration",
  insurance: "Insurance",
  warranty: "Warranty",
  lease: "Lease",
  membership: "Membership",
  subscription: "Subscription",
  certification: "Certification",
  loan: "Loan",
  medication: "Prescription",
  contract: "Contract",
  employment: "Employment",
};

/**
 * Does the record's own NAME already say what it is? "Sample Driver License"
 * needs no "Driver's License" qualifier added to its expiration label.
 */
const SUBTYPE_KEYWORD: Record<string, RegExp> = {
  drivers_license: /licen[sc]e|\bdl\b|driving/i,
  passport: /passport/i,
  visa: /visa/i,
  vehicle_registration: /registration|\breg\b/i,
  insurance: /insurance|policy/i,
  warranty: /warrant/i,
  lease: /lease|tenanc/i,
  membership: /member/i,
  subscription: /subscription/i,
  certification: /certific|licen[sc]e|permit/i,
  loan: /loan|mortgage|credit/i,
  medication: /prescription|medication|\brx\b/i,
  contract: /contract|agreement/i,
  employment: /employ|\bjob\b/i,
};

export function ruleSubtypeLabel(sub: string | undefined): string | undefined {
  return sub ? SUBTYPE_LABEL[sub] : undefined;
}

/** "homeInsuranceExpiration" → "Home Insurance"; "expiration_date" → "". */
function fieldPhrase(fieldKey: unknown): string {
  return String(fieldKey ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(date|expiration|expires|expiry|expire|valid|until|thru|through|renewal|renews|renew|due|next|on|of)$/i.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function ruleLabel(name: string, cls: FieldClassification, fieldKey?: unknown, group?: string): string {
  const n = String(name || "").trim() || "Untitled";
  if (cls.ruleType === "birthday") return `${n}'s Birthday`;
  if (cls.ruleType === "anniversary") return `${n} — Anniversary`;
  // A licence expiration typed onto a person reads "Jane — Driver's License
  // Expiration", not the useless "Jane — Expiration". When the source record
  // IS the licence, its own name already says so and the subtype is dropped.
  //
  // The FIELD's own words win over the subtype when they say more. A property
  // carrying `homeInsuranceExpiration` and `floodInsuranceExpiration` infers
  // the same "insurance" subtype for both, and two identical titles collapsed
  // to one series downstream — the flood policy vanished from every surface.
  // The nested group counts as part of the field's own words: `registration.
  // expirationDate` is the registration's, and without the group both it and
  // `insurance.expirationDate` read "Home — Expiration" — two identical titles,
  // which collapse to one series downstream and lose a date.
  const phrase = [fieldPhrase(group), fieldPhrase(fieldKey)].filter(Boolean).join(" ");
  const sub = SUBTYPE_LABEL[cls.ruleSubtype || ""];
  const already = SUBTYPE_KEYWORD[cls.ruleSubtype || ""];
  const type = TYPE_LABEL[cls.ruleType];
  const namer = phrase && phrase.split(/\s+/).length > 1 ? phrase : (sub || phrase);
  // "Honda — Service Service": the field's own words can already END with the
  // type word, and appending it again is just noise on the card.
  const namerSaysIt = !!namer && new RegExp(`(^|\\s)${type}$`, "i").test(namer);
  const qualifier = namer && !(already && already.test(n) && namer === sub)
    ? (namerSaysIt ? namer : `${namer} ${type}`)
    : type;
  return `${n} — ${qualifier}`;
}

// ─── Entity → rules ──────────────────────────────────────────────────────────

/**
 * A profile's own date fields.
 *
 * This is strictly wider than the old `seriesFromProfiles`, which knew only
 * about birthdays and anniversaries: a licence, passport or registration
 * expiration typed onto a person now reaches the calendar too, instead of
 * being visible only in Upcoming.
 */
/**
 * Which documents wrote which of a profile's fields, from the `_docFields`
 * provenance `confirm-extraction` records. Keyed by normalized field name.
 */
function docFieldProvenance(fields: unknown): Record<string, string[]> {
  const src = (fields as any)?._docFields;
  const out: Record<string, string[]> = {};
  if (!src || typeof src !== "object") return out;
  for (const [docId, saved] of Object.entries(src as Record<string, any>)) {
    if (!saved || typeof saved !== "object") continue;
    for (const key of Object.keys(saved)) {
      const k = normalizeFieldKey(key);
      (out[k] ||= []).push(docId);
    }
  }
  return out;
}

export function rulesFromProfiles(profiles: readonly any[]): DateRule[] {
  const out: DateRule[] = [];
  for (const p of profiles || []) {
    if (!p?.id || p.deletedAt) continue;
    const name = p.name || "Unnamed";
    // A liability's PAYMENT schedule keeps its dedicated adapter — that one
    // reads per-occurrence paid/skipped/estimated state this generic scanner
    // cannot see. Everything else a liability carries (an insurance expiry, a
    // lease end) is an ordinary rule, so the profile is still scanned; only
    // the money-schedule types are handed back.
    const isScheduled = p.type === "liability" || p.type === "loan";
    const scanned = scanEntityDates(p.fields && typeof p.fields === "object" ? p.fields : {}, {
      provenance: docFieldProvenance(p.fields),
      entityType: "profile",
      entityId: p.id,
      entityLabel: name,
      namePrefix: name,
      contextKey: `${p.type ?? ""} ${p.type_key ?? p.typeKey ?? ""}`,
      profileId: p.id,
      ownerIds: uniq([p.id, p.parentProfileId, ...(Array.isArray(p.linkedProfiles) ? p.linkedProfiles : [])]),
      href: sourceHref("profile", p.id, p.id),
    }, { calendarOptOut: calendarOptOutSet(p.fields) });
    out.push(...(isScheduled
      ? scanned.filter((r) => r.ruleType !== "payment" && r.ruleType !== "due" && r.ruleType !== "income")
      : scanned));
  }
  return out;
}

/**
 * A document's extracted dates.
 *
 * Both `extractedData` and `fields` are scanned, and the document's `type`
 * ("drivers_license") refines the subtype, so the licence's expiration is
 * tagged `drivers_license` rather than generically.
 */
export function rulesFromDocuments(documents: readonly any[]): DateRule[] {
  const out: DateRule[] = [];
  for (const d of documents || []) {
    if (!d?.id || d.deletedAt) continue;
    const name = d.title || d.name || "Document";
    const profileId = Array.isArray(d.linkedProfiles) ? d.linkedProfiles[0] : undefined;
    const ctx: ScanContext = {
      entityType: "document",
      entityId: d.id,
      entityLabel: name,
      namePrefix: name,
      contextKey: `${d.type ?? ""} ${name}`,
      profileId,
      ownerIds: uniq(Array.isArray(d.linkedProfiles) ? d.linkedProfiles : []),
      href: sourceHref("document", d.id, profileId),
    };
    // `extractedData` is where a document's dates live — the column both
    // storages actually populate. (`fields` is declared on the type and set by
    // nothing, so reading it only created a branch the delete path could not
    // write back to: a "removed" that changed nothing.)
    const bag: Record<string, any> = {
      ...(d.extractedData && typeof d.extractedData === "object" ? d.extractedData : {}),
      ...(d.expirationDate ? { expirationDate: d.expirationDate } : {}),
    };
    // A document's DOB is the PERSON's birthday, and the person's own profile
    // already owns it (extraction routes it there). Emitting it from the
    // document as well would be the second system this whole module exists to
    // remove, so the document contributes only dates the document itself owns.
    //
    // Classified and at EVERY depth, not a list of literal top-level keys: four
    // spellings let `birthDate` through, and stripping only the top level let a
    // nested `personal.dateOfBirth` through — either way a driver's licence
    // grew a yearly rule titled "Sample Driver License's Birthday", whose
    // profileId then shadowed the person's real one.
    out.push(...scanEntityDates(bag, ctx, {
      skipRuleTypes: new Set<DateRuleType>(["birthday", "anniversary"]),
      // Honour what the user decided in extraction review.
      calendarOptOut: calendarOptOutSet(d.extractedData),
    }));
  }
  return out;
}

export interface DateRuleInputs {
  profiles?: readonly any[];
  documents?: readonly any[];
}

/**
 * Every derived Date Rule, deduplicated.
 *
 * Events, obligations, liabilities and tasks are NOT scanned here: those rows
 * carry their date in a dedicated column with its own schedule semantics
 * (per-occurrence paid/skipped state, materialized task series), and
 * `shared/calendar-adapters` already models them exactly. Their rules are
 * produced by `rulesFromSeries` instead, so the two halves meet in one list
 * without either re-implementing the other.
 */
export function rulesFromAll(input: DateRuleInputs): DateRule[] {
  const documents = input.documents || [];
  const documentRules = rulesFromDocuments(documents);
  const profileRules = rulesFromProfiles(input.profiles || []);
  return dedupeRules([
    ...suppressDocumentCopies(profileRules, documents, documentRules),
    ...documentRules,
  ]);
}

/**
 * Drop a profile field that a document PUT there and still holds.
 *
 * Extraction copies a licence's expiration onto the person as well as leaving
 * it on the licence, and records that it did so in `fields._docFields[docId]`.
 * Both then produce a rule for one real date, and dedup could not always tell:
 * the document knows it is a driver's licence and the copied field
 * (`expirationDate`) does not, and merging on a mismatched subtype is how an
 * unrelated passport got swallowed.
 *
 * Provenance answers it exactly. The copy is suppressed only while the document
 * that wrote it still exists and still carries that date — delete the document
 * and the profile's copy becomes the record again, which is the same rule the
 * delete cascade follows.
 */
function suppressDocumentCopies(
  profileRules: readonly DateRule[],
  documents: readonly any[],
  documentRules: readonly DateRule[],
): DateRule[] {
  const liveDocIds = new Set((documents || []).map((d) => d?.id).filter(Boolean));
  if (liveDocIds.size === 0) return [...profileRules];
  // Keyed on the DOCUMENT as well as the date. Globally, any document expiring
  // on the same day suppressed the copy — even one that had nothing to do with
  // it, and even after the provenance document had stopped holding that date.
  const heldByDoc = new Set(documentRules.map((r) => `${r.sourceEntityId}:${r.ruleType}:${r.date}`));
  return (profileRules || []).filter((r) =>
    !(r.provenanceDocIds || []).some((id) =>
      liveDocIds.has(id) && heldByDoc.has(`${id}:${r.ruleType}:${r.date}`)));
}

/**
 * Collapse rules that describe the same real-world date reaching the app twice.
 *
 * The identity is (owner, type, subtype, date) — so a licence expiration held
 * BOTH on the person's profile and on the uploaded licence document is one
 * important date, not two. The document wins when there is one: it is the
 * record that actually carries the licence.
 */
export function dedupeRules(rules: readonly DateRule[]): DateRule[] {
  const groups = new Map<string, DateRule[]>();
  for (const r of rules || []) {
    if (!r) continue;
    // An UNOWNED rule groups under its own record, not under a shared empty
    // key. Grouping every ownerless rule together made an unlinked "Gym Card"
    // and an unlinked "Passport" expiring on the same day collide — and since
    // an absent subtype is treated as compatible with any subtype below, one
    // of them vanished entirely.
    const owner = r.profileId || (r.ownerIds || [])[0] || `@${r.sourceEntityType}:${r.sourceEntityId}`;
    const key = `${owner}:${r.ruleType}:${r.date}`;
    const arr = groups.get(key);
    if (arr) arr.push(r); else groups.set(key, [r]);
  }
  const out: DateRule[] = [];
  for (const group of groups.values()) {
    const kept: DateRule[] = [];
    for (const r of group) {
      // Two conditions, and both are about not losing a date.
      //
      // ACROSS SYSTEMS only. Two rules from the same kind of record are two
      // records: "Rent" and "Car Payment" are both payments owned by the same
      // person, and merging them on a shared due date made one disappear. What
      // this pass exists for is one real-world date described by two DIFFERENT
      // systems — a licence expiration held on the person and on the uploaded
      // licence.
      //
      // SUBTYPES MUST AGREE, both naming the same thing or both silent.
      // Treating an absent subtype as compatible with any subtype was too
      // eager: a person carrying a bare `expirationDate` and a passport
      // document expiring the same day collapsed to one and the other was gone.
      // Showing two dates the user can reconcile is recoverable; silently
      // dropping one is not. The motivating case still merges, because a
      // licence expiration on a person is named for the licence
      // (`driversLicenseExpiration`) and carries the subtype the document does.
      const i = kept.findIndex((k) =>
        k.sourceEntityType !== r.sourceEntityType &&
        (k.ruleSubtype ?? "") === (r.ruleSubtype ?? ""));
      if (i < 0) { kept.push(r); continue; }
      if (rulePriority(r) > rulePriority(kept[i])) {
        // The survivor keeps whichever side actually knew what the thing was.
        kept[i] = { ...r, ruleSubtype: r.ruleSubtype || kept[i].ruleSubtype };
      } else if (!kept[i].ruleSubtype && r.ruleSubtype) {
        kept[i] = { ...kept[i], ruleSubtype: r.ruleSubtype };
      }
    }
    out.push(...kept);
  }
  return out;
}

function rulePriority(r: DateRule): number {
  let s = 0;
  // A birthday belongs to the person; an expiration belongs to the document
  // that expires. Editing happens on the winner, so the winner must be the
  // record the user would actually open.
  if (r.ruleType === "birthday" || r.ruleType === "anniversary") {
    s += r.sourceEntityType === "profile" ? 10 : 0;
  } else {
    s += r.sourceEntityType === "document" ? 10 : 0;
  }
  if (r.profileId) s += 2;
  if (r.ruleSubtype) s += 1;
  return s;
}

// ─── Rules → calendar ────────────────────────────────────────────────────────

const KIND_FOR_RULE: Record<DateRuleType, OccurrenceKind> = {
  birthday: "birthday",
  anniversary: "anniversary",
  expiration: "expiration",
  renewal: "renewal",
  payment: "bill",
  income: "income",
  due: "expiration",
  appointment: "appointment",
  deadline: "task",
  reminder: "task",
  event: "event",
  start: "custom",
  end: "expiration",
  cancellation: "expiration",
  maintenance: "maintenance",
  informational: "custom",
};

/**
 * The bridge: a Date Rule becomes a `CalendarSeries`, so the EXISTING
 * occurrence engine (shared/calendar-occurrences) generates its dates. The
 * calendar never learns rule semantics — it consumes rules and expands them.
 */
export function seriesFromDateRules(rules: readonly DateRule[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const r of rules || []) {
    if (!r?.active || !r.calendarVisible) continue;
    // A one-time renewal (a registration that renews once, on a date) is an
    // important one-off, so it takes the `expiration` kind and with it the long
    // horizon a 2034 date needs. A RECURRING renewal keeps the `renewal` kind
    // on the ordinary one-year horizon — widening that kind wholesale expanded
    // a yearly "Car Registration Renewal" into twelve occurrences.
    const kind = r.ruleType === "renewal" && r.occurrenceType === "one_time"
      ? "expiration"
      : (KIND_FOR_RULE[r.ruleType] ?? "custom");
    out.push({
      // The rule id IS the series id, so a calendar occurrence can always be
      // traced back: occurrence → series → rule → source entity + field.
      id: `rule:${r.id}`,
      kind,
      title: r.label,
      subtitle: r.subtitle,
      amount: r.amount,
      source: {
        system: r.sourceEntityType === "income" ? "event" : r.sourceEntityType,
        id: r.sourceEntityId,
        field: r.sourcePath,
        profileId: r.profileId,
        ownerIds: r.ownerIds,
        label: r.subtitle,
        href: r.href,
      } as CalendarSeries["source"],
      baseDate: r.date,
      recurrence: r.recurrence || "none",
      recurrenceEnd: r.recurrenceEnd,
      // The rule already decided these; the calendar kind cannot express them —
      // a court date and an ordinary to-do are both `task`.
      important: r.importantVisible,
      ruleType: r.ruleType,
    });
  }
  return out;
}

/**
 * The reverse bridge: the schedule-bearing systems (events, obligations,
 * liabilities, tasks) are already normalized as `CalendarSeries`, so they are
 * presented as rules from that shape rather than re-derived.
 *
 * This is what lets `GET /api/date-rules` answer for the WHOLE app — a
 * subscription's monthly payment rule and a licence's expiration rule sit in
 * one list, in one shape, however differently they are stored.
 */
export function rulesFromSeries(series: readonly CalendarSeries[]): DateRule[] {
  const out: DateRule[] = [];
  for (const s of series || []) {
    if (!s?.id || s.shadow) continue;
    if (s.id.startsWith("rule:")) continue; // already a rule
    const recurring = !!s.recurrence && s.recurrence !== "none";
    const ruleType = RULE_TYPE_FOR_KIND[s.kind] ?? (recurring ? "payment" : "event");
    const sourceType = (s.source.system === "profile" ? "profile"
      : s.source.system === "document" ? "document"
        : s.source.system === "obligation" ? "obligation"
          : s.source.system === "liability" ? "liability"
            : s.source.system === "task" ? "task"
              : "event") as DateRuleSourceType;
    out.push({
      id: dateRuleId(sourceType, s.source.id, "date", ruleType),
      ruleType,
      ruleSubtype: undefined,
      occurrenceType: recurring ? "recurring" : "one_time",
      sourceEntityType: sourceType,
      sourceEntityId: s.source.id,
      sourceField: "date",
      sourcePath: "date",
      rawValue: s.baseDate,
      profileId: s.source.profileId,
      ownerIds: s.source.ownerIds || [],
      label: s.title,
      subtitle: s.subtitle,
      date: s.baseDate,
      recurrence: s.recurrence || "none",
      recurrenceEnd: s.recurrenceEnd,
      amount: s.amount,
      calendarVisible: true,
      upcomingVisible: true,
      importantVisible: recurring || IMPORTANT_TYPES.has(ruleType),
      countdownEnabled: COUNTDOWN_TYPES.has(ruleType),
      active: !s.archived,
      href: s.source.href,
    });
  }
  return out;
}

export const RULE_TYPE_FOR_KIND: Partial<Record<OccurrenceKind, DateRuleType>> = {
  birthday: "birthday",
  anniversary: "anniversary",
  expiration: "expiration",
  renewal: "renewal",
  document: "expiration",
  subscription: "payment",
  bill: "payment",
  liability: "payment",
  income: "income",
  task: "deadline",
  appointment: "appointment",
  maintenance: "maintenance",
  event: "event",
  custom: "event",
};

// ─── Does this "event" actually belong to a record? ──────────────────────────

/**
 * True when an event title is a bare STATEMENT that something expires, rather
 * than a thing the user intends to do.
 *
 * The chat can be told "my driver's licence expires July 18 2034". The licence
 * is what expires, so the date belongs on the licence and the important date is
 * derived from it — writing an event instead creates the second, disconnected
 * record this whole module exists to remove.
 *
 * But the same words appear in events that are genuinely events: "Renew
 * passport at the embassy" is an errand with a place and a time, and silently
 * turning it into a profile field would lose what the user asked for. So the
 * test is deliberately narrow:
 *
 *   • the title must say something EXPIRES (a renewal is usually an errand);
 *   • it must contain no action the user means to perform;
 *   • it must be short — a statement, not a description.
 *
 *   "Driver's License Expiration"      → true
 *   "Passport expires"                 → true
 *   "Renew passport at the embassy"    → false
 *   "Call the DMV about the expiring licence" → false
 */
const EXPIRY_STATEMENT = /\bexpir\w*\b|\bvalid (?:un)?til\b|\bgood thru\b/i;
const AN_ACTION = /\b(renew|call|email|visit|go|going|book|schedule|apply|submit|file|pick ?up|drop ?off|bring|take|mail|send|meet|appointment|appt|reminder|remind|order|replace|update|check|review|pay)\b/i;

/**
 * True when an event title is nothing but a LABEL for someone's birthday or
 * anniversary — the shape an auto-generated row has, not the shape a party has.
 *
 *   "Joe's Birthday"        → { name: "Joe",  kind: "birthday" }
 *   "Anniversary"           → { name: "",     kind: "anniversary" }
 *   "Birthday party at Chuck E Cheese" → null
 *   "Joe's 40th Birthday Bash"         → null
 *
 * The strictness is the point. Redirecting one of these onto a profile
 * OVERWRITES that person's date of birth, so a false positive is not a
 * cosmetic miss — it destroys data and swallows the event the user asked for.
 */
export function parseBirthdayLabel(
  title: unknown,
): { name: string; kind: "birthday" | "anniversary" } | null {
  const t = String(title ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  const m = t.match(/^(?:(.+?)(?:['\u2019]s)?\s+)?(birthday|b-?day|anniversary)$/i);
  if (!m) return null;
  const kind = /anniversar/i.test(m[2]) ? "anniversary" : "birthday";
  const name = (m[1] || "").trim();
  // "40th Birthday", "Happy Birthday", "My Birthday" are not a person's name.
  if (name && /^(happy|my|the|a|an|his|her|their|our|your|\d+(st|nd|rd|th)?)$/i.test(name)) {
    return { name: "", kind };
  }
  return { name, kind };
}

export function isBareExpiryStatement(title: unknown): boolean {
  const t = String(title ?? "").trim();
  if (!t || !EXPIRY_STATEMENT.test(t)) return false;
  if (AN_ACTION.test(t)) return false;
  // A statement of fact is short. Anything longer is describing something.
  return t.split(/\s+/).filter(Boolean).length <= 6;
}

// ─── Write-path normalization ────────────────────────────────────────────────

/**
 * THE write-side fix.
 *
 * Every path that saves a field bag — document extraction, the chat tools, the
 * manual PATCH — runs its values through here, so a date is stored in the ONE
 * canonical form the whole app can read. Before this, extraction wrote
 * "07/10/1994" verbatim and the date existed for the profile page and for
 * nothing else.
 *
 * Only values on fields that CLASSIFY as dates are touched, and only when the
 * value parses as a date, so a licence number or an address is never rewritten.
 * Returns the same object shape plus the list of keys that changed.
 */
/** True for a YYYY-MM-DD string that names a real calendar day (no Feb 30). */
export function isRealCalendarDay(s: unknown): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * The dated fields (by name — the same classification the normalizer uses)
 * whose value is shaped like a day but is not one: "2026-02-30". The
 * normalizer leaves a day-shaped value alone, so an impossible day written by
 * hand used to be stored as given and the JavaScript Date the rule engine
 * built from it rolled over to the next month (Feb 30 → Mar 2). Returns the
 * offending paths so a write path can refuse them.
 */
export function impossibleCalendarDays(fields: Record<string, any> | null | undefined, ctx: { contextKey?: string; maxDepth?: number } = {}): string[] {
  const out: string[] = [];
  const maxDepth = ctx.maxDepth ?? 2;
  const walk = (obj: any, depth: number, path: string) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > maxDepth) return;
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("_")) continue;
      const here = path ? `${path}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) { walk(value, depth + 1, here); continue; }
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) continue;
      const cls = classifyDateField(key, ctx.contextKey);
      const words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
      const looksDated = cls.ruleType !== "informational"
        || words.some((w) => /^(date|dates|dob|birth|birthday|birthdate|due|valid|start|starts|end|ends|until|thru|through)$/i.test(w) || /^(expir|renew)/i.test(w));
      if (looksDated && !isRealCalendarDay(value)) out.push(here);
    }
  };
  walk(fields, 0, "");
  return out;
}

export function normalizeEntityDateFields<T extends Record<string, any>>(
  fields: T,
  ctx: { contextKey?: string; maxDepth?: number } = {},
): { fields: T; changed: string[] } {
  const changed: string[] = [];
  const maxDepth = ctx.maxDepth ?? 2;

  const walk = (obj: any, depth: number, path: string): any => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > maxDepth) return obj;
    let copy: any = null;
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("_")) continue;
      const here = path ? `${path}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = walk(value, depth + 1, here);
        if (nested !== value) { copy = copy || { ...obj }; copy[key] = nested; }
        continue;
      }
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue;
      // The value must BE a date, not merely contain one.
      //
      // `normalizeDateString` searches anywhere in the string, and this used to
      // overwrite the whole value with what it found — so
      // "Expires 30 days after 6/4/2029" became "2029-06-04" and a
      // "2026-08-20T14:32:11Z" timestamp lost its time. This runs in every
      // storage write path, so that was irreversible: the sentence the user
      // typed would be gone from the database with no way back.
      //
      // A bare date is a short token with no prose around it. Anything else —
      // a sentence, a range, a timestamp with a clock — is left exactly as the
      // user wrote it, and the rule engine reads it as-is.
      // A value carrying a clock keeps it: `bareDateOf` will happily name the
      // DAY an ISO timestamp falls on, which is what the read path wants and
      // the opposite of what the write path may do to the stored value.
      if (/\d{1,2}:\d{2}/.test(trimmed)) continue;
      const bare = bareDateOf(trimmed);
      if (!bare) continue;
      // Only rewrite fields whose NAME says they hold a date. A free-text note
      // that happens to contain "6/4/2029" keeps its wording.
      const cls = classifyDateField(key, ctx.contextKey);
      // WORDS, not substrings. `/end/` matched `endorsements`, so a licence's
      // endorsement code that happened to parse as a date was rewritten — in
      // every storage write path, irreversibly.
      const words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
      const looksDated = cls.ruleType !== "informational"
        || words.some((w) =>
          /^(date|dates|dob|birth|birthday|birthdate|due|valid|start|starts|end|ends|until|thru|through)$/i.test(w)
          || /^(expir|renew)/i.test(w));
      if (!looksDated) continue;
      if (bare === trimmed) continue;
      const iso = bare;
      copy = copy || { ...obj };
      copy[key] = iso;
      changed.push(here);
    }
    return copy || obj;
  };

  return { fields: walk(fields, 0, "") as T, changed };
}
