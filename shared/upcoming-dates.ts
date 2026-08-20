// shared/upcoming-dates.ts
// =============================================================================
// Upcoming Dates — cross-app reminder aggregator
// =============================================================================
import { parseRecurringMeta, nextOccurrence as rdNextOccurrence } from "./recurring-dates";
import {
  rulesFromAll,
  type DateRule,
  type DateRuleType,
} from "./date-rules";
import { addMonthsClamped, addYearsClamped, weekdaySetFor } from "./date-math";
// Pulls every time-sensitive item across the app into a single normalized stream
// so the dashboard can render one definitive "what's next" view.
//
// Source modules covered:
//   - Profiles (person/pet/self birthdays, anniversaries, license/passport/visa
//     expirations, vehicle registration/inspection, property tax, warranty,
//     insurance renewal, lease end, membership renewal, professional cert)
//   - Calendar events (one-time + recurring)
//   - Tasks (due dates)
//   - Obligations (bills, subscriptions, loan/CC payments, medication refills,
//     maintenance, scheduled appointments, document expirations)
//   - Documents (expirationDate)
//   - Goals (deadline / target date)
//   - Pets (vaccinations, next med dose, vet appointment)
//   - Travel (departure / return / reservation)
//   - Court / legal filing dates
//
// Design contract:
//   - Output entries always represent the next FUTURE occurrence (recurring
//     items roll forward; past one-time items are dropped at read time).
//   - Each entry carries a stable id, urgency, category, entityKind, and a
//     deep-link href so the UI can route to source.
// =============================================================================

export type UpcomingCategory =
  | "birthday"
  | "anniversary"
  | "holiday"
  | "doctor_appointment"
  | "dental_appointment"
  | "vet_appointment"
  | "calendar_event"
  | "task_due"
  | "bill_due"
  | "loan_payment"
  | "credit_card_payment"
  | "subscription_renewal"
  | "insurance_renewal"
  | "vehicle_registration"
  | "drivers_license_expiration"
  | "passport_expiration"
  | "visa_expiration"
  | "warranty_expiration"
  | "lease_renewal"
  | "property_tax"
  | "tax_filing"
  | "medication_refill"
  | "prescription_expiration"
  | "school_enrollment"
  | "certification_renewal"
  | "professional_license"
  | "membership_renewal"
  | "contract_renewal"
  | "document_expiration"
  | "travel_departure"
  | "travel_return"
  | "reservation"
  | "event_ticket"
  | "pet_vaccination"
  | "pet_medication"
  | "maintenance"
  | "inspection"
  | "scheduled_service"
  | "goal_target"
  | "habit_milestone"
  | "investment_maturity"
  | "court_date"
  | "legal_filing"
  | "reminder"
  | "custom";

export type UpcomingEntityKind =
  | "person"
  | "self"
  | "pet"
  | "vehicle"
  | "property"
  | "asset"
  | "liability"
  | "business"
  | "document"
  | "task"
  | "event"
  | "obligation"
  | "goal"
  | "habit"
  | "other";

export type UpcomingUrgency = "overdue" | "today" | "soon" | "upcoming" | "future";
export type UpcomingTimeframe = "today" | "this_week" | "next_30_days" | "future";

export interface UpcomingDate {
  /** Stable id — survives recurrence rolls because base id + nextDate is hashed. */
  id: string;
  /** Origin record id (profileId, taskId, eventId, etc.) — for click-through. */
  sourceId: string;
  category: UpcomingCategory;
  entityKind: UpcomingEntityKind;
  title: string;
  subtitle?: string;
  /** ISO YYYY-MM-DD of the next occurrence (always future or today). */
  nextDate: string;
  daysUntil: number;
  urgency: UpcomingUrgency;
  timeframe: UpcomingTimeframe;
  /** Recurring (birthday/anniversary/annual renewal) rolls forward automatically. */
  recurring: boolean;
  /** href the dashboard uses to deep-link to the source. */
  href: string;
  /** Optional related entity ids (e.g. for the click-through fallback). */
  relatedProfileId?: string;
  relatedDocumentId?: string;
  /** AI-style "needs action soon" badge driver. */
  needsActionSoon: boolean;
  /** Optional emoji/icon hint for the UI. */
  icon?: string;
}

// =============================================================================
// Category metadata
// =============================================================================

export const CATEGORY_LABELS: Record<UpcomingCategory, string> = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  holiday: "Holiday",
  doctor_appointment: "Doctor Appointment",
  dental_appointment: "Dental Appointment",
  vet_appointment: "Vet Appointment",
  calendar_event: "Calendar Event",
  task_due: "Task Due",
  bill_due: "Bill Due",
  loan_payment: "Loan Payment",
  credit_card_payment: "Credit Card Payment",
  subscription_renewal: "Subscription Renewal",
  insurance_renewal: "Insurance Renewal",
  vehicle_registration: "Vehicle Registration",
  drivers_license_expiration: "Driver's License",
  passport_expiration: "Passport",
  visa_expiration: "Visa",
  warranty_expiration: "Warranty",
  lease_renewal: "Lease Renewal",
  property_tax: "Property Tax",
  tax_filing: "Tax Filing",
  medication_refill: "Medication Refill",
  prescription_expiration: "Prescription",
  school_enrollment: "School Enrollment",
  certification_renewal: "Certification",
  professional_license: "Professional License",
  membership_renewal: "Membership",
  contract_renewal: "Contract Renewal",
  document_expiration: "Document Expiration",
  travel_departure: "Travel Departure",
  travel_return: "Travel Return",
  reservation: "Reservation",
  event_ticket: "Event Ticket",
  pet_vaccination: "Pet Vaccination",
  pet_medication: "Pet Medication",
  maintenance: "Maintenance",
  inspection: "Inspection",
  scheduled_service: "Service Appointment",
  goal_target: "Goal Target",
  habit_milestone: "Habit Milestone",
  investment_maturity: "Investment Maturity",
  court_date: "Court Date",
  legal_filing: "Legal Filing",
  reminder: "Reminder",
  custom: "Custom Date",
};

export const CATEGORY_ICONS: Record<UpcomingCategory, string> = {
  birthday: "🎂",
  anniversary: "💞",
  holiday: "🎉",
  doctor_appointment: "🩺",
  dental_appointment: "🦷",
  vet_appointment: "🐾",
  calendar_event: "📅",
  task_due: "✅",
  bill_due: "💵",
  loan_payment: "🏦",
  credit_card_payment: "💳",
  subscription_renewal: "🔁",
  insurance_renewal: "🛡️",
  vehicle_registration: "🚗",
  drivers_license_expiration: "🪪",
  passport_expiration: "🛂",
  visa_expiration: "🛂",
  warranty_expiration: "📜",
  lease_renewal: "🏠",
  property_tax: "🏛️",
  tax_filing: "📑",
  medication_refill: "💊",
  prescription_expiration: "💊",
  school_enrollment: "🎓",
  certification_renewal: "📘",
  professional_license: "📘",
  membership_renewal: "🪪",
  contract_renewal: "📝",
  document_expiration: "📄",
  travel_departure: "✈️",
  travel_return: "🛬",
  reservation: "🏨",
  event_ticket: "🎟️",
  pet_vaccination: "💉",
  pet_medication: "💊",
  maintenance: "🔧",
  inspection: "🔍",
  scheduled_service: "🛠️",
  goal_target: "🎯",
  habit_milestone: "🏆",
  investment_maturity: "📈",
  court_date: "⚖️",
  legal_filing: "📋",
  reminder: "⏰",
  custom: "📌",
};

/**
 * Categories that are inherently annual (birthdays, anniversaries, holidays,
 * annual renewals). When the stored date is in the past these roll forward to
 * the next occurrence.
 */
const ANNUAL_RECURRING: Set<UpcomingCategory> = new Set([
  // ONLY dates whose stored YEAR is meaningless. A birthday's year is a birth
  // year; an anniversary's is a wedding year; a holiday repeats forever. For
  // these, and only these, rolling to the next occurrence is correct.
  "birthday",
  "anniversary",
  "holiday",
  // REMOVED (user report 2026-07-25): vehicle_registration, property_tax,
  // tax_filing, membership_renewal, certification_renewal,
  // professional_license, insurance_renewal.
  //
  // "The Florida driver's license expires in 2034, but the calendar shows
  //  March 12 as 'in 7 months'."
  //
  // An EXPIRATION is a fixed point in time, not an annual recurrence. Calling
  // one "annual" sent it through rollAnnual, which throws the stored year away
  // and pins the month/day to the current year — turning 2034 into 2027. The
  // renewal that follows an expiry is a NEW date on a NEW document, not the
  // same date repeating.
]);

// =============================================================================
// Date helpers
// =============================================================================

/** ISO YYYY-MM-DD of today (local). */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse an ISO or ISO-ish date string into a stable midday Date (avoids TZ off-by-one). */
function parseDate(raw: string | undefined | null): Date | null {
  if (!raw || typeof raw !== "string") return null;
  // Accept YYYY-MM-DD, YYYY-MM-DDTHH:MM, full ISO. Pin to midday for date-only.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw;
  const d = new Date(dateOnly);
  return isNaN(d.getTime()) ? null : d;
}

function isoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = parseDate(fromISO);
  const b = parseDate(toISO);
  if (!a || !b) return Infinity;
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Roll an annual date forward to its next occurrence on/after today.
 *
 * NEVER invents a year for a date that already has a valid future one. The
 * stored year is only replaced when the date is in the PAST — which is the
 * only situation where "next occurrence" differs from "the date itself".
 *
 * Guard added 2026-07-25: this function used to unconditionally rebuild the
 * date as (currentYear, storedMonth, storedDay), so a 2034 expiry silently
 * became 2027. Callers must also be sure the category really is annual — see
 * ANNUAL_RECURRING, which no longer contains expirations.
 */
function rollAnnual(rawISO: string, todayStr: string): string | null {
  const d = parseDate(rawISO);
  if (!d) return null;
  const today = parseDate(todayStr)!;
  // Already in the future: that date IS the answer. Do not touch the year.
  if (d.getTime() >= today.getTime()) return isoFromDate(d);
  const candidate = new Date(today.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  if (candidate.getTime() < today.getTime()) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }
  return isoFromDate(candidate);
}

/** Roll a generic recurrence (CalendarEvent.recurrence) forward to next occurrence. */
function rollRecurrence(rawISO: string, pattern: string | undefined, todayStr: string, endISO?: string): string | null {
  const start = parseDate(rawISO);
  if (!start) return null;
  const today = parseDate(todayStr)!;
  const end = endISO ? parseDate(endISO) : null;
  if (!pattern || pattern === "none") {
    return start.getTime() >= today.getTime() ? isoFromDate(start) : null;
  }
  const next = new Date(start);
  // Month/year patterns index off the SERIES START and clamp to month end, so
  // a "day 31" series rolls 31 → 30 → 31 instead of overflowing to the 1st and
  // dragging every later occurrence with it (shared/date-math).
  const anchorDay = start.getDate();
  let step = 0;
  // weekdays (Mon–Fri), weekends (Sat/Sun) and weekly:<days> all step forward
  // to the next date whose day-of-week is in the set (shared/date-math).
  const daySet = weekdaySetFor(pattern);
  const advance = () => {
    step++;
    if (daySet) {
      do { next.setDate(next.getDate() + 1); } while (!daySet.has(next.getDay()));
      return;
    }
    switch (pattern) {
      case "daily": next.setDate(next.getDate() + 1); break;
      case "weekly": next.setDate(next.getDate() + 7); break;
      case "biweekly": next.setDate(next.getDate() + 14); break;
      case "monthly": next.setTime(addMonthsClamped(start, step, anchorDay).getTime()); break;
      case "yearly": next.setTime(addYearsClamped(start, step, anchorDay).getTime()); break;
      default: next.setDate(next.getDate() + 1);
    }
  };
  let safety = 4000;
  while (next.getTime() < today.getTime() && safety-- > 0) advance();
  if (end && next.getTime() > end.getTime()) return null;
  return isoFromDate(next);
}

function classifyUrgency(daysUntil: number): UpcomingUrgency {
  if (daysUntil < 0) return "overdue";
  if (daysUntil === 0) return "today";
  if (daysUntil <= 3) return "soon";
  if (daysUntil <= 14) return "upcoming";
  return "future";
}

function classifyTimeframe(daysUntil: number): UpcomingTimeframe {
  if (daysUntil <= 0) return "today";
  if (daysUntil <= 7) return "this_week";
  if (daysUntil <= 30) return "next_30_days";
  return "future";
}

function classifyEntityKind(profile: any): UpcomingEntityKind {
  if (!profile) return "other";
  const t = String(profile.type || "").toLowerCase();
  if (t === "person") return "person";
  if (t === "self") return "self";
  if (t === "pet") return "pet";
  if (t === "vehicle") return "vehicle";
  if (t === "property") return "property";
  if (t === "asset") return "asset";
  if (t === "liability" || t === "loan") return "liability";
  if (t === "business") return "business";
  return "other";
}

function hashId(parts: Array<string | number | undefined>): string {
  return parts.filter(Boolean).join("::");
}

// =============================================================================
// URGENCY COLOR PALETTE (HSL strings — no hsl() wrapper)
// =============================================================================

export const URGENCY_COLORS: Record<UpcomingUrgency, { bg: string; fg: string; border: string; label: string }> = {
  overdue:  { bg: "0 80% 96%",   fg: "0 75% 42%",   border: "0 72% 60%",   label: "Overdue" },
  today:    { bg: "25 95% 95%",  fg: "25 95% 38%",  border: "25 92% 55%",  label: "Today" },
  soon:     { bg: "38 96% 94%",  fg: "32 90% 35%",  border: "38 92% 55%",  label: "Soon" },
  upcoming: { bg: "215 90% 96%", fg: "215 80% 38%", border: "215 80% 58%", label: "Upcoming" },
  future:   { bg: "215 16% 95%", fg: "215 12% 38%", border: "215 14% 70%", label: "Future" },
};

export const TIMEFRAME_LABELS: Record<UpcomingTimeframe, string> = {
  today: "Today",
  this_week: "This Week",
  next_30_days: "Next 30 Days",
  future: "Next 45 Days",
};

// =============================================================================
// CATEGORY INFERENCE — map free-text fields/profile types to a category
// =============================================================================

function inferCategoryFromKey(key: string, profileType?: string): UpcomingCategory | null {
  const k = key.toLowerCase();
  if (k.includes("birthday") || k === "dob" || k === "dateofbirth" || k === "date_of_birth") return "birthday";
  if (k.includes("anniversary")) return "anniversary";
  if (k.includes("license") && (k.includes("expir") || k.includes("renewal"))) {
    if (profileType === "person" || profileType === "self") return "drivers_license_expiration";
    return "professional_license";
  }
  if (k.includes("passport")) return "passport_expiration";
  if (k.includes("visa")) return "visa_expiration";
  if (k.includes("warranty")) return "warranty_expiration";
  if (k.includes("registration")) return "vehicle_registration";
  if (k.includes("inspection")) return "inspection";
  if (k.includes("lease") && (k.includes("end") || k.includes("renew"))) return "lease_renewal";
  if (k.includes("propertytax") || k.includes("property_tax")) return "property_tax";
  if (k.includes("tax") && (k.includes("filing") || k.includes("deadline"))) return "tax_filing";
  if (k.includes("vaccination") || k.includes("vaccine")) return "pet_vaccination";
  if (k.includes("medication") || k.includes("refill")) return "medication_refill";
  if (k.includes("prescription")) return "prescription_expiration";
  if (k.includes("membership")) return "membership_renewal";
  if (k.includes("certification") || k.includes("certificate")) return "certification_renewal";
  if (k.includes("contract")) return "contract_renewal";
  if (k.includes("insurance") && (k.includes("expir") || k.includes("renewal"))) return "insurance_renewal";
  if (k.includes("maturity")) return "investment_maturity";
  if (k.includes("court")) return "court_date";
  if (k.includes("legal") && (k.includes("filing") || k.includes("deadline"))) return "legal_filing";
  if (k.includes("departure") || k.includes("travel")) return "travel_departure";
  if (k.includes("reservation")) return "reservation";
  if (k.includes("school") || k.includes("enrollment")) return "school_enrollment";
  if (k.includes("appointment")) {
    if (k.includes("dental")) return "dental_appointment";
    if (k.includes("vet")) return "vet_appointment";
    return "doctor_appointment";
  }
  if (k.includes("expiration") || k.includes("expir") || k.includes("expires")) return "document_expiration";
  return null;
}

// =============================================================================
// SOURCE EXTRACTORS — one per input module
// =============================================================================

interface AggregatorInputs {
  profiles?: any[];
  documents?: any[];
  tasks?: any[];
  events?: any[];
  obligations?: any[];
  goals?: any[];
}

function profileHref(p: any): string {
  return `#/profiles/${p.id}`;
}

/** "14:30" → "2:30 PM". Used by the task rows, which show the hour. */
function clockLabel(hhmm: unknown): string {
  const v = String(hhmm || "");
  if (!/^\d{2}:\d{2}$/.test(v)) return "";
  const [h, m] = v.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// (Removed: `walkProfileFields`. It was this module's own idea of which profile
// field is a meaningful date, and it disagreed with the calendar's — a licence
// on a person reached here and nowhere else. Superseded by the Date Rule engine
// below, and deleted rather than left dead so nothing calls it again.)

// ── Profiles & documents: derived from the ONE Date Rule engine ─────────────
//
// These two used to be hand-written walkers with their own idea of which field
// is a meaningful date — and that idea disagreed with the calendar's. A
// document's `expiration_date` was invisible here (only `expirationDate` was
// read) while a profile's `licenseExpiration` was invisible on the calendar.
// Both now read the same rules, so Upcoming and the Calendar cannot disagree
// about what dates exist; they differ only in how far ahead they look.

/** A Date Rule's semantic type → this feed's display category. */
const CATEGORY_FOR_SUBTYPE: Record<string, UpcomingCategory> = {
  drivers_license: "drivers_license_expiration",
  passport: "passport_expiration",
  visa: "visa_expiration",
  vehicle_registration: "vehicle_registration",
  insurance: "insurance_renewal",
  warranty: "warranty_expiration",
  lease: "lease_renewal",
  membership: "membership_renewal",
  subscription: "subscription_renewal",
  certification: "certification_renewal",
  loan: "loan_payment",
  medication: "prescription_expiration",
  contract: "contract_renewal",
  vaccination: "pet_vaccination",
  court: "court_date",
  travel: "travel_departure",
  school: "school_enrollment",
};

/**
 * The rule types whose SUBTYPE names the thing the date is about, and so should
 * pick the category.
 *
 * For everything else the type is the better answer: an insurance policy's
 * `paymentDueDate` is a bill due, not an insurance renewal, and letting the
 * surrounding document's subtype win filed it under the wrong one.
 */
const SUBTYPE_NAMES_THE_CATEGORY = new Set<DateRuleType>([
  "expiration", "renewal", "end", "cancellation", "appointment", "deadline",
  // A travel date is only ever an "event" by type; its subtype is what says
  // departure rather than an unnamed entry on the calendar.
  "event",
]);

const CATEGORY_FOR_RULE_TYPE: Partial<Record<DateRuleType, UpcomingCategory>> = {
  birthday: "birthday",
  anniversary: "anniversary",
  expiration: "document_expiration",
  renewal: "contract_renewal",
  payment: "bill_due",
  income: "custom",
  due: "bill_due",
  appointment: "doctor_appointment",
  deadline: "task_due",
  reminder: "reminder",
  event: "calendar_event",
  maintenance: "maintenance",
  start: "custom",
  end: "contract_renewal",
  cancellation: "contract_renewal",
};

function categoryForRule(r: DateRule): UpcomingCategory {
  const bySub = r.ruleSubtype ? CATEGORY_FOR_SUBTYPE[r.ruleSubtype] : undefined;
  if (bySub && SUBTYPE_NAMES_THE_CATEGORY.has(r.ruleType)) return bySub;
  // A refill is modelled as a `due` date, but "Medication Refill" is what it
  // is — the one place a subtype names the category outside the set above.
  if (r.ruleType === "due" && r.ruleSubtype === "medication") return "medication_refill";
  return CATEGORY_FOR_RULE_TYPE[r.ruleType] || "custom";
}

/**
 * Roll a rule forward to its next occurrence.
 *
 * A yearly rule (a birthday) rolls to this year's or next year's date; a
 * one-time rule (an expiration) stays put and simply drops out once past.
 */
function nextDateForRule(r: DateRule, today: string): string | null {
  if (!r.recurrence || r.recurrence === "none") return r.date;
  const rolled = rollRecurrence(r.date, r.recurrence, today, r.recurrenceEnd);
  return rolled;
}

function upcomingFromRules(rules: readonly DateRule[], profiles: any[]): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  const today = todayISO();
  const byId = new Map((profiles || []).map(p => [p.id, p]));
  for (const r of rules) {
    if (!r.active || !r.upcomingVisible) continue;
    const next = nextDateForRule(r, today);
    if (!next) continue;
    const daysUntil = daysBetween(today, next);
    const owner = r.profileId ? byId.get(r.profileId) : null;
    const category = categoryForRule(r);
    out.push({
      // The rule id is already stable and duplicate-free, so the feed inherits
      // that property instead of re-deriving an identity of its own.
      id: hashId([r.id, next]),
      sourceId: r.sourceEntityId,
      category,
      entityKind: r.sourceEntityType === "document"
        ? "document"
        : owner ? classifyEntityKind(owner) : "other",
      title: r.label,
      subtitle: r.sourceEntityType === "document"
        ? (owner ? `Document on ${owner.name}` : "Document expiration")
        : (owner?.name || r.subtitle),
      nextDate: next,
      daysUntil,
      urgency: classifyUrgency(daysUntil),
      timeframe: classifyTimeframe(daysUntil),
      recurring: r.occurrenceType === "recurring",
      href: r.href || "#/calendar",
      relatedProfileId: r.profileId,
      relatedDocumentId: r.sourceEntityType === "document" ? r.sourceEntityId : undefined,
      // Only dates you must DO something about. Flagging every rule within 30
      // days put birthdays and anniversaries into the dashboard's "needs action
      // soon" count, which is meant to be the short list of things that will go
      // wrong if ignored. `countdownEnabled` is exactly that set — expirations,
      // renewals, due dates, deadlines.
      needsActionSoon: r.countdownEnabled && daysUntil <= 30,
      icon: CATEGORY_ICONS[category],
    });
  }
  return out;
}

function extractTasks(tasks: any[]): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  const today = todayISO();
  for (const t of tasks || []) {
    if (!t || t.deletedAt) continue;
    if (t.status === "done") continue;
    if (!t.dueDate) continue;
    const parsed = parseDate(t.dueDate);
    if (!parsed) continue;
    const next = isoFromDate(parsed);
    if (parseDate(next)!.getTime() < parseDate(today)!.getTime()) continue;
    const daysUntil = daysBetween(today, next);
    out.push({
      id: hashId(["task", t.id, next]),
      sourceId: t.id,
      category: "task_due",
      entityKind: "task",
      title: t.title || "Task",
      // A task carries a clock time now, and the hour is the most useful thing
      // this row can say — it is what the retired reminder feed showed.
      subtitle: clockLabel(t.dueTime) || (t.priority ? `Priority: ${t.priority}` : undefined),
      nextDate: next,
      daysUntil,
      urgency: classifyUrgency(daysUntil),
      timeframe: classifyTimeframe(daysUntil),
      recurring: (t.tags || []).some((x: any) => String(x).startsWith("recur:")),
      href: `#/tasks`,
      relatedProfileId: (t.linkedProfiles || [])[0],
      needsActionSoon: daysUntil <= 3 || t.priority === "high",
      icon: CATEGORY_ICONS.task_due,
    });
  }
  return out;
}

function extractEvents(events: any[]): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  const today = todayISO();
  for (const e of events || []) {
    if (!e || !e.date) continue;
    // Recurring Dates (shared/recurring-dates): honor per-occurrence state.
    // A checked-off or skipped occurrence rolls to the FOLLOWING one; paused
    // and archived series drop out of the upcoming stream entirely.
    const rdMeta = parseRecurringMeta(e.tags);
    const hasRdState = rdMeta.paused || rdMeta.archived
      || rdMeta.completedDates.length > 0 || rdMeta.skippedDates.length > 0;
    const next = hasRdState
      ? rdNextOccurrence({ date: e.date, recurrence: e.recurrence, recurrenceEnd: e.recurrenceEnd, tags: e.tags }, today)
      : rollRecurrence(e.date, e.recurrence, today, e.recurrenceEnd);
    if (!next) continue;
    const daysUntil = daysBetween(today, next);
    const cat = categoryFromEvent(e);
    out.push({
      id: hashId(["event", e.id, next]),
      sourceId: e.id,
      category: cat,
      entityKind: "event",
      title: e.title || "Event",
      subtitle: e.location || (e.time ? `at ${e.time}` : undefined),
      nextDate: next,
      daysUntil,
      urgency: classifyUrgency(daysUntil),
      timeframe: classifyTimeframe(daysUntil),
      recurring: e.recurrence && e.recurrence !== "none",
      href: `#/calendar`,
      relatedProfileId: (e.linkedProfiles || [])[0],
      needsActionSoon: daysUntil <= 3,
      icon: CATEGORY_ICONS[cat] || CATEGORY_ICONS.calendar_event,
    });
  }
  return out;
}

function categoryFromEvent(e: any): UpcomingCategory {
  const title = String(e.title || "").toLowerCase();
  const cat = String(e.category || "").toLowerCase();
  if (title.includes("birthday")) return "birthday";
  if (title.includes("anniversary")) return "anniversary";
  if (title.includes("holiday")) return "holiday";
  if (title.includes("dentist") || title.includes("dental")) return "dental_appointment";
  if (title.includes("vet")) return "vet_appointment";
  if (title.includes("doctor") || title.includes("dr.") || title.includes("clinic") || title.includes("hospital")) return "doctor_appointment";
  if (title.includes("court")) return "court_date";
  if (title.includes("flight") || title.includes("departure") || (cat === "travel" && !title.includes("return"))) return "travel_departure";
  if (title.includes("return") && cat === "travel") return "travel_return";
  if (title.includes("reservation") || title.includes("booking")) return "reservation";
  if (title.includes("ticket") || title.includes("concert") || title.includes("show")) return "event_ticket";
  if (title.includes("maintenance") || title.includes("service")) return "scheduled_service";
  if (title.includes("inspection")) return "inspection";
  return "calendar_event";
}

function categoryFromObligation(o: any): UpcomingCategory {
  const kind = String(o.kind || "").toLowerCase();
  const cat = String(o.category || "").toLowerCase();
  const name = String(o.name || "").toLowerCase();
  if (kind === "subscription" || cat === "subscription") return "subscription_renewal";
  if (kind === "loan_payment" || cat === "loan") {
    if (name.includes("credit card") || name.includes("cc ")) return "credit_card_payment";
    return "loan_payment";
  }
  if (kind === "medication") return "medication_refill";
  if (kind === "maintenance") return "maintenance";
  if (kind === "appointment") return "doctor_appointment";
  if (kind === "doc_expiration") return "document_expiration";
  if (kind === "habit") return "habit_milestone";
  if (cat === "insurance") return "insurance_renewal";
  return "bill_due";
}

function extractObligations(obligations: any[]): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  const today = todayISO();
  for (const o of obligations || []) {
    if (!o || o.status === "cancelled" || o.status === "paused") continue;
    if (!o.nextDueDate) continue;
    const parsed = parseDate(o.nextDueDate);
    if (!parsed) continue;
    const next = isoFromDate(parsed);
    if (parseDate(next)!.getTime() < parseDate(today)!.getTime()) continue;
    const daysUntil = daysBetween(today, next);
    const cat = categoryFromObligation(o);
    out.push({
      id: hashId(["obligation", o.id, next]),
      sourceId: o.id,
      category: cat,
      entityKind: "obligation",
      title: o.name || "Obligation",
      subtitle: typeof o.amount === "number" ? `${o.currency || "$"}${o.amount.toFixed(2)}` : undefined,
      nextDate: next,
      daysUntil,
      urgency: classifyUrgency(daysUntil),
      timeframe: classifyTimeframe(daysUntil),
      recurring: o.frequency && o.frequency !== "once",
      href: `#/obligations`,
      relatedProfileId: (o.linkedProfiles || [])[0],
      needsActionSoon: !o.autopay && daysUntil <= (o.leadTimeDays || 7),
      icon: CATEGORY_ICONS[cat],
    });
  }
  return out;
}

function extractGoals(goals: any[]): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  const today = todayISO();
  for (const g of goals || []) {
    if (!g || !g.deadline) continue;
    if (g.status === "completed" || g.status === "abandoned") continue;
    const parsed = parseDate(g.deadline);
    if (!parsed) continue;
    const next = isoFromDate(parsed);
    if (parseDate(next)!.getTime() < parseDate(today)!.getTime()) continue;
    const daysUntil = daysBetween(today, next);
    out.push({
      id: hashId(["goal", g.id, next]),
      sourceId: g.id,
      category: "goal_target",
      entityKind: "goal",
      title: g.title || "Goal",
      subtitle: g.target ? `${g.current ?? 0} / ${g.target} ${g.unit || ""}` : undefined,
      nextDate: next,
      daysUntil,
      urgency: classifyUrgency(daysUntil),
      timeframe: classifyTimeframe(daysUntil),
      recurring: false,
      href: `#/goals`,
      relatedProfileId: (g.linkedProfiles || [])[0],
      needsActionSoon: daysUntil <= 14,
      icon: CATEGORY_ICONS.goal_target,
    });
  }
  return out;
}

// =============================================================================
// AGGREGATE
// =============================================================================

/**
 * Default reminder window. Items farther than this are dropped — Upcoming is a
 * reminder feed, not an annual roster, so a birthday 11 months out doesn't
 * belong here. Override via aggregateUpcomingDates({ windowDays }).
 */
export const DEFAULT_UPCOMING_WINDOW_DAYS = 45;

export interface AggregateOptions {
  /** Maximum days out to include. Anything > windowDays is dropped. Default 45. */
  windowDays?: number;
}

export function aggregateUpcomingDates(
  input: AggregatorInputs,
  options: AggregateOptions = {},
): UpcomingDate[] {
  const windowDays = options.windowDays ?? DEFAULT_UPCOMING_WINDOW_DAYS;

  const all: UpcomingDate[] = [];
  // ONE rule engine feeds both the profile-carried and document-carried dates.
  all.push(...upcomingFromRules(
    rulesFromAll({ profiles: input.profiles || [], documents: input.documents || [] }),
    input.profiles || [],
  ));
  all.push(...extractTasks(input.tasks || []));
  all.push(...extractEvents(input.events || []));
  all.push(...extractObligations(input.obligations || []));
  all.push(...extractGoals(input.goals || []));

  // First pass: dedupe by id (recurrence rolls + explicit calendar entries may collide).
  const byId = new Map<string, UpcomingDate>();
  for (const item of all) {
    const prev = byId.get(item.id);
    if (!prev || item.daysUntil < prev.daysUntil) byId.set(item.id, item);
  }

  // Second pass: semantic dedup. A person's birthday or a vehicle's registration
  // can be sourced from multiple places (profile field, profile recurring,
  // attached document). Collapse by (relatedProfileId || sourceId) + category +
  // nextDate so the user sees each real-world date exactly once.
  const bySemantic = new Map<string, UpcomingDate>();
  for (const item of byId.values()) {
    const ownerKey = item.relatedProfileId || item.sourceId;
    const semKey = `${ownerKey}::${item.category}::${item.nextDate}`;
    const prev = bySemantic.get(semKey);
    if (!prev) {
      bySemantic.set(semKey, item);
      continue;
    }
    // Prefer the entry with the richer subtitle / non-document entityKind so
    // the dashboard shows "Luna — Birthday · Personal" over "Luna — Birthday · Birthday".
    const preferIncoming =
      (item.entityKind !== "document" && prev.entityKind === "document") ||
      (!!item.subtitle && !prev.subtitle && item.entityKind === prev.entityKind);
    if (preferIncoming) bySemantic.set(semKey, item);
  }

  // (Removed 2026-08-09: a third pass that dropped a reminder row when a
  // calendar event of the same title+date existed. Chat used to write BOTH — a
  // reminder plus a mirrored companion event — and this untangled them. A timed
  // task is one row that is its own calendar entry, so there is nothing to
  // untangle.)

  const today = todayISO();
  const todayMs = parseDate(today)!.getTime();
  const filtered = [...bySemantic.values()].filter(u => {
    const ms = parseDate(u.nextDate)?.getTime();
    if (ms === undefined || ms < todayMs) return false;
    // Horizon — drop anything farther than windowDays out.
    return u.daysUntil <= windowDays;
  });
  filtered.sort((a, b) => a.daysUntil - b.daysUntil || a.title.localeCompare(b.title));
  return filtered;
}

/** Group by timeframe bucket in render order. */
export function groupByTimeframe(items: UpcomingDate[]): Array<{ timeframe: UpcomingTimeframe; items: UpcomingDate[] }> {
  const buckets: Record<UpcomingTimeframe, UpcomingDate[]> = {
    today: [], this_week: [], next_30_days: [], future: [],
  };
  for (const it of items) buckets[it.timeframe].push(it);
  return (["today", "this_week", "next_30_days", "future"] as UpcomingTimeframe[])
    .map(tf => ({ timeframe: tf, items: buckets[tf] }))
    .filter(b => b.items.length > 0);
}

export function daysUntilLabel(daysUntil: number): string {
  if (daysUntil <= 0) return "Today";
  if (daysUntil === 1) return "Tomorrow";
  if (daysUntil < 7) return `in ${daysUntil} days`;
  if (daysUntil < 30) return `in ${Math.round(daysUntil / 7)} wk`;
  if (daysUntil < 365) return `in ${Math.round(daysUntil / 30)} mo`;
  return `in ${Math.round(daysUntil / 365)} yr`;
}
