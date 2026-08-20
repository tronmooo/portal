// shared/calendar-occurrences.ts — THE calendar occurrence engine.
//
// One engine generates every date the app shows: birthdays, anniversaries,
// subscriptions, liabilities/bills, habits, recurring tasks and
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
import { addYearsISO, weekdaySetFor } from "./date-math";

// ─── Kinds ───────────────────────────────────────────────────────────────────

/** What KIND of date this is. Drives the horizon, the icon, and the label. */
export type OccurrenceKind =
  | "birthday"
  | "anniversary"
  | "subscription"
  | "liability"
  | "bill"
  | "renewal"
  // An expiration is a ONE-TIME important future date, not a yearly repeat. It
  // is its own kind so the recurring screen can show it under Important Dates
  // and the countdown machinery can find it, without any code ever having to
  // pretend a driver's licence repeats every year.
  | "expiration"
  // Recurring income (a paycheck) is money IN, so it must never be folded into
  // the payment kinds — the cash-flow and dedup rules there are about bills.
  | "income"
  | "maintenance"
  | "appointment"
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
  expiration: "Expiration",
  income: "Income",
  maintenance: "Maintenance",
  appointment: "Appointment",
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
  // `renewal` covers RECURRING renewals (inferKindFromText maps /renew|
  // registration/), so widening it expanded a yearly registration renewal into
  // twelve rows. A one-off renewal is emitted as `expiration` instead — see
  // seriesFromDateRules — which is where the long horizon belongs: a 2034
  // licence must still be generated when the user is looking at 2026.
  renewal: 366,
  income: 366,
  expiration: 366 * 12,
  maintenance: 366,
  appointment: 366,
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
  /**
   * Where tapping this date NAVIGATES — the record the user edits. For a bill
   * backed by a liability that is the liability profile, not the person.
   */
  profileId?: string;
  /**
   * EVERY profile this date belongs to, for profile-scope matching.
   *
   * Deliberately separate from `profileId`. Collapsing the two is what made
   * "Bills 0 · Subscriptions 0 · Liabilities 0" appear while those records
   * plainly existed: a ChatGPT Pro obligation owned by Robert but attached to
   * the ChatGPT Pro liability profile had `profileId` set to the LIABILITY, so
   * filtering to Robert matched nothing and every payment vanished.
   *
   * Navigation wants one target; scope wants the whole ownership chain.
   */
  ownerIds?: string[];
  /** Display name of the source ("Joe", "Netflix", "Honda CR-V"). */
  label?: string;
  /** Route to the source record. Always set — see `sourceHref`. */
  href: string;
  /**
   * The financial record this payment is attached to, when one exists — an
   * obligation's `linkedLiabilityId`, or a liability profile's own id.
   *
   * This is the STRONGEST duplicate signal we have: an obligation that
   * declares itself backed by liability X is, by definition, the same payment
   * as liability X's own schedule. It is metadata on ONE occurrence, never a
   * reason to generate a second one.
   */
  linkedRecordId?: string;
  /** Human label for that link, e.g. "Liability". */
  linkedLabel?: string;
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
   * Per-occurrence amounts, keyed by canonical date, for a series whose amount
   * genuinely differs per period (a variable or usage-based liability).
   *
   * This is the calendar half of the variable-billing model: a bill whose
   * August total is $62 and whose September total is $20 is ONE series with two
   * different occurrence amounts, NOT two series and NOT a series whose amount
   * was rewritten. Overriding one month here cannot touch any other month.
   */
  amountByDate?: Record<string, number>;
  /** Canonical dates whose amount is still a forecast rather than a posted charge. */
  estimatedDates?: string[];
  /**
   * How this series is billed — "fixed" | "variable" | "usage_based" |
   * "one_time" | "installment" (see shared/liability-billing). Drives whether
   * the detail panel offers per-occurrence money edits at all. Typed loosely
   * here so this module stays dependency-free.
   */
  billingModel?: string;
  /**
   * Set when this series is a SHADOW of a record that another system owns —
   * e.g. a manually-created "Joe's Birthday" event when Joe's profile already
   * carries his date of birth. Shadows lose deduplication to the canonical
   * source. Adapters set this; `dedupeSeries` enforces it.
   */
  shadow?: boolean;
  /**
   * Set when the series was INFERRED from several materialized rows rather than
   * read off a recurrence rule (shared/series-detect) — e.g. six monthly
   * "Refill … - August/September/…" tasks that carry no `recur:` tag. Carries
   * the member row ids so a later pass can edit or cancel the whole series;
   * absent for rules that genuinely store their own recurrence.
   */
  materializedFrom?: { seriesKey: string; rowIds: string[] };
}


/** Recurrence tokens that mean "this genuinely repeats". */
const REPEATING = new Set([
  "daily", "weekdays", "weekends", "weekly", "biweekly",
  "monthly", "bimonthly", "quarterly",
  "semiannual", "semiannually", "biannual", "yearly",
]);

/**
 * Is this a RECURRING RULE, i.e. does it belong on a recurrence manager?
 *
 * User report 2026-07-25: the Recurring Dates page was listing driver-licence
 * expirations, a raw `dateOfBirth` field, a House Viewing and a Soccer Game —
 * every one of them captioned "Does not repeat". A screen that calls its
 * contents recurring dates while telling you they do not recur is not a small
 * cosmetic bug; those records simply do not belong there.
 *
 * One-off dates still exist and still show on the calendar grid. They are just
 * not RULES, so they are not managed here.
 */
export function isRecurringRule(series: CalendarSeries): boolean {
  if (!series) return false;
  const token = String(series.recurrence || "").toLowerCase();
  // A weekday set ("weekly:1,3,5") is a rule like any other named cadence.
  return REPEATING.has(token) || weekdaySetFor(token) !== null;
}

/** Just the genuinely repeating series. */
export function onlyRecurringRules(list: readonly CalendarSeries[]): CalendarSeries[] {
  return (list || []).filter(isRecurringRule);
}

/**
 * Is this an IMPORTANT FUTURE DATE — a one-off the user needs to see coming?
 *
 * The counterpart to `isRecurringRule`, and the reason the recurring screen can
 * finally show a driver's licence without lying about it. A licence expiring on
 * 18 July 2034 is not a yearly event and must never be modelled as one; it is a
 * single date with a countdown attached. Both belong on the same screen —
 * "Recurring & Important Dates" — and neither is allowed to corrupt the other's
 * semantics to get there.
 *
 * A plain one-off ("House Viewing", "Soccer Game") is NOT important: it is an
 * appointment on the grid, not something to track the distance to.
 */
const IMPORTANT_ONE_TIME_KINDS = new Set<OccurrenceKind>([
  "expiration", "renewal", "document",
]);

export function isImportantDate(series: CalendarSeries): boolean {
  if (!series) return false;
  if (isRecurringRule(series)) return false;
  return IMPORTANT_ONE_TIME_KINDS.has(series.kind);
}

/** Recurring rules plus important one-off dates — what the screen manages. */
export function onlyRulesAndImportantDates(list: readonly CalendarSeries[]): CalendarSeries[] {
  return (list || []).filter((s) => isRecurringRule(s) || isImportantDate(s));
}

// ─── Rule validity ───────────────────────────────────────────────────────────

export type RuleValidity =
  | { state: "ok" }
  | { state: "paused" }
  | { state: "ended"; message: string }
  | { state: "invalid"; message: string };

/**
 * Why a recurring rule has no upcoming date.
 *
 * "Never show 'No upcoming date' for an active recurring rule unless the rule
 * is invalid, in which case show a clear validation error." A rule with no
 * future occurrence is always one of: paused, genuinely finished, or broken —
 * and the user is entitled to know which.
 */
export function ruleValidity(
  series: CalendarSeries,
  hasUpcoming: boolean,
  todayISO: string,
): RuleValidity {
  if (series.archived) return { state: "invalid", message: "Archived — hidden from the calendar." };
  if (series.paused) return { state: "paused" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(series.baseDate || "").slice(0, 10))) {
    return { state: "invalid", message: "This rule has no valid start date — edit it to set one." };
  }
  if (!isRecurringRule(series)) {
    return { state: "invalid", message: "This rule has no repeat pattern — edit it to set one." };
  }
  if (hasUpcoming) return { state: "ok" };
  if (series.recurrenceEnd && series.recurrenceEnd < todayISO) {
    return { state: "ended", message: `Ended ${series.recurrenceEnd}` };
  }
  return {
    state: "invalid",
    message: "No future dates could be generated — check the start date and repeat pattern.",
  };
}

// ─── Identity ────────────────────────────────────────────────────────────────
//
// The dedup key. It deliberately does NOT include any computed date: the whole
// point is to collapse two sources that disagree about the date.

/** Kinds whose identity is "this person/thing has ONE of these, ever". */
const SINGLETON_KINDS = new Set<OccurrenceKind>(["birthday", "anniversary"]);

/**
 * Kinds that are all the same underlying thing: A RECURRING PAYMENT.
 *
 * "Subscription", "Liability" and "Bill" are DESCRIPTIVE LABELS for one money
 * event, not three different dates. ChatGPT Pro modelled as a subscription
 * obligation attached to a liability profile is one $20 charge on Jul 30 —
 * so `kind` is deliberately excluded from their identity. Including it is
 * exactly what produced the reported duplicates:
 *
 *   Liability · ChatGPT Pro · $20.00      Jul 30
 *   Subscription · ChatGPT Pro · $20.00   Jul 30
 */
const PAYMENT_KINDS = new Set<OccurrenceKind>(["subscription", "liability", "bill", "renewal"]);

/** True when this series represents a recurring payment. */
export function isPaymentKind(kind: OccurrenceKind): boolean {
  return PAYMENT_KINDS.has(kind);
}

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

  // A person has ONE birthday, however many systems describe it.
  if (SINGLETON_KINDS.has(series.kind) && owner) {
    return `${series.kind}:${owner}`;
  }

  // A recurring payment is one payment. Anchor on the linked financial record
  // when there is one (source-ID match — the strongest signal), otherwise on
  // the owning profile, and keep the normalized title so two genuinely
  // different bills on the same liability stay two bills.
  if (PAYMENT_KINDS.has(series.kind)) {
    const anchor = series.source.linkedRecordId || owner;
    const name = slug(series.title);
    // Amount is part of the identity: two charges with the same name on the
    // same account for DIFFERENT sums are two charges, not one. A missing
    // amount stays blank so a liability that records no figure can still merge
    // with the obligation that does (handled by `isEquivalentPayment`).
    const amt = series.amount != null ? String(Math.round(series.amount * 100)) : "";
    // …and so is the schedule slot. Two $10 charges on the 3rd and the 17th are
    // two charges. `anchorSignature` compares the day-of-month rather than the
    // full date, so an obligation whose next due date has already rolled
    // forward still matches the liability it belongs to.
    const slot = anchorSignature(series);
    if (anchor) return `payment:${anchor}:${name}:${amt}:${slot}`;
    if (name) return `payment::${name}:${amt}:${slot}`;
    return `payment:record:${series.source.system}:${series.source.id}`;
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
};

/**
 * Rank a series as a dedup candidate — HIGHER wins. Explicit `shadow` loses
 * outright; otherwise the authoritative system wins; ties break toward the
 * series carrying more information (per-occurrence state, an amount).
 */
/**
 * For a merged payment, which representation should the user SEE?
 *
 * The obligation is the record that actually carries the schedule and the
 * amount; the liability profile is the financial record it hangs off. So a
 * merged ChatGPT Pro reads "Subscription · $20/month" with the liability kept
 * as metadata ("Linked financial record"), exactly as specified — not
 * "Liability" with the subscription hidden.
 */
const PAYMENT_SYSTEM_RANK: Partial<Record<SourceSystem, number>> = {
  obligation: 3,
  liability: 2,
  event: 1,
};

export function seriesPriority(series: CalendarSeries): number {
  if (series.shadow) return 0;
  let score = 1;
  if (isPaymentKind(series.kind)) {
    // Payments have their own precedence — every payment system is
    // "authoritative" for some payment kind, so AUTHORITY alone ties.
    score += 100 * (PAYMENT_SYSTEM_RANK[series.source.system] ?? 0);
  } else if (AUTHORITY[series.kind] === series.source.system) {
    score += 100;
  }
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


// ─── Secondary merge: the same payment described two ways ────────────────────
//
// Identity keys anchor payments on the linked financial record. That collapses
// an obligation with its liability, but NOT a hand-created recurring event
// describing the same charge — the event has no financial link to anchor on,
// so "Lubi" the subscription (anchored on its liability) and "Lubi — $10" the
// event (anchored on nothing) landed in different key spaces and both showed.
//
// This pass applies the fallback signals: normalized title, recurrence rule,
// schedule anchor, amount, and owner. It is deliberately conservative — every
// one of those must agree, and two records owned by DIFFERENT people never
// merge, so "do not delete separate records merely because their names are
// similar" still holds.

/**
 * Strip the boilerplate suffix an auto-generator appended to a title.
 *
 * User report 2026-07-25: "The same record is sometimes duplicated with names
 * such as 'Expiration' and 'Expires'." Two generators wrote the same source
 * date under different labels —
 *
 *   ⚠️ CA Vehicle Registration – Honda 2021 — Expiration   (document extraction)
 *   ⚠️ CA Vehicle Registration – Honda 2021 — Expires      (profile field)
 *
 * — and dedup by exact title kept both. Normalizing the suffix away lets the
 * pair collide. The base name still has to match, so two genuinely different
 * documents never merge.
 */
const GENERATED_SUFFIX_RE =
  /\s*[—–-]\s*(expiration|expires|expiry|expire|renewal|renews|renew|due|payment due|start date)\s*$/i;

export function stripGeneratedSuffix(title: string): string {
  let out = String(title ?? "").trim();
  // Repeat: a few rows carry two suffixes ("… — Card — Expiration").
  for (let i = 0; i < 3; i++) {
    const next = out.replace(GENERATED_SUFFIX_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out || String(title ?? "").trim();
}

/**
 * Two ONE-TIME dates from the same profile on the same day whose titles match
 * once the generated suffix is removed are the same real-world date.
 *
 * Restricted to non-recurring dates on purpose: a monthly bill and a yearly
 * renewal with similar names are genuinely different schedules.
 */
export function isDuplicateOneTimeDate(a: CalendarSeries, b: CalendarSeries): boolean {
  if (isRecurringRule(a) || isRecurringRule(b)) return false;
  if (a.baseDate !== b.baseDate || !a.baseDate) return false;
  const an = slug(stripGeneratedSuffix(a.title));
  const bn = slug(stripGeneratedSuffix(b.title));
  if (!an || an !== bn) return false;
  // Must share an owner, or one side must be unowned.
  const oa = ownerSet(a);
  const ob = ownerSet(b);
  if (oa.size === 0 || ob.size === 0) return true;
  for (const id of oa) if (ob.has(id)) return true;
  return false;
}

/** The scheduling fingerprint of a series: same rule AND same slot. */
function anchorSignature(series: CalendarSeries): string {
  const rec = String(series.recurrence || "").toLowerCase();
  const base = String(series.baseDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return `${rec}:?`;
  if (rec === "yearly") return `${rec}:${base.slice(5)}`;               // MM-DD
  if (rec === "weekly" || rec === "biweekly") {
    return `${rec}:${new Date(`${base}T12:00:00`).getDay()}`;           // weekday
  }
  if (rec === "monthly" || rec === "bimonthly" || rec === "quarterly") {
    return `${rec}:${base.slice(8, 10)}`;                               // day-of-month
  }
  return `${rec}:${base}`;
}

function ownerSet(series: CalendarSeries): Set<string> {
  const out = new Set<string>();
  for (const id of series.source.ownerIds || []) if (id) out.add(id);
  if (series.source.profileId) out.add(series.source.profileId);
  if (series.source.linkedRecordId) out.add(series.source.linkedRecordId);
  return out;
}

/**
 * Could these two series be the same real-world payment?
 *
 * Exported so the behaviour is directly testable rather than only observable
 * through a full dedup run.
 */
export function isEquivalentPayment(a: CalendarSeries, b: CalendarSeries): boolean {
  if (!isPaymentKind(a.kind) || !isPaymentKind(b.kind)) return false;
  if (slug(a.title) !== slug(b.title) || !slug(a.title)) return false;
  if (anchorSignature(a) !== anchorSignature(b)) return false;
  // Different amounts mean different charges, however alike the names.
  if (a.amount != null && b.amount != null && Math.abs(a.amount - b.amount) > 0.005) return false;
  const oa = ownerSet(a);
  const ob = ownerSet(b);
  if (oa.size === 0 || ob.size === 0) return true; // one side unowned — no conflict
  for (const id of oa) if (ob.has(id)) return true;
  return false; // owned by different people: genuinely two records
}

/**
 * Fold equivalent payments into the highest-priority representation, carrying
 * every absorbed id forward so the UI can still disclose them.
 */
export function mergeEquivalentPayments(groups: DedupedSeries[]): DedupedSeries[] {
  const out: DedupedSeries[] = [];
  for (const group of groups) {
    // Try BOTH predicates: "Renewal" is a payment kind, so a one-time
    // "… — Renewal" event would otherwise only be offered the payment test —
    // which compares raw titles and so never matched its "… — Expiration"
    // twin. The one-time rule is the stricter of the two (identical date,
    // identical base name), so checking it as well cannot over-merge.
    const match = out.find((held) =>
      (isPaymentKind(group.series.kind) && isPaymentKind(held.series.kind)
        && isEquivalentPayment(held.series, group.series))
      || isDuplicateOneTimeDate(held.series, group.series));
    if (!match) {
      out.push({ series: group.series, duplicateIds: [...group.duplicateIds] });
      continue;
    }
    const keepIncoming = seriesPriority(group.series) > seriesPriority(match.series);
    const winner = keepIncoming ? group.series : match.series;
    const loser = keepIncoming ? match.series : group.series;
    match.duplicateIds = [
      ...match.duplicateIds, ...group.duplicateIds, loser.id,
    ].filter((id) => id !== winner.id);
    // The obligation usually wins but may lack the amount the event carried.
    match.series = winner.amount == null && loser.amount != null
      ? { ...winner, amount: loser.amount }
      : winner;
  }
  return out;
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
  // Second pass for payments whose identities anchor differently (an
  // obligation on its liability, a hand-made event on nothing at all).
  return mergeEquivalentPayments([...byIdentity.values()]);
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
  /** This occurrence's own amount when the series carries one, else the series amount. */
  amount?: number;
  /** True when `amount` is a forecast (a variable bill that hasn't posted yet). */
  amountIsEstimate?: boolean;
  /** The series this came from, for the detail panel. */
  series: CalendarSeries;
}

/**
 * True when a kind has no completable state at all.
 *
 * User report 2026-07-25: "why is Joe's birthday crossed out for six months
 * and 18 months when that hasn't even occurred yet". Feb 11 2027 and 2028 both
 * rendered struck through and captioned "done", which also pushed the headline
 * NEXT date out to 2029.
 *
 * `capabilitiesFor` already refuses to let a birthday be checked off — but the
 * STATUS reader still honoured whatever `rd:done:` marks were sitting in the
 * data from an older build whose card did show a Done button. Disabling the
 * button was never enough: as long as the reader trusts those marks, one
 * historical tap keeps a birthday crossed out for years.
 *
 * A birthday is not a task. It has no done state, so the marks are ignored
 * rather than migrated away — which self-heals every record already carrying
 * them, with no data write.
 */
function hasCompletableState(kind: OccurrenceKind): boolean {
  return kind !== "birthday" && kind !== "anniversary";
}

function statusFor(
  series: CalendarSeries,
  date: string,
  todayISO: string,
  requireComplete: boolean,
): OccurrenceStatus {
  if (hasCompletableState(series.kind)) {
    if (series.completedDates?.includes(date)) return "done";
    if (series.skippedDates?.includes(date)) return "skipped";
  }
  if (date < todayISO) return requireComplete ? "overdue" : "past";
  if (date === todayISO) return "today";
  return "upcoming";
}

/**
 * The base date to expand from.
 *
 * For a birthday or anniversary the base date's YEAR carries no schedule
 * meaning — it is a birth year or a wedding year, and the real rule is
 * "every year on this month and day". A stored year is therefore never a
 * start date, and treating it as one is what produced:
 *
 *   "Joe's Birthday · Every year on Feb 11 · Next: Sun, Feb 11, 2029 · in 932 days"
 *
 * The event backing that card had drifted to a base of 2029-02-11, so
 * expansion "correctly" began in 2029 and skipped 2027 and 2028 entirely.
 * Re-anchoring to the year before today makes the next occurrence the
 * earliest Feb 11 after today, whatever year is stored — and the clamped
 * `addYearsISO` keeps a Feb-29 anniversary legal in non-leap years.
 *
 * Every other kind keeps its base date verbatim: a subscription that genuinely
 * starts next March must not be dragged into the past.
 */
function annualAnchoredBase(series: CalendarSeries, todayISO: string): string {
  const base = String(series.baseDate || "").slice(0, 10);
  if (!SINGLETON_KINDS.has(series.kind)) return base;
  if ((series.recurrence || "") !== "yearly") return base;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return base;
  const baseYear = Number(base.slice(0, 4));
  const anchorYear = Number(todayISO.slice(0, 4)) - 1;
  if (!Number.isFinite(baseYear) || !Number.isFinite(anchorYear)) return base;
  const baseDay = base.slice(8, 10);
  // Re-anchor to the year before today so this year's date is still in range.
  // A Feb-29 series would be CLAMPED to Feb 28 by that shift, and the expander
  // takes its day-of-month anchor from whatever base it is handed — so the
  // series would then be pinned to the 28th forever and never return to the
  // 29th on a leap year. Step back until the original day survives (at most
  // four years, for Feb 29); the expander's window filter drops the extra
  // early occurrences.
  for (let back = 0; back <= 4; back++) {
    const candidate = addYearsISO(base, anchorYear - back - baseYear);
    if (candidate.slice(8, 10) === baseDay) return candidate;
  }
  return addYearsISO(base, anchorYear - baseYear);
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

  const dates = expandRecurrenceDates(annualAnchoredBase(series, today), series.recurrence || "none", {
    recurrenceEnd: series.recurrenceEnd,
    windowStart,
    windowEnd,
    cap: opts.cap ?? 400,
  });

  const perDate = series.amountByDate || {};
  const estimated = new Set(series.estimatedDates || []);

  return dates.map((date) => {
    const effectiveDate = moved[date] || date;
    // A per-occurrence amount always wins over the series amount. That is the
    // whole point of a variable bill: August's $62 belongs to August.
    const own = perDate[date];
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
      amount: typeof own === "number" ? own : series.amount,
      amountIsEstimate: estimated.has(date) || undefined,
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
  // Systems that OWN their own record page always route to it, even when the
  // date is also linked to a profile. User report 2026-07-25: "sometimes when
  // I press the link, it brings me to somewhere else" — a document expiry
  // opened the linked person instead of the document, because any profileId
  // short-circuited the switch below. A document expiration belongs to the
  // document; that is the record you edit to change the date.
  if (system === "document" && recordId) return `#/documents/${recordId}`;
  if (system === "task" && recordId) return `#/tasks?focus=${recordId}`;
  if (profileId) return `#/profiles/${profileId}`;
  switch (system) {
    case "profile": return recordId ? `#/profiles/${recordId}` : "#/profiles";
    case "liability": return recordId ? `#/profiles/${recordId}` : "#/liabilities";
    case "obligation": return recordId ? `#/obligations?focus=${recordId}` : "#/obligations";
    case "task": return recordId ? `#/tasks?focus=${recordId}` : "#/tasks";
    case "document": return recordId ? `#/documents/${recordId}` : "#/documents";
    case "goal": return recordId ? `#/goals?focus=${recordId}` : "#/goals";
    case "habit": return recordId ? `#/habits?focus=${recordId}` : "#/habits";
    case "event": return recordId ? `#/calendar?event=${recordId}` : "#/calendar";
    default: return "#/calendar";
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/**
 * "in 3 days" / "today" / "2 days ago" for an occurrence date.
 *
 * Months and years are counted as real CALENDAR steps, not days divided by an
 * average month length. Beyond reading more accurately near month boundaries,
 * this keeps the module free of the average-length literals that the
 * frequency-multiplier contract (tests/smoke/contracts) forbids — those
 * constants belong to money conversion in shared/obligation-windows, and
 * nothing else should be inventing its own.
 */
export function relativeDayLabel(dateISO: string, todayISO: string): string {
  const from = new Date(`${todayISO.slice(0, 10)}T12:00:00`);
  const to = new Date(`${dateISO.slice(0, 10)}T12:00:00`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (!Number.isFinite(days)) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days < 30) return `in ${days} days`;

  // Whole calendar months between the two dates, trimmed by one when the
  // day-of-month hasn't been reached yet ("Jul 25 → Feb 11" is 6 months, not 7).
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  if (months < 1) return `in ${days} days`;
  if (months < 24) return `in ${months} mo`;
  return `in ${Math.floor(months / 12)} yr`;
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
