// shared/executive-sections.ts — the Executive tab's ten sections.
//
// The tab is organised into named sections again, but NOT the way it was before
// the redesign. The old board let every section run its own filter over the raw
// data, so one overdue bill could appear as a bill, as a "critical
// notification", and again on a calendar strip. Here, every candidate row is
// assigned to EXACTLY ONE section by a single routing pass:
//
//   1. Each source is extracted into AttentionItem-shaped candidates.
//   2. Sections claim candidates in PRECEDENCE order (below), keyed by
//      `sourceKey`. Once a record is claimed, no later section can show it.
//   3. Sections render in the user's DISPLAY order, which is different.
//
// Precedence is "most specific wins": Immediate Attention takes anything
// genuinely on fire, then domain sections (health, important dates, habits,
// documents, bills) take their own, and only then do the generic time buckets
// (today, next 7 days) get what's left. That is why a dentist appointment lands
// under Health rather than Today's Agenda, and an expiring passport under
// Documents rather than Upcoming.
//
// Threshold behaviour differs by section on purpose: Immediate Attention is
// filtered by the user's attention config (it must stay short and true), while
// every other section is the complete list for its own window, capped only for
// display.

import { computeAttention, BIRTHDAY_RE, type AttentionItem, type AttentionInputs, type AttentionConfig } from "./attention";
import { ruleClaimKey } from "./date-rules";
import { dayLabel } from "./now-rank";
import { isHabitDueOn, isHabitDoneOn } from "./habit-schedule";
import { habitDayProgress } from "./habit-progress";
import { computeKeyFindings } from "./tracker-insights";
import { isMedicationTracker, computeMissedDoses } from "./medication-doses";
import { parseRecurringMeta, kindDef, type RecurringKind } from "./recurring-dates";

export type ExecSectionId =
  | "immediate" | "today" | "habits" | "bills" | "upcoming"
  | "importantDates" | "documents" | "health" | "activity" | "insights"
  | "recommendations";

export interface ExecSection {
  id: ExecSectionId;
  title: string;
  /** Context line under the title — progress, or where the rest went. */
  subtitle?: string;
  accent: string;
  items: AttentionItem[];
  /** Items before the display cap, so "+N more" can be honest. */
  total: number;
  /** Completion for the day, when the section has one (habits). Drawn as a ring. */
  progress?: { done: number; total: number };
  /** Money at stake in this section (bills). Drawn as a headline figure. */
  amount?: number;
  /**
   * Overrides the renderer's static per-section emphasis when the section's
   * own contents change how loudly it should speak — Important Dates folds
   * itself away as reference material until something lands inside the week.
   */
  emphasis?: "hero" | "working" | "reference";
}

/** The order the user reads them in. */
export const SECTION_DISPLAY_ORDER: ExecSectionId[] = [
  "immediate", "today", "habits", "bills", "upcoming",
  "importantDates", "documents", "health", "activity", "insights",
  "recommendations",
];

/** The order they get to claim a record. Most specific first. */
const SECTION_CLAIM_ORDER: ExecSectionId[] = [
  "immediate", "health", "importantDates", "habits", "documents",
  "bills", "today", "upcoming", "activity", "insights",
  // Last: AI recommendations are generated text about the rest of the tab,
  // never a record another section wants.
  "recommendations",
];

const TITLES: Record<ExecSectionId, string> = {
  immediate: "Immediate Attention",
  today: "Today's Agenda",
  habits: "Habits Due Today",
  bills: "Bills & Financial Obligations",
  upcoming: "Upcoming · Next 7 Days",
  importantDates: "Important Dates",
  documents: "Documents & Expirations",
  health: "Health",
  activity: "Recent Activity",
  insights: "Insights & Suggestions",
  recommendations: "AI Recommendations",
};

const ACCENTS: Record<ExecSectionId, string> = {
  immediate: "0 72% 58%",    // red
  today:     "199 89% 60%",  // sky
  habits:    "155 65% 45%",  // emerald
  bills:     "48 96% 53%",   // yellow
  upcoming:  "239 84% 67%",  // indigo
  importantDates: "330 80% 62%", // pink
  documents: "205 90% 58%",  // blue
  health:    "350 85% 62%",  // rose
  activity:  "173 60% 44%",  // teal
  insights:  "280 75% 62%",  // purple
  recommendations: "262 70% 62%", // violet — the app's AI accent
};

/** Rows past this per section collapse behind "+N more" in the UI.
 *
 *  The builder used to TRUNCATE `items` to this and report the true count in
 *  `total`, which left the "+N more" button with nothing to reveal: pressing it
 *  hid the button and no extra rows appeared, because they had never been sent
 *  (QA report 2026-08-05 — Immediate Attention +5, Habits +4, Health +1).
 *  `items` now carries every row and the UI does the collapsing, so the button
 *  has something to expand into. */
export const DISPLAY_CAP = 8;

// ── Classifiers ──────────────────────────────────────────────────────────────

/** Anything a reasonable person files under "health". */
export const HEALTH_RE =
  /\b(medication|medicine|meds?|prescription|refill|pharmacy|rx|dose|dosage|pill|tablet|capsule|inhaler|insulin|vaccine|vaccination|booster|doctor|dentist|dental|orthodont|physician|clinic|hospital|surgery|therapy|therapist|physio|chiro|optometr|ophthalm|dermatolog|cardiolog|lab work|bloodwork|blood test|x-ray|mri|checkup|check-up|physical|screening|immunization|vet)\b/i;

/**
 * Medication by shape rather than by name, since we can't ship a drug index.
 *
 * Two signals: a dosage ("500mg", "10 mcg", "2 tablets") and the suffixes drug
 * names are built from. The suffix half is guarded by a length lookahead so
 * "April" doesn't read as a -pril drug — the whole word must be at least seven
 * letters, which "lisinopril", "metformin" and "atenolol" clear and ordinary
 * English words ending the same way do not.
 */
export const MEDICATION_RE = new RegExp(
  [
    String.raw`\b\d+\s?(?:mg|mcg|µg|ml|g|iu|units?)\b`,
    String.raw`\b(?=[a-z]{7,}\b)[a-z]*(?:cillin|mycin|statin|pril|sartan|olol|azole|dipine|formin|zepam|codone|profen|tidine|thyroxine)\b`,
  ].join("|"),
  "i",
);

/** Holidays are important dates too — annual, not actionable. */
export const HOLIDAY_RE =
  /\b(holiday|christmas|thanksgiving|new year|easter|hanukkah|diwali|ramadan|eid|halloween|independence day|labor day|memorial day|veterans day|juneteenth)\b/i;

export function isHealthText(...parts: Array<string | null | undefined>): boolean {
  const s = parts.filter(Boolean).join(" ");
  return HEALTH_RE.test(s) || MEDICATION_RE.test(s);
}

export function isBirthdayText(...parts: Array<string | null | undefined>): boolean {
  const s = parts.filter(Boolean).join(" ");
  return BIRTHDAY_RE.test(s) || HOLIDAY_RE.test(s);
}

/**
 * The recurring kinds that belong under Important Dates.
 *
 * Deliberately a whitelist, not "everything the manager can create". Important
 * Dates claims BEFORE bills (see SECTION_CLAIM_ORDER), so admitting `bill` or
 * `subscription` here would quietly empty the Bills section of every date the
 * user manages as a recurring series. `appointment` is excluded for the same
 * reason in the other direction — the health builders already claim it.
 */
const CELEBRATORY_KINDS = new Set<RecurringKind>(["birthday", "anniversary", "custom"]);

/**
 * What kind of important date this row is, resolved most-authoritative first —
 * or null when it isn't one.
 *
 * The label is worth having rather than inferring at render time: a section
 * that mixes a birthday, a holiday and a graduation is unreadable if every row
 * just shows a date.
 */
export function importantDateKind(e: any): string | null {
  // 1. A profile's own date-of-birth/anniversary field. Authoritative: it is
  //    stamped by calendar-adapters, so "Nan's 90th" resolves correctly where
  //    the title regex sees nothing.
  const stamped = String(e?.meta?.kind || "").toLowerCase();
  if (stamped === "birthday") return "Birthday";
  if (stamped === "anniversary") return "Anniversary";

  // 2. A date created through the Recurring Dates manager carries its type as
  //    an `rd:kind:<kind>` tag, which rides to us on meta.tags.
  const rd = parseRecurringMeta(e?.meta?.tags);
  if (rd.kind) return CELEBRATORY_KINDS.has(rd.kind) ? kindDef(rd.kind).label : null;

  // 3. Fall back to reading the title. Holidays first, so Christmas stops
  //    reporting itself as a birthday.
  const text = `${e?.title || ""} ${e?.category || ""}`;
  if (HOLIDAY_RE.test(text)) return "Holiday";
  if (BIRTHDAY_RE.test(text)) return /anniversar/i.test(text) ? "Anniversary" : "Birthday";
  return null;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ExecSectionInputs extends AttentionInputs {
  /** stats.recentActivity rows: [{ type, description, timestamp }]. */
  recentActivity?: any[];
  /** /api/insights rows (shared/schema Insight). */
  insights?: any[];
  /**
   * /api/obligations rows. Distinct from `bills` (which is the finance
   * snapshot's flattened upcomingBills and carries no `kind`) — the Health
   * section needs `kind` and `payments[]` to tell a medication from a bill.
   */
  obligations?: any[];
  /** /api/trackers rows, entries inline (`.values` + server-computed `.computed`). */
  trackers?: any[];
  /** Rows from /api/dashboard/ai-suggestions, once the user has asked for them. */
  recommendations?: any[];
}

/** How far back a vitals reading still counts as "current". */
const VITALS_FRESH_DAYS = 14;
/** Entries scanned per tracker when looking for the latest reading. */
const VITALS_SCAN_DEPTH = 40;
/** Unlogged doses in the last week before the tab mentions a gap. */
const ADHERENCE_GAP_MIN = 2;

// ── Small builders ───────────────────────────────────────────────────────────

function daysBetween(todayISO: string, dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const target = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
  const a = new Date(`${todayISO}T12:00:00`).getTime();
  const b = new Date(`${target}T12:00:00`).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function timeLabel(t: string | null | undefined): string {
  const s = String(t || "").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(s)) return "";
  const [h, m] = s.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ── The router ───────────────────────────────────────────────────────────────

/**
 * The identity a calendar item claims, so it appears in exactly ONE section.
 *
 * Date-Rule items all carry the source ENTITY as their sourceId, so a person
 * with a birthday and a licence expiration emitted two items claiming
 * `event:<profileId>` and all but the first were dropped everywhere. The rule
 * is the distinct key — but EVERY section has to use it, or the same date
 * claims two keys and renders in two sections instead of none.
 */
function eventClaimKey(e: any): string {
  return e?.meta?.ruleId ? ruleClaimKey(e.meta.ruleId) : `event:${e?.sourceId || e?.id}`;
}


export function buildExecutiveSections(
  input: ExecSectionInputs,
  config?: Partial<AttentionConfig>,
): ExecSection[] {
  const now = input.now ?? new Date();
  const today = input.today || now.toLocaleDateString("en-CA");
  const nowClock = now.toTimeString().slice(0, 5);
  const cfg = config || {};

  // Candidates per section, before claiming.
  const cand: Record<ExecSectionId, AttentionItem[]> = {
    immediate: [], today: [], habits: [], bills: [], upcoming: [],
    importantDates: [], documents: [], health: [], activity: [], insights: [],
    recommendations: [],
  };

  // ── §1 Immediate Attention ─────────────────────────────────────────────────
  // Runs through the full attention model so the user's threshold and filters
  // apply here — this is the section that must stay short and true. Only what
  // is genuinely on fire: past its date, or an alert nothing else represents.
  const attention = computeAttention(input, cfg);
  for (const item of attention.items) {
    const overdue = (item.daysUntil ?? 0) < 0;
    if (overdue || item.kind === "alert") cand.immediate.push(item);
  }

  // ── §8 Health ──────────────────────────────────────────────────────────────
  // The tab's medical surface, in descending order of "the user must act on
  // this today". Every builder below keys on the CANONICAL sourceKey of the
  // record it describes (`obligation:<id>`, `tracker:<id>`), which is what
  // stops a medication also rendering as a bill and a blood-pressure reading
  // also rendering as an insight — see the claim loop.
  //
  // Medications and refills come off the TASK rows — "take Amoxicillin at 8am"
  // is a timed task since reminders were retired (2026-08-09); medical
  // appointments come off the calendar.
  for (const item of attention.items) {
    if (item.kind === "task" && isHealthText(item.title)) cand.health.push(item);
  }

  // (a) Doses due — medication obligations with nothing logged against today.
  // `upcomingBills` carries every obligation within 30 days regardless of kind,
  // so before this existed a daily medication rendered under "Bills &
  // Financial Obligations". Claiming it here (health precedes bills) is what
  // moves it.
  let medsDue = 0;
  for (const o of input.obligations || []) {
    if (!o?.id || o.status === "cancelled" || o.status === "paused") continue;
    const kind = String(o.kind || "").toLowerCase();
    if (kind === "medication") {
      const takenToday = (o.payments || []).some(
        (p: any) => String(p?.date || "").slice(0, 10) === today,
      );
      if (takenToday) continue;
      const du = daysBetween(today, String(o.nextDueDate || "").slice(0, 10));
      // Not yet due — a dose scheduled for Friday is not a Tuesday problem.
      if (du != null && du > 0) continue;
      medsDue++;
      cand.health.push({
        key: `med:${o.id}`, sourceKey: `obligation:${o.id}`, kind: "reminder",
        title: o.name || "Medication",
        reason: du != null && du < 0 ? `Not logged — ${Math.abs(du)}d behind` : "Due today · not logged",
        tier: "immediate", daysUntil: du ?? 0, score: 0, href: "/wellness",
        action: { kind: "taken", label: "Taken" },
      });
      continue;
    }
    // Appointments live on the obligations table too, and the calendar sweep
    // below only sees them if the user ALSO created an event.
    if (kind === "appointment") {
      const du = daysBetween(today, String(o.nextDueDate || "").slice(0, 10));
      if (du == null || du < 0 || du > 14) continue;
      cand.health.push({
        key: `appt:${o.id}`, sourceKey: `obligation:${o.id}`, kind: "event",
        title: o.name || "Appointment",
        reason: du === 0 ? "Today" : dayLabel(du),
        tier: du === 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
        daysUntil: du, score: 0, href: "/wellness",
        action: { kind: "open", label: "Open" },
      });
    }
  }

  // (b) Readings the server already flagged as out of range. These bands are
  // stamped onto the entry at write time (server/storage.ts), so this reads a
  // verdict rather than re-deriving one — the tab and the tracker page can
  // never disagree about what "high" means.
  //
  // Runs BEFORE the statistical sweep in (c) so that when a tracker trips
  // both, the clinical band is the row that survives the claim.
  let abnormalReadings = 0;
  for (const t of input.trackers || []) {
    if (!t?.id) continue;
    const entries = (t.entries || []);
    if (entries.length === 0) continue;
    // Scan from the end: entries are stored oldest-first and a long history
    // should not cost a full walk on every render.
    let latest: any = null;
    for (let i = entries.length - 1; i >= Math.max(0, entries.length - VITALS_SCAN_DEPTH); i--) {
      const e = entries[i];
      if (!e?.computed) continue;
      latest = e;
      break;
    }
    if (!latest) continue;
    const ageDays = daysBetween(String(latest.timestamp || "").slice(0, 10), today);
    if (ageDays == null || ageDays < 0 || ageDays > VITALS_FRESH_DAYS) continue;

    const bp = String(latest.computed.bloodPressureCategory || "");
    const sleep = String(latest.computed.sleepQuality || "");
    let title = "", reason = "", critical = false;
    if (bp === "crisis" || bp === "high_stage2" || bp === "high_stage1") {
      critical = bp === "crisis";
      const label = bp === "crisis" ? "hypertensive crisis"
        : bp === "high_stage2" ? "stage 2 high" : "stage 1 high";
      title = `${t.name || "Blood pressure"} reading is ${label}`;
      const sys = latest.values?.systolic, dia = latest.values?.diastolic;
      reason = [sys && dia ? `${sys}/${dia}` : "", ageDays === 0 ? "logged today" : `${ageDays}d ago`]
        .filter(Boolean).join(" · ");
    } else if (sleep === "poor") {
      title = `${t.name || "Sleep"} logged as poor`;
      reason = ageDays === 0 ? "Logged today" : `${ageDays}d ago`;
    } else continue;

    abnormalReadings++;
    cand.health.push({
      key: `vital:${t.id}`, sourceKey: `tracker:${t.id}`, kind: "alert",
      title, reason,
      tier: critical ? "immediate" : "soon",
      daysUntil: 0, score: 0, href: `/trackers?open=${t.id}`,
      action: { kind: "open", label: "Open" },
    });
  }

  // (c) Statistical outliers, from the same engine the Key Findings section
  // uses — a reading >2σ off its own baseline, or a run of short nights. Only
  // the warnings: a positive anomaly is good news and does not belong on a
  // section headed "Health" alongside a missed dose.
  if ((input.trackers || []).length > 0) {
    const findings = computeKeyFindings({ trackers: input.trackers as any } as any);
    for (const f of findings) {
      if (f.kind !== "tracker_anomaly" || f.severity !== "warning" || !f.trackerId) continue;
      cand.health.push({
        key: `anomaly:${f.trackerId}`, sourceKey: `tracker:${f.trackerId}`, kind: "alert",
        title: f.title, reason: f.detail || "Unusual against its own baseline",
        tier: "soon", daysUntil: 0, score: 0, href: f.href,
        action: { kind: "open", label: "Open" },
      });
    }
  }

  // (d) Adherence gaps. `unlogged_gap` is expected-minus-logged, which is NOT
  // the same claim as "you missed a dose" — the wording here has to stay on
  // the honest side of that line (see shared/medication-doses.ts).
  for (const t of input.trackers || []) {
    if (!t?.id || !isMedicationTracker(t as any)) continue;
    const dose = computeMissedDoses(t as any, { days: 7, now: now.getTime() });
    if (dose.unlogged_gap < ADHERENCE_GAP_MIN) continue;
    cand.health.push({
      key: `adherence:${t.id}`, sourceKey: `tracker:${t.id}`, kind: "alert",
      title: `${dose.medication}: ${dose.unlogged_gap} doses unlogged this week`,
      reason: `${dose.taken} of ${dose.expected} expected doses logged — a gap, not a confirmed miss`,
      tier: "soon", daysUntil: 0, score: 0, href: `/trackers?open=${t.id}`,
      action: { kind: "open", label: "Review" },
    });
  }

  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    const du = daysBetween(today, e.date);
    if (du == null || du < 0 || du > 14) continue;
    if (!isHealthText(`${e.title || ""} ${e.category || ""}`)) continue;
    cand.health.push({
      key: `event:${e.id}`, sourceKey: eventClaimKey(e), kind: "event",
      title: e.title || "Appointment",
      reason: [du === 0 ? "Today" : dayLabel(du), timeLabel(e.time)].filter(Boolean).join(" · "),
      tier: du === 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
      daysUntil: du, score: 0, href: "/calendar",
      action: { kind: "open", label: "Open" },
    });
  }

  // ── §6 Important Dates ─────────────────────────────────────────────────────
  // Birthdays, anniversaries, holidays and any occasion the user manages as a
  // Recurring Date. The dates you are judged on remembering.
  //
  // One date two days out and one six weeks out are not the same news, so the
  // section counts what falls inside the week and asks the renderer to unfold
  // itself when any does.
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    // Already checked off. The timeline resolves `completed` per occurrence
    // from the `rd:done:<date>` tag, so ticking this year's anniversary on the
    // calendar has to stop the briefing nagging about it.
    if (e.completed) continue;
    const du = daysBetween(today, e.date);
    if (du == null || du < 0 || du > 45) continue;
    const kindLabel = importantDateKind(e);
    if (!kindLabel) continue;
    // Only a manager-created series can be checked off from here. A profile's
    // birthday has `sourceId` of `profile:<id>:birthday` — not an event id —
    // so offering Done on one would PATCH /api/events/profile:… and 404.
    const canMarkDone = parseRecurringMeta(e.meta?.tags).isRecurringDate;
    const claimKey = eventClaimKey(e);
    cand.importantDates.push({
      key: `event:${e.id}`, sourceKey: claimKey, kind: "event",
      title: e.title || "Occasion",
      reason: [kindLabel, du === 0 ? "Today" : dayLabel(du)].filter(Boolean).join(" · "),
      tier: du === 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
      daysUntil: du, score: 0, href: "/calendar",
      action: canMarkDone ? { kind: "markdone", label: "Done" } : { kind: "open", label: "Open" },
    });
  }

  // ── §3 Habits Due Today ────────────────────────────────────────────────────
  // Listed individually here — the roll-up existed to stop seven habits
  // crowding a single feed, and a dedicated section is exactly the place they
  // belong. Scheduling comes from shared/habit-schedule, so a weekly habit does
  // not appear on the other six days.
  let habitsDue = 0, habitsDone = 0;
  for (const h of input.habits || []) {
    if (!h?.id || !isHabitDueOn(h, today)) continue;
    habitsDue++;
    if (isHabitDoneOn(h, today)) { habitsDone++; continue; }
    const streak = Number(h.currentStreak ?? h.streak ?? 0);
    const hp = habitDayProgress(h, today);
    cand.habits.push({
      key: `habit:${h.id}`, sourceKey: `habit:${h.id}`, kind: "habit",
      title: h.name || "Habit",
      // "Not checked in yet" was shown for a habit already at 1 of 2 — the
      // partial state had nowhere to appear, so it read as zero progress.
      reason: hp.isPartial
        ? `${hp.completed} of ${hp.required} done · ${hp.remaining} to go`
        : streak >= 3 ? `${streak}-day streak on the line` : "Not checked in yet",
      tier: streak >= 3 ? "immediate" : "soon",
      daysUntil: 0, score: 0, href: "/dashboard/habits",
      action: { kind: "checkin", label: "Check in" },
    });
  }

  // ── §7 Documents & Expirations ─────────────────────────────────────────────
  {
    const snoozed = new Set(input.snoozedDocumentIds || []);
    const bestByDoc = new Map<string, { doc: any; du: number }>();
    for (const d of input.documents || []) {
      const id = d?.documentId || d?.id;
      if (!id) continue;
      // Snoozing is per RULE now that a record can carry several. Testing the
      // record id alone meant dismissing a passport also hid the licence.
      // The record id is still honoured so snoozes made before this keep working.
      if (snoozed.has(d?.ruleId) || snoozed.has(id)) continue;
      // Group by the RULE, not by the record it hangs off. `documentId` is the
      // source entity now, so a person carrying both a passport and a licence
      // expiring inside the window collapsed to whichever was nearer and the
      // other never appeared.
      const groupKey = d?.ruleId || id;
      const du = typeof d.daysUntil === "number" ? d.daysUntil : daysBetween(today, d.expirationDate);
      if (du == null || du > (config?.docsWithinDays ?? 30)) continue;
      const prev = bestByDoc.get(groupKey);
      if (!prev || du < prev.du) bestByDoc.set(groupKey, { doc: d, du });
    }
    for (const [groupKey, { doc, du }] of bestByDoc) {
      const id = doc?.documentId || doc?.id || groupKey;
      cand.documents.push({
        key: `doc:${groupKey}`,
        sourceKey: doc?.ruleId ? ruleClaimKey(doc.ruleId) : `document:${groupKey}`,
        kind: "document",
        title: doc.documentName || doc.name || doc.fieldName || "Document",
        reason: du < 0 ? `Expired ${Math.abs(du)}d ago` : du === 0 ? "Expires today" : `Expires ${dayLabel(du)}`,
        tier: du <= 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
        // Prefer the row's own link. An expiration can be carried by a
        // PROFILE (a passport typed onto a person) as well as by a document,
        // and `/documents/<profileId>` leads nowhere. The `#/` prefix is the
        // app-wide hash-route form these rows are built with elsewhere.
        daysUntil: du, score: 0,
        href: String(doc.href || "").replace(/^#/, "") || `/documents/${id}`,
        action: { kind: "open", label: "Review" },
      });
    }
  }

  // ── §4 Bills & Financial Obligations ───────────────────────────────────────
  let overdueBills = 0;
  for (const b of input.bills || []) {
    if (!b?.id) continue;
    const du = typeof b.daysUntil === "number" ? b.daysUntil : daysBetween(today, b.dueDate);
    if (du == null || du > (config?.billsWithinDays ?? 30)) continue;
    if (du < 0) overdueBills++;
    const amt = Number(b.amount) || 0;
    cand.bills.push({
      key: `bill:${b.id}`, sourceKey: `obligation:${b.id}`, kind: "bill",
      title: b.name || "Bill",
      reason: du < 0 ? `${money(amt)} overdue` : du === 0 ? `${money(amt)} due today` : `${money(amt)} due ${dayLabel(du)}`,
      tier: du <= 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
      daysUntil: du, amount: amt, score: 0, href: "/dashboard/obligations",
      action: b.autopay ? { kind: "open", label: "Open" } : { kind: "pay", label: "Pay" },
    });
  }

  // ── §2 Today's Agenda ──────────────────────────────────────────────────────
  // Everything actually scheduled today: events and tasks due today. Health and
  // birthdays have already claimed theirs.
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    if (String(e.date || "").slice(0, 10) !== today) continue;
    const past = !!e.time && String(e.time).slice(0, 5) < nowClock;
    cand.today.push({
      key: `event:${e.id}`, sourceKey: eventClaimKey(e), kind: "event",
      title: e.title || "Event",
      reason: e.allDay || !e.time ? "All day" : `${timeLabel(e.time)}${past ? " · passed" : ""}`,
      tier: past ? "soon" : "immediate",
      daysUntil: 0, score: 0, href: "/calendar",
      action: { kind: "open", label: "Open" },
    });
  }
  for (const t of input.tasks || []) {
    if (!t?.id || t.status === "done") continue;
    if (String(t.dueDate || "").slice(0, 10) !== today) continue;
    cand.today.push({
      key: `task:${t.id}`, sourceKey: `task:${t.id}`, kind: "task",
      title: t.title || "Task", reason: "Due today",
      tier: "immediate", daysUntil: 0, score: 0, href: "/dashboard/tasks",
      action: { kind: "complete", label: "Complete" },
    });
  }
  // ── §5 Upcoming · Next 7 Days ──────────────────────────────────────────────
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    const du = daysBetween(today, e.date);
    if (du == null || du < 1 || du > 7) continue;
    cand.upcoming.push({
      key: `event:${e.id}`, sourceKey: eventClaimKey(e), kind: "event",
      title: e.title || "Event",
      reason: [dayLabel(du), timeLabel(e.time)].filter(Boolean).join(" · "),
      tier: "soon", daysUntil: du, score: 0, href: "/calendar",
      action: { kind: "open", label: "Open" },
    });
  }
  for (const t of input.tasks || []) {
    if (!t?.id || t.status === "done") continue;
    const du = daysBetween(today, t.dueDate);
    if (du == null || du < 1 || du > 7) continue;
    cand.upcoming.push({
      key: `task:${t.id}`, sourceKey: `task:${t.id}`, kind: "task",
      title: t.title || "Task", reason: `Due ${dayLabel(du)}`,
      tier: "soon", daysUntil: du, score: 0, href: "/dashboard/tasks",
      action: { kind: "complete", label: "Complete" },
    });
  }
  for (const g of input.goals || []) {
    if (!g?.id) continue;
    const status = String(g.status || "").toLowerCase();
    if (status === "completed" || status === "abandoned") continue;
    const du = daysBetween(today, g.deadline);
    if (du == null || du < 0 || du > 7) continue;
    const pct = Number(g.target) > 0 ? ((Number(g.current) || 0) / Number(g.target)) * 100 : 0;
    cand.upcoming.push({
      key: `goal:${g.id}`, sourceKey: `goal:${g.id}`, kind: "goal",
      title: g.title || "Goal", reason: `Deadline ${dayLabel(du)} · ${Math.round(pct)}%`,
      tier: "soon", daysUntil: du, score: 0, href: "/goals",
      action: { kind: "open", label: "Open" },
    });
  }

  // ── §9 Recent Activity ─────────────────────────────────────────────────────
  for (const t of input.tasks || []) {
    if (!t?.id || t.status !== "done") continue;
    const when = String(t.completedAt || t.updatedAt || "");
    if (when.slice(0, 10) !== today) continue;
    cand.activity.push({
      key: `done:${t.id}`, sourceKey: `task:${t.id}`, kind: "task",
      title: t.title || "Task", reason: `Completed ${relTime(when) || "today"}`,
      tier: "upcoming", daysUntil: 0, score: 0, href: "/dashboard/tasks",
    });
  }
  // An activity row opens the surface the activity happened on. "/dashboard"
  // was a dead end — the user is already there when they tap the row.
  const ACTIVITY_HREF: Record<string, string> = {
    expense: "/dashboard/finance", income: "/dashboard/finance",
    task: "/dashboard/tasks", habit: "/dashboard/habits",
    document: "/linked?tab=documents", event: "/calendar",
    journal: "/dashboard/journal", tracker: "/trackers",
    obligation: "/dashboard/obligations", bill: "/dashboard/obligations",
    goal: "/goals", profile: "/profiles",
  };
  for (const a of input.recentActivity || []) {
    if (!a?.description) continue;
    cand.activity.push({
      key: `act:${a.id || a.timestamp || a.description}`,
      sourceKey: `activity:${a.id || a.timestamp || a.description}`,
      kind: "alert",
      title: a.description, reason: relTime(a.timestamp) || String(a.type || "activity"),
      tier: "upcoming", daysUntil: null, score: 0,
      href: ACTIVITY_HREF[String(a.type || "").toLowerCase()] || "/dashboard",
    });
  }

  // ── §10 Insights & Suggestions ─────────────────────────────────────────────
  for (const ins of input.insights || []) {
    if (!ins?.id || !ins.title) continue;
    // Key on the SUBJECT, not the observation. The insights engine derives its
    // own blood-pressure alert from the same latest entry the Health section
    // reads, and a `insight:<uuid>` key made those two invisible to each other
    // — the reading rendered twice, under two headings. Naming the tracker (or
    // document) the insight is about lets the claim loop collapse them, and
    // Health claims first.
    const subject =
      (ins.relatedEntityType === "tracker" || ins.relatedEntityType === "document")
        && ins.relatedEntityId
        ? `${ins.relatedEntityType}:${ins.relatedEntityId}`
        : `insight:${ins.id}`;
    cand.insights.push({
      key: `insight:${ins.id}`, sourceKey: subject, kind: "alert",
      title: ins.title, reason: ins.description || "",
      tier: ins.severity === "warning" || ins.severity === "negative" ? "soon" : "upcoming",
      daysUntil: null, score: 0,
      href: ins.relatedEntityType === "document" && ins.relatedEntityId
        ? `/documents/${ins.relatedEntityId}` : "/insights",
    });
  }

  // ── §11 AI Recommendations ─────────────────────────────────────────────────
  // Generated on demand, never on load. The rows are advice about the rest of
  // the tab rather than records of their own, so they carry no action and an
  // `airec:` key that nothing else can collide with.
  (input.recommendations || []).forEach((r: any, i: number) => {
    const title = String(r?.title || "").trim();
    if (!title) return;
    cand.recommendations.push({
      key: `airec:${i}`, sourceKey: `airec:${i}`, kind: "alert",
      title,
      reason: String(r?.body || r?.action || "").trim(),
      tier: r?.priority === "high" ? "soon" : "upcoming",
      daysUntil: null, score: 0, href: "/insights",
    });
  });

  // ── Claim: one record, one section ─────────────────────────────────────────
  const claimed = new Set<string>();
  const owned: Record<ExecSectionId, AttentionItem[]> = {
    immediate: [], today: [], habits: [], bills: [], upcoming: [],
    importantDates: [], documents: [], health: [], activity: [], insights: [],
    recommendations: [],
  };
  for (const id of SECTION_CLAIM_ORDER) {
    for (const item of cand[id]) {
      if (claimed.has(item.sourceKey)) continue;
      claimed.add(item.sourceKey);
      owned[id].push(item);
    }
  }

  // ── Assemble in display order ──────────────────────────────────────────────
  const out: ExecSection[] = [];
  for (const id of SECTION_DISPLAY_ORDER) {
    const all = owned[id];
    if (all.length === 0) continue;  // empty sections do not render
    // Soonest first inside a section; undated last.
    all.sort((a, b) => (a.daysUntil ?? 9e9) - (b.daysUntil ?? 9e9));
    const amount = all.reduce((sum, i) => sum + (i.amount || 0), 0);
    out.push({
      id,
      title: TITLES[id],
      accent: ACCENTS[id],
      // Every row, not the first DISPLAY_CAP: the UI collapses to DISPLAY_CAP
      // and "+N more" expands to the rest. See DISPLAY_CAP above.
      items: all,
      total: all.length,
      subtitle: subtitleFor(id, {
        habitsDue, habitsDone, overdueBills, immediate: owned.immediate,
        items: all, medsDue, abnormalReadings,
      }),
      // Birthdays is reference material right up until one lands inside the
      // week, at which point folding it away is the wrong call.
      emphasis: id === "importantDates" && all.some(i => (i.daysUntil ?? 99) <= 7)
        ? "working" : undefined,
      // Numbers the UI draws instead of writing out: a completion ring for the
      // day's habits, the money at stake for bills.
      //
      // Deliberately NOT set for Immediate Attention: that section mixes bills
      // with tasks, documents and alerts, so a headline figure summed from the
      // bills alone reads as the total for everything under it.
      progress: id === "habits" && habitsDue > 0 ? { done: habitsDone, total: habitsDue } : undefined,
      amount: id === "bills" && amount > 0 ? amount : undefined,
    });
  }
  return out;
}

/** Context lines that explain a section rather than repeat its rows. */
function subtitleFor(
  id: ExecSectionId,
  ctx: {
    habitsDue: number; habitsDone: number; overdueBills: number;
    immediate: AttentionItem[];
    /** The section's own claimed rows, for counts drawn from what actually renders. */
    items: AttentionItem[];
    medsDue: number; abnormalReadings: number;
  },
): string | undefined {
  if (id === "habits" && ctx.habitsDue > 0) {
    return `${ctx.habitsDone} of ${ctx.habitsDue} done today`;
  }
  // Birthdays keeps a long tail so nothing is a surprise, but the week is the
  // part that needs acting on — say how the list splits rather than making the
  // user read dates to find out.
  if (id === "importantDates") {
    const week = ctx.items.filter(i => (i.daysUntil ?? 99) <= 7).length;
    const rest = ctx.items.length - week;
    if (week > 0 && rest > 0) return `${week} this week · ${rest} more within 45 days`;
    if (week > 0) return `${week} this week`;
    if (rest > 0) return `${rest} within the next 45 days`;
  }
  if (id === "health") {
    const parts: string[] = [];
    if (ctx.medsDue > 0) parts.push(`${ctx.medsDue} dose${ctx.medsDue === 1 ? "" : "s"} due`);
    if (ctx.abnormalReadings > 0) {
      parts.push(`${ctx.abnormalReadings} reading${ctx.abnormalReadings === 1 ? "" : "s"} out of range`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  // Overdue bills and expired documents are claimed by Immediate Attention, so
  // say where they went — a Bills section silently missing the overdue ones
  // reads as a bug.
  if (id === "bills") {
    const n = ctx.immediate.filter(i => i.kind === "bill").length;
    if (n > 0) return `${n} overdue — see Immediate Attention`;
  }
  if (id === "documents") {
    const n = ctx.immediate.filter(i => i.kind === "document").length;
    if (n > 0) return `${n} already expired — see Immediate Attention`;
  }
  return undefined;
}
