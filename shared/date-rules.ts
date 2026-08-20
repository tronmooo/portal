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
    match: /(expir|expiry|expires|validuntil|validthru|validthrough|validto|goodthru|goodthrough|useby|bestbefore)/,
  },

  // ── Renewals: one-time until the thing is renewed, same as expirations ──
  { ruleType: "renewal", match: /(renew|reregistration|nextregistration|registrationdue)/ },

  // ── Money ──
  {
    ruleType: "payment",
    match: /(nextpayment|nextbilling|nextcharge|billingdate|paymentdate|chargedate|nextduedate|paymentdue|billdue|autopay)/,
    recurrence: "monthly",
  },
  { ruleType: "income", match: /(payday|paydate|paycheck|payschedule|nextpaycheck|depositdate)/, recurrence: "biweekly" },
  { ruleType: "due", match: /(duedate|due$|maturity|payoff|balancedue)/ },

  // ── Calendar-shaped ──
  { ruleType: "appointment", match: /(appointment|visitdate|followup|nextvisit|checkup|consultation|surgery|procedure)/ },
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
const IMPORTANT_TYPES = new Set<DateRuleType>([
  "expiration", "renewal", "due", "deadline", "cancellation", "end", "start", "maintenance",
]);

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
      ruleSubtype: m.subtype || inferSubtype(key, ctx),
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
  const both = `${key} ${ctx}`;
  if (/driver|dl\b|driving/.test(both)) return "drivers_license";
  if (/passport/.test(both)) return "passport";
  if (/visa/.test(both)) return "visa";
  if (/registration|regist/.test(both)) return "vehicle_registration";
  if (/insurance|policy|coverage/.test(both)) return "insurance";
  if (/warrant/.test(both)) return "warranty";
  if (/lease|tenanc/.test(both)) return "lease";
  if (/member/.test(both)) return "membership";
  if (/subscription/.test(both)) return "subscription";
  if (/certification|certificate|license|licence|permit/.test(both)) return "certification";
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
  let years = +b.slice(0, 4) - +a.slice(0, 4);
  let months = +b.slice(5, 7) - +a.slice(5, 7);
  let days = +b.slice(8, 10) - +a.slice(8, 10);
  if (days < 0) {
    months -= 1;
    // Days in the month preceding `b`.
    const pm = +b.slice(5, 7) - 1;
    const py = pm === 0 ? +b.slice(0, 4) - 1 : +b.slice(0, 4);
    const pmm = pm === 0 ? 12 : pm;
    days += new Date(Date.UTC(py, pmm, 0)).getUTCDate();
  }
  if (months < 0) { years -= 1; months += 12; }
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

const clip = (v: unknown): string => String(v ?? "").slice(0, 10);

function uniq(ids: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out;
}

/** The deterministic rule id. Duplicate prevention lives here and nowhere else. */
export function dateRuleId(
  sourceEntityType: DateRuleSourceType,
  sourceEntityId: string,
  sourceField: string,
  ruleType: DateRuleType,
): string {
  return `${sourceEntityType}:${sourceEntityId}:${normalizeFieldKey(sourceField)}:${ruleType}`;
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
  opts: { maxDepth?: number } = {},
): DateRule[] {
  const out: DateRule[] = [];
  const seen = new Set<string>();
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
      const iso = normalizeDateString(raw);
      if (!iso) continue;

      const cls = classifyDateField(key, `${ctx.contextKey ?? ""} ${path}`);
      if (!cls.actionable) continue;

      const id = dateRuleId(ctx.entityType, ctx.entityId, key, cls.ruleType);
      // One rule per (entity, field, type). A profile carrying both
      // `dateOfBirth` and `birthday` (extraction writes both) yields ONE
      // birthday rule, because the first spelling claims the type.
      const typeKey = `${cls.ruleType}:${cls.ruleSubtype ?? ""}`;
      if (seen.has(id) || seen.has(typeKey)) continue;
      seen.add(id);
      seen.add(typeKey);

      out.push(buildRule({ ...ctx, cls, id, field: key, path: here, raw, iso }));
    }
  };

  visit(fields, 0, "");
  return out;
}

function buildRule(a: ScanContext & {
  cls: FieldClassification; id: string; field: string; path: string; raw: string; iso: string;
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
    label: ruleLabel(a.namePrefix ?? a.entityLabel, cls),
    subtitle: a.entityLabel,
    date: clip(a.iso),
    recurrence: cls.recurrence,
    calendarVisible: true,
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

function ruleLabel(name: string, cls: FieldClassification): string {
  const n = String(name || "").trim() || "Untitled";
  if (cls.ruleType === "birthday") return `${n}'s Birthday`;
  if (cls.ruleType === "anniversary") return `${n} — Anniversary`;
  // A licence expiration typed onto a person reads "Jane — Driver's License
  // Expiration", not the useless "Jane — Expiration". When the source record
  // IS the licence, its own name already says so and the subtype is dropped.
  const sub = SUBTYPE_LABEL[cls.ruleSubtype || ""];
  const already = SUBTYPE_KEYWORD[cls.ruleSubtype || ""];
  const qualifier = sub && !(already && already.test(n))
    ? `${sub} ${TYPE_LABEL[cls.ruleType]}`
    : TYPE_LABEL[cls.ruleType];
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
export function rulesFromProfiles(profiles: readonly any[]): DateRule[] {
  const out: DateRule[] = [];
  for (const p of profiles || []) {
    if (!p?.id || p.deletedAt) continue;
    // Liability/loan payment schedules keep their dedicated adapter — it reads
    // per-occurrence paid/skipped state this generic scanner cannot see.
    if (p.type === "liability" || p.type === "loan") continue;
    const name = p.name || "Unnamed";
    out.push(...scanEntityDates(p.fields && typeof p.fields === "object" ? p.fields : {}, {
      entityType: "profile",
      entityId: p.id,
      entityLabel: name,
      namePrefix: name,
      contextKey: `${p.type ?? ""} ${p.type_key ?? p.typeKey ?? ""}`,
      profileId: p.id,
      ownerIds: uniq([p.id, p.parentProfileId, ...(Array.isArray(p.linkedProfiles) ? p.linkedProfiles : [])]),
      href: sourceHref("profile", p.id, p.id),
    }));
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
    const bag: Record<string, any> = {
      ...(d.extractedData && typeof d.extractedData === "object" ? d.extractedData : {}),
      ...(d.fields && typeof d.fields === "object" ? d.fields : {}),
      ...(d.expirationDate ? { expirationDate: d.expirationDate } : {}),
    };
    // A document's DOB is the PERSON's birthday, and the person's own profile
    // already owns it (extraction routes it there). Emitting it from the
    // document as well would be the second system this whole module exists to
    // remove, so the document contributes only dates the document itself owns.
    delete (bag as any).dateOfBirth;
    delete (bag as any).dob;
    delete (bag as any).birthday;
    delete (bag as any).date_of_birth;
    out.push(...scanEntityDates(bag, ctx));
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
  const out = [...rulesFromProfiles(input.profiles || []), ...rulesFromDocuments(input.documents || [])];
  return dedupeRules(out);
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
    const owner = r.profileId || (r.ownerIds || [])[0] || "";
    const key = `${owner}:${r.ruleType}:${r.date}`;
    const arr = groups.get(key);
    if (arr) arr.push(r); else groups.set(key, [r]);
  }
  const out: DateRule[] = [];
  for (const group of groups.values()) {
    const kept: DateRule[] = [];
    for (const r of group) {
      // Subtypes must be COMPATIBLE, not identical: the person's profile says
      // "expiration" with no subtype while the uploaded licence says
      // "drivers_license", and those are one date. A passport and a licence
      // expiring on the same day carry different subtypes and stay two.
      const i = kept.findIndex((k) =>
        !k.ruleSubtype || !r.ruleSubtype || k.ruleSubtype === r.ruleSubtype);
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
    out.push({
      // The rule id IS the series id, so a calendar occurrence can always be
      // traced back: occurrence → series → rule → source entity + field.
      id: `rule:${r.id}`,
      kind: KIND_FOR_RULE[r.ruleType] ?? "custom",
      title: r.label,
      subtitle: r.subtitle,
      amount: r.amount,
      source: {
        system: r.sourceEntityType === "income" ? "event" : r.sourceEntityType,
        id: r.sourceEntityId,
        profileId: r.profileId,
        ownerIds: r.ownerIds,
        label: r.subtitle,
        href: r.href,
      } as CalendarSeries["source"],
      baseDate: r.date,
      recurrence: r.recurrence || "none",
      recurrenceEnd: r.recurrenceEnd,
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

const RULE_TYPE_FOR_KIND: Partial<Record<OccurrenceKind, DateRuleType>> = {
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
      // Only rewrite fields whose NAME says they hold a date. A free-text note
      // that happens to contain "6/4/2029" keeps its wording.
      const cls = classifyDateField(key, ctx.contextKey);
      const looksDated = cls.ruleType !== "informational" || /date|dob|birth|expir|due|renew|valid|start|end/i.test(key);
      if (!looksDated) continue;
      const iso = normalizeDateString(trimmed);
      if (!iso || iso === trimmed) continue;
      copy = copy || { ...obj };
      copy[key] = iso;
      changed.push(here);
    }
    return copy || obj;
  };

  return { fields: walk(fields, 0, "") as T, changed };
}
