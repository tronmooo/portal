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
// genuinely on fire, then domain sections (health, birthdays, habits,
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
import { dayLabel } from "./now-rank";
import { isHabitDueOn, isHabitDoneOn } from "./habit-schedule";

export type ExecSectionId =
  | "immediate" | "today" | "habits" | "bills" | "upcoming"
  | "birthdays" | "documents" | "health" | "activity" | "insights";

export interface ExecSection {
  id: ExecSectionId;
  title: string;
  /** Context line under the title — progress, or where the rest went. */
  subtitle?: string;
  accent: string;
  items: AttentionItem[];
  /** Items before the display cap, so "+N more" can be honest. */
  total: number;
}

/** The order the user reads them in. */
export const SECTION_DISPLAY_ORDER: ExecSectionId[] = [
  "immediate", "today", "habits", "bills", "upcoming",
  "birthdays", "documents", "health", "activity", "insights",
];

/** The order they get to claim a record. Most specific first. */
const SECTION_CLAIM_ORDER: ExecSectionId[] = [
  "immediate", "health", "birthdays", "habits", "documents",
  "bills", "today", "upcoming", "activity", "insights",
];

const TITLES: Record<ExecSectionId, string> = {
  immediate: "Immediate Attention",
  today: "Today's Agenda",
  habits: "Habits Due Today",
  bills: "Bills & Financial Obligations",
  upcoming: "Upcoming · Next 7 Days",
  birthdays: "Birthdays & Anniversaries",
  documents: "Documents & Expirations",
  health: "Health",
  activity: "Recent Activity",
  insights: "Insights & Suggestions",
};

const ACCENTS: Record<ExecSectionId, string> = {
  immediate: "0 72% 58%",    // red
  today:     "199 89% 60%",  // sky
  habits:    "155 65% 45%",  // emerald
  bills:     "48 96% 53%",   // yellow
  upcoming:  "239 84% 67%",  // indigo
  birthdays: "330 80% 62%",  // pink
  documents: "205 90% 58%",  // blue
  health:    "350 85% 62%",  // rose
  activity:  "173 60% 44%",  // teal
  insights:  "280 75% 62%",  // purple
};

/** Rows past this per section collapse behind "+N more". */
const DISPLAY_CAP = 8;

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

/** Holidays sit with birthdays/anniversaries — annual, not actionable. */
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

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ExecSectionInputs extends AttentionInputs {
  /** stats.recentActivity rows: [{ type, description, timestamp }]. */
  recentActivity?: any[];
  /** /api/insights rows (shared/schema Insight). */
  insights?: any[];
}

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
    birthdays: [], documents: [], health: [], activity: [], insights: [],
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
  // Medications and refills come off the reminder rows (already collapsed per
  // series+day by the attention model, so a three-times-daily course is one
  // row); medical appointments come off the calendar.
  for (const item of attention.items) {
    if (item.kind === "reminder" && isHealthText(item.title)) cand.health.push(item);
  }
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    const du = daysBetween(today, e.date);
    if (du == null || du < 0 || du > 14) continue;
    if (!isHealthText(`${e.title || ""} ${e.category || ""}`)) continue;
    cand.health.push({
      key: `event:${e.id}`, sourceKey: `event:${e.sourceId || e.id}`, kind: "event",
      title: e.title || "Appointment",
      reason: [du === 0 ? "Today" : dayLabel(du), timeLabel(e.time)].filter(Boolean).join(" · "),
      tier: du === 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
      daysUntil: du, score: 0, href: "/calendar",
      action: { kind: "open", label: "Open" },
    });
  }

  // ── §6 Birthdays & Anniversaries ───────────────────────────────────────────
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    const du = daysBetween(today, e.date);
    if (du == null || du < 0 || du > 45) continue;
    if (!isBirthdayText(`${e.title || ""} ${e.category || ""}`)) continue;
    cand.birthdays.push({
      key: `event:${e.id}`, sourceKey: `event:${e.sourceId || e.id}`, kind: "event",
      title: e.title || "Occasion",
      reason: du === 0 ? "Today" : dayLabel(du),
      tier: du === 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
      daysUntil: du, score: 0, href: "/calendar",
      action: { kind: "open", label: "Open" },
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
    cand.habits.push({
      key: `habit:${h.id}`, sourceKey: `habit:${h.id}`, kind: "habit",
      title: h.name || "Habit",
      reason: streak >= 3 ? `${streak}-day streak on the line` : "Not checked in yet",
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
      if (!id || snoozed.has(id)) continue;
      const du = typeof d.daysUntil === "number" ? d.daysUntil : daysBetween(today, d.expirationDate);
      if (du == null || du > (config?.docsWithinDays ?? 30)) continue;
      const prev = bestByDoc.get(id);
      if (!prev || du < prev.du) bestByDoc.set(id, { doc: d, du });
    }
    for (const [id, { doc, du }] of bestByDoc) {
      cand.documents.push({
        key: `doc:${id}`, sourceKey: `document:${id}`, kind: "document",
        title: doc.documentName || doc.name || doc.fieldName || "Document",
        reason: du < 0 ? `Expired ${Math.abs(du)}d ago` : du === 0 ? "Expires today" : `Expires ${dayLabel(du)}`,
        tier: du <= 0 ? "immediate" : du <= 7 ? "soon" : "upcoming",
        daysUntil: du, score: 0, href: `/documents/${id}`,
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
  // Everything actually scheduled today: events, tasks due today, reminders due
  // today. Health and birthdays have already claimed theirs.
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    if (String(e.date || "").slice(0, 10) !== today) continue;
    const past = !!e.time && String(e.time).slice(0, 5) < nowClock;
    cand.today.push({
      key: `event:${e.id}`, sourceKey: `event:${e.sourceId || e.id}`, kind: "event",
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
  for (const item of attention.items) {
    if (item.kind === "reminder") cand.today.push(item);
  }

  // ── §5 Upcoming · Next 7 Days ──────────────────────────────────────────────
  for (const e of input.events || []) {
    if (!e?.id || (e.type && e.type !== "event")) continue;
    const du = daysBetween(today, e.date);
    if (du == null || du < 1 || du > 7) continue;
    cand.upcoming.push({
      key: `event:${e.id}`, sourceKey: `event:${e.sourceId || e.id}`, kind: "event",
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
  for (const a of input.recentActivity || []) {
    if (!a?.description) continue;
    cand.activity.push({
      key: `act:${a.id || a.timestamp || a.description}`,
      sourceKey: `activity:${a.id || a.timestamp || a.description}`,
      kind: "alert",
      title: a.description, reason: relTime(a.timestamp) || String(a.type || "activity"),
      tier: "upcoming", daysUntil: null, score: 0, href: "/dashboard",
    });
  }

  // ── §10 Insights & Suggestions ─────────────────────────────────────────────
  for (const ins of input.insights || []) {
    if (!ins?.id || !ins.title) continue;
    cand.insights.push({
      key: `insight:${ins.id}`, sourceKey: `insight:${ins.id}`, kind: "alert",
      title: ins.title, reason: ins.description || "",
      tier: ins.severity === "warning" || ins.severity === "negative" ? "soon" : "upcoming",
      daysUntil: null, score: 0,
      href: ins.relatedEntityType === "document" && ins.relatedEntityId
        ? `/documents/${ins.relatedEntityId}` : "/insights",
    });
  }

  // ── Claim: one record, one section ─────────────────────────────────────────
  const claimed = new Set<string>();
  const owned: Record<ExecSectionId, AttentionItem[]> = {
    immediate: [], today: [], habits: [], bills: [], upcoming: [],
    birthdays: [], documents: [], health: [], activity: [], insights: [],
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
    out.push({
      id,
      title: TITLES[id],
      accent: ACCENTS[id],
      items: all.slice(0, DISPLAY_CAP),
      total: all.length,
      subtitle: subtitleFor(id, { habitsDue, habitsDone, overdueBills, immediate: owned.immediate }),
    });
  }
  return out;
}

/** Context lines that explain a section rather than repeat its rows. */
function subtitleFor(
  id: ExecSectionId,
  ctx: { habitsDue: number; habitsDone: number; overdueBills: number; immediate: AttentionItem[] },
): string | undefined {
  if (id === "habits" && ctx.habitsDue > 0) {
    return `${ctx.habitsDone} of ${ctx.habitsDue} done today`;
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
