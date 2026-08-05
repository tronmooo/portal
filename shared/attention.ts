// shared/attention.ts — the one model behind the Executive tab's attention feed.
//
// The tab used to render 17 sections that each hand-rolled their own idea of
// urgency, so the same record could appear three times with three different
// labels. The worst case was structural: server/notification-service.ts
// SYNTHESIZES `task_overdue` / `bill_due` notifications from the very same
// tasks and obligations tables the other sections read, so every overdue task
// and bill was listed twice — once as itself, once as a "Critical notification".
//
// This module is the fix. It takes the entities the dashboard already fetches,
// collapses every representation of one record onto a single `sourceKey`,
// scores what survives, and drops anything that doesn't clear the bar. The
// contract is deliberately the same as shared/now-rank.ts: pure, no DOM, no DB,
// no imports beyond other shared modules — so it is trivially testable and the
// client and any future server resolver can never disagree.
//
// score = urgency (shared curve) + impact. Higher surfaces sooner.

import { dayLabel, urgencyScore } from "./now-rank";
import { isHabitDueOn, isHabitDoneOn, type HabitScheduleShape } from "./habit-schedule";

export type AttentionKind =
  | "task" | "bill" | "document" | "habit" | "reminder" | "event" | "goal" | "alert";

/** 🔴 now · 🟠 this week · 🟡 further out but consequential. */
export type AttentionTier = "immediate" | "soon" | "upcoming";

export type AttentionActionKind =
  // `taken` and `markdone` are deliberately distinct from `complete`, and from
  // each other: completing routes to PATCH /api/tasks/:id, a medication dose is
  // an obligation payment, and checking off one occurrence of a recurring date
  // is an edit to that event's tags. Same word to a user, three different writes.
  | "complete" | "pay" | "checkin" | "dismiss" | "snooze" | "open" | "taken" | "markdone";

export interface AttentionItem {
  /** Stable React key. */
  key: string;
  /**
   * `${entityType}:${entityId}` — the identity every representation of this
   * record collapses onto. Notifications carry entityType/entityId already
   * (notification-service.ts), so a derived alert lands on the same key as the
   * record it was derived from and loses the tie-break.
   */
  sourceKey: string;
  kind: AttentionKind;
  title: string;
  /** Why it's here, in the user's words: "$140 overdue", "expires in 9d". */
  reason: string;
  tier: AttentionTier;
  /** Negative = overdue, 0 = today, positive = days out, null = undated. */
  daysUntil: number | null;
  amount?: number;
  score: number;
  /** Route to the source record — never a dead end. */
  href: string;
  action?: { kind: AttentionActionKind; label: string };
  /** Rolled-up members (habits for the day, a medication's doses). */
  children?: AttentionItem[];
  /** Members represented by this row, including itself. */
  count?: number;
}

export interface AttentionConfig {
  /** Expiring documents further out than this never surface. */
  docsWithinDays: number;
  /** Bills further out than this never surface. */
  billsWithinDays: number;
  /** Non-overdue tasks further out than this never surface. */
  tasksWithinDays: number;
  /**
   * How long a fired-but-undismissed reminder stays actionable.
   *
   * Reminders never get stamped `fired_at` in production (the cron that would
   * do it is unreachable — see server/routes.ts cronFireDueReminders), and
   * listReminders has no lower bound on fire_at, so a reminder from June is
   * still "active" in July. Without this window the feed shows month-old
   * medication nags forever.
   */
  reminderStaleHours: number;
  includeTasks: boolean;
  includeHabits: boolean;
  includeReminders: boolean;
  includeEvents: boolean;
  includeBirthdays: boolean;
  /** Lowest tier allowed through. "upcoming" = show everything. */
  minTier: AttentionTier;
  /** In the 8–30d band, a bill under this amount isn't worth the real estate. */
  upcomingMinBillAmount: number;
}

export const DEFAULT_ATTENTION_CONFIG: AttentionConfig = {
  docsWithinDays: 30,
  billsWithinDays: 30,
  tasksWithinDays: 7,
  reminderStaleHours: 48,
  includeTasks: true,
  includeHabits: true,
  includeReminders: true,
  includeEvents: true,
  includeBirthdays: false,
  minTier: "upcoming",
  upcomingMinBillAmount: 100,
};

export interface AttentionInputs {
  /** User-local now. */
  now?: Date;
  /** User-local YYYY-MM-DD. Derived from `now` when omitted. */
  today?: string;
  /** /api/tasks rows. */
  tasks?: any[];
  /** enhanced.financeSnapshot.upcomingBills. */
  bills?: any[];
  /** enhanced.expiringDocuments. */
  documents?: any[];
  /** /api/habits rows (with `checkins`). */
  habits?: any[];
  /** /api/reminders rows. */
  reminders?: any[];
  /** /api/calendar/timeline items. */
  events?: any[];
  /** /api/goals rows. */
  goals?: any[];
  /** /api/notifications rows. */
  notifications?: any[];
  /** Ids from the `dismissed_notifications` preference. */
  dismissedNotificationIds?: string[];
  /** Document ids the user snoozed (client docSnooze map keys). */
  snoozedDocumentIds?: string[];
}

export interface AttentionResult {
  /** Ranked, deduped, above the bar. */
  items: AttentionItem[];
  /** Real items that exist but didn't clear the bar — powers "show N more". */
  suppressed: number;
  /**
   * Per-tier totals of `items`. Computed here rather than by the renderer:
   * the old headline summed arrays that had ALREADY been `.slice()`d per
   * group, so a user with 14 overdue tasks was told "10".
   */
  counts: Record<AttentionTier, number>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Titles that read as a birthday/anniversary rather than a commitment. */
export const BIRTHDAY_RE = /\b(birthday|bday|anniversary|b-day)\b/i;

/** Documents whose expiry carries real consequence (mirrors now-rank). */
const CRITICAL_DOC =
  /(id|passport|licen|insur|registration|visa|permit|ssn|social|title|deed|will|medical|prescription)/i;

function localDateOf(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

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

/**
 * Collapse the variants one reminder series gets written under.
 *
 * The AI expands a recurrence into N independent rows and picks the title
 * freely each turn, so a single amoxicillin course exists as "Take Amoxicillin
 * 500mg", "…(Morning Dose)" and "…(Evening Dose)" — three parallel series that
 * the exact-title dedupe never merged. Stripping a trailing dose/time
 * parenthetical puts them back together.
 */
export function normalizeReminderTitle(raw: string): string {
  return stripDoseQualifier(raw).toLowerCase().replace(/\s+/g, " ");
}

/** The same strip, but keeping the author's capitalisation — for display.
 *  Grouping needs a lowercased key; the row still has to read "Take
 *  Amoxicillin 500mg", not "Take amoxicillin 500mg". */
export function stripDoseQualifier(raw: string): string {
  return String(raw || "")
    .replace(/\s*\((?:[^)]*\b(?:dose|dosage|morning|afternoon|evening|night|bedtime|am|pm)\b[^)]*)\)\s*$/i, "")
    .trim();
}

function tierOf(daysUntil: number | null): AttentionTier {
  if (daysUntil == null) return "soon";
  if (daysUntil <= 0) return "immediate";
  if (daysUntil <= 7) return "soon";
  return "upcoming";
}

const TIER_RANK: Record<AttentionTier, number> = { immediate: 0, soon: 1, upcoming: 2 };

// ── The model ────────────────────────────────────────────────────────────────

export function computeAttention(
  input: AttentionInputs,
  config?: Partial<AttentionConfig>,
): AttentionResult {
  const cfg: AttentionConfig = { ...DEFAULT_ATTENTION_CONFIG, ...(config || {}) };
  const now = input.now ?? new Date();
  const today = input.today || localDateOf(now);
  const nowMs = now.getTime();
  const nowClock = now.toTimeString().slice(0, 5);

  const built: AttentionItem[] = [];
  // Entities claim their key first; a derived notification for the same record
  // arrives later and is dropped. See the notifications pass at the bottom.
  const claimed = new Set<string>();

  const claim = (item: AttentionItem) => {
    if (claimed.has(item.sourceKey)) return;
    claimed.add(item.sourceKey);
    built.push(item);
  };

  // ── Tasks ──────────────────────────────────────────────────────────────────
  if (cfg.includeTasks) {
    for (const t of input.tasks || []) {
      if (!t?.id || t.status === "done") continue;
      const du = daysBetween(today, t.dueDate);
      // Undated tasks are a backlog, not an alert — they'd never stop showing.
      if (du == null) continue;
      if (du > cfg.tasksWithinDays) continue;
      const prio = String(t.priority || "").toLowerCase();
      const impact = prio === "high" || prio === "urgent" ? 120 : prio === "low" ? -20 : 30;
      claim({
        key: `task:${t.id}`,
        sourceKey: `task:${t.id}`,
        kind: "task",
        title: t.title || "Task",
        reason: du < 0 ? dayLabel(du) : du === 0 ? "Due today" : `Due ${dayLabel(du)}`,
        tier: tierOf(du),
        daysUntil: du,
        score: urgencyScore(du) + impact,
        href: "/dashboard/tasks",
        action: { kind: "complete", label: "Complete" },
      });
    }
  }

  // ── Bills ──────────────────────────────────────────────────────────────────
  for (const b of input.bills || []) {
    if (!b?.id) continue;
    const du = typeof b.daysUntil === "number" ? b.daysUntil : daysBetween(today, b.dueDate);
    if (du == null || du > cfg.billsWithinDays) continue;
    const amt = Number(b.amount) || 0;
    // Money at risk is real impact; autopay collects itself, so it's a notice.
    const impact = Math.min(220, amt / 25) + (b.autopay ? -120 : 0);
    claim({
      // Notifications call this entity an "obligation" — match them, or the
      // "Overdue bill: Electric bill" alert lands on a different key and the
      // bill shows up twice. This one mapping is most of the duplication fix.
      key: `bill:${b.id}`,
      sourceKey: `obligation:${b.id}`,
      kind: "bill",
      title: b.name || "Bill",
      reason: du < 0
        ? `${money(amt)} overdue`
        : du === 0 ? `${money(amt)} due today` : `${money(amt)} due ${dayLabel(du)}`,
      tier: tierOf(du),
      daysUntil: du,
      amount: amt,
      score: urgencyScore(du) + impact,
      href: "/dashboard/obligations",
      action: b.autopay ? { kind: "open", label: "Open" } : { kind: "pay", label: "Pay" },
    });
  }

  // ── Expiring documents ─────────────────────────────────────────────────────
  // One row per DOCUMENT, not per expiring field: a card with both an
  // expiration_date and a valid_until is still one thing to go renew.
  {
    const snoozed = new Set(input.snoozedDocumentIds || []);
    const bestByDoc = new Map<string, { doc: any; du: number }>();
    for (const d of input.documents || []) {
      const id = d?.documentId || d?.id;
      if (!id || snoozed.has(id)) continue;
      const du = typeof d.daysUntil === "number" ? d.daysUntil : daysBetween(today, d.expirationDate);
      if (du == null || du > cfg.docsWithinDays) continue;
      const prev = bestByDoc.get(id);
      if (!prev || du < prev.du) bestByDoc.set(id, { doc: d, du });
    }
    for (const [id, { doc, du }] of bestByDoc) {
      const name = doc.documentName || doc.name || doc.fieldName || "Document";
      const critical = CRITICAL_DOC.test(`${name} ${doc.documentType || ""} ${doc.fieldName || ""}`);
      claim({
        key: `doc:${id}`,
        sourceKey: `document:${id}`,
        kind: "document",
        title: name,
        reason: du < 0
          ? (du === -1 ? "Expired yesterday" : `Expired ${Math.abs(du)} days ago`)
          : du === 0 ? "Expires today" : `Expires ${dayLabel(du)}`,
        tier: tierOf(du),
        daysUntil: du,
        score: urgencyScore(du) + (critical ? 160 : 20),
        href: `/documents/${id}`,
        action: { kind: "open", label: "Review" },
      });
    }
  }

  // ── Habits ─────────────────────────────────────────────────────────────────
  // Seven "not checked in yet" rows every morning would bury an overdue bill,
  // so the routine ones ride in a single roll-up. A habit whose streak is on
  // the line is a different proposition and gets promoted to its own row.
  if (cfg.includeHabits) {
    const outstanding: any[] = [];
    for (const h of input.habits || []) {
      if (!h?.id) continue;
      const habit = h as HabitScheduleShape;
      if (!isHabitDueOn(habit, today)) continue;   // weekly habits stop nagging daily
      if (isHabitDoneOn(habit, today)) continue;
      outstanding.push(h);
    }
    const atRisk = outstanding.filter((h) => Number(h.currentStreak ?? h.streak ?? 0) >= 3);
    const routine = outstanding.filter((h) => !atRisk.includes(h));

    for (const h of atRisk) {
      const streak = Number(h.currentStreak ?? h.streak ?? 0);
      claim({
        key: `habit:${h.id}`,
        sourceKey: `habit:${h.id}`,
        kind: "habit",
        title: h.name || "Habit",
        reason: `${streak}-day streak breaks today`,
        tier: "immediate",
        daysUntil: 0,
        score: urgencyScore(0) + 140,
        href: "/dashboard/habits",
        action: { kind: "checkin", label: "Check in" },
      });
    }

    if (routine.length > 0) {
      const children: AttentionItem[] = routine.map((h) => ({
        key: `habit:${h.id}`,
        sourceKey: `habit:${h.id}`,
        kind: "habit" as const,
        title: h.name || "Habit",
        reason: "Not checked in yet",
        tier: "soon" as const,
        daysUntil: 0,
        score: urgencyScore(0),
        href: "/dashboard/habits",
        action: { kind: "checkin" as const, label: "Check in" },
      }));
      for (const c of children) claimed.add(c.sourceKey);
      built.push({
        key: "habits:today",
        sourceKey: "habits:today",
        kind: "habit",
        title: routine.length === 1 ? routine[0].name : `${routine.length} habits still due today`,
        reason: routine.length === 1 ? "Not checked in yet" : "Not checked in yet",
        tier: "soon",
        daysUntil: 0,
        // Deliberately below a real deadline: habits are recoverable, an
        // expired licence is not.
        score: urgencyScore(0) - 200,
        href: "/dashboard/habits",
        action: routine.length === 1 ? { kind: "checkin", label: "Check in" } : undefined,
        children,
        count: routine.length,
      });
    }
  }

  // ── Reminders ──────────────────────────────────────────────────────────────
  // Windowed (see reminderStaleHours) and collapsed per series+day, so a
  // three-times-daily course is one row instead of three, and June's reminders
  // stop being presented as live in July.
  if (cfg.includeReminders) {
    const floor = nowMs - cfg.reminderStaleHours * 3600_000;
    const ceiling = nowMs + 24 * 3600_000;
    const groups = new Map<string, { rows: any[]; fireMs: number }>();
    for (const r of input.reminders || []) {
      if (!r?.id || r.firedAt) continue;
      const raw = r.title || r.message || r.content || "";
      const fireMs = r.fireAt ? new Date(r.fireAt).getTime() : NaN;
      if (isNaN(fireMs) || fireMs < floor || fireMs > ceiling) continue;
      const key = `${normalizeReminderTitle(raw)}@${localDateOf(new Date(fireMs))}`;
      const g = groups.get(key);
      if (g) { g.rows.push(r); g.fireMs = Math.min(g.fireMs, fireMs); }
      else groups.set(key, { rows: [r], fireMs });
    }
    for (const { rows, fireMs } of groups.values()) {
      const lead = rows[0];
      const display = lead.title || lead.message || lead.content || "Reminder";
      const overdue = fireMs < nowMs;
      const children = rows.length > 1
        ? rows.map((r: any) => ({
            key: `reminder:${r.id}`,
            sourceKey: `reminder:${r.id}`,
            kind: "reminder" as const,
            title: r.title || r.message || r.content || "Reminder",
            reason: new Date(r.fireAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
            tier: "immediate" as const,
            daysUntil: 0,
            score: urgencyScore(0),
            href: "/calendar",
            action: { kind: "dismiss" as const, label: "Done" },
          }))
        : undefined;
      for (const r of rows) claimed.add(`reminder:${r.id}`);
      built.push({
        key: `reminder:${lead.id}`,
        sourceKey: `reminder:${lead.id}`,
        kind: "reminder",
        title: rows.length > 1 ? stripDoseQualifier(display) : display,
        reason: rows.length > 1
          ? `${rows.length} doses today`
          : overdue ? "Was due — not dismissed" : "Due today",
        tier: "immediate",
        daysUntil: 0,
        score: urgencyScore(0) + 60,
        href: "/calendar",
        action: { kind: "dismiss", label: "Done" },
        children,
        count: rows.length,
      });
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  // Only what's still ahead of you today. The Calendar owns the schedule; a
  // meeting you've already had is not attention.
  if (cfg.includeEvents) {
    // Recurrence is expanded into one timeline row per occurrence, so collapse
    // a series onto its sourceId before picking.
    const seenSeries = new Set<string>();
    for (const e of input.events || []) {
      if (!e?.id || (e.type && e.type !== "event")) continue;
      const date = String(e.date || "").slice(0, 10);
      if (date !== today) continue;
      const isBirthday = BIRTHDAY_RE.test(`${e.title || ""} ${e.category || ""}`);
      if (isBirthday && !cfg.includeBirthdays) continue;
      // All-day rows have no "still ahead" to speak of; timed ones must not
      // have started yet.
      if (!isBirthday) {
        if (!e.time || e.allDay) continue;
        if (String(e.time).slice(0, 5) < nowClock) continue;
      }
      const series = String(e.sourceId || e.id);
      if (seenSeries.has(series)) continue;
      seenSeries.add(series);
      claim({
        key: `event:${e.id}`,
        sourceKey: `event:${series}`,
        kind: "event",
        title: e.title || "Event",
        reason: isBirthday ? "Today" : `At ${e.time}`,
        tier: "immediate",
        daysUntil: 0,
        score: urgencyScore(0) + 40,
        href: "/calendar",
        action: { kind: "open", label: "Open" },
      });
    }
  }

  // ── Goals (overdue / at-risk only) ─────────────────────────────────────────
  for (const g of input.goals || []) {
    if (!g?.id) continue;
    const status = String(g.status || "").toLowerCase();
    if (status === "completed" || status === "abandoned") continue;
    const du = daysBetween(today, g.deadline);
    if (du == null) continue;
    const pct = Number(g.target) > 0 ? ((Number(g.current) || 0) / Number(g.target)) * 100 : 0;
    const overdue = du < 0 && pct < 100;
    const atRisk = du >= 0 && du <= 14 && pct < 50;
    if (!overdue && !atRisk) continue;
    claim({
      key: `goal:${g.id}`,
      sourceKey: `goal:${g.id}`,
      kind: "goal",
      title: g.title || "Goal",
      reason: overdue ? `${Math.abs(du)}d overdue · ${Math.round(pct)}%` : `Due ${dayLabel(du)} · ${Math.round(pct)}%`,
      tier: tierOf(du),
      daysUntil: du,
      score: urgencyScore(du) + (overdue ? 120 : 60),
      href: "/goals",
      action: { kind: "open", label: "Open" },
    });
  }

  // ── Notifications, LAST ────────────────────────────────────────────────────
  // Everything above has already claimed its key, so a notification derived
  // from one of those records is dropped here. What survives is what has no
  // other representation on this surface: custom/AI-raised items, profile-field
  // expirations (notification-service scans profile.fields, nothing else does),
  // and streak milestones.
  {
    const dismissed = new Set(input.dismissedNotificationIds || []);
    for (const n of input.notifications || []) {
      if (!n?.id || n.dismissed || dismissed.has(n.id)) continue;
      if (n.severity === "info") continue;   // info is bell material, not attention
      const sourceKey = n.entityType && n.entityId
        ? `${n.entityType}:${n.entityId}`
        : `notification:${n.id}`;
      if (claimed.has(sourceKey)) continue;  // ← the duplication fix
      const du = daysBetween(today, n.dueDate);
      const critical = n.severity === "critical";
      claim({
        key: `alert:${n.id}`,
        sourceKey,
        kind: "alert",
        title: n.title || "Alert",
        reason: n.message || (critical ? "Needs attention" : "Review"),
        tier: critical ? "immediate" : tierOf(du),
        daysUntil: du,
        score: urgencyScore(du) + (critical ? 100 : 40),
        href: n.entityType === "document" && n.entityId ? `/documents/${n.entityId}`
          : n.entityType === "profile" && n.entityId ? `/profiles/${n.entityId}`
          : n.entityType === "task" ? "/dashboard/tasks"
          : n.entityType === "habit" ? "/dashboard/habits"
          : n.entityType === "obligation" ? "/dashboard/obligations"
          : "/calendar",
        action: { kind: "dismiss", label: "Dismiss" },
      });
    }
  }

  // ── Threshold + rank ───────────────────────────────────────────────────────
  const minRank = TIER_RANK[cfg.minTier];
  const kept: AttentionItem[] = [];
  let suppressed = 0;
  for (const item of built) {
    if (TIER_RANK[item.tier] > minRank) { suppressed++; continue; }
    // The 8–30d band is where clutter lives: only things that actually cost
    // something if missed earn a slot that far out.
    if (item.tier === "upcoming" && !earnsUpcomingSlot(item, cfg)) { suppressed++; continue; }
    kept.push(item);
  }
  kept.sort((a, b) => b.score - a.score);

  const counts: Record<AttentionTier, number> = { immediate: 0, soon: 0, upcoming: 0 };
  for (const i of kept) counts[i.tier]++;

  return { items: kept, suppressed, counts };
}

/** Is this worth showing 8–30 days out, or is it just noise with a date? */
function earnsUpcomingSlot(item: AttentionItem, cfg: AttentionConfig): boolean {
  switch (item.kind) {
    case "document":
      // A passport matters a month out; a warranty card does not.
      return CRITICAL_DOC.test(item.title);
    case "bill":
      return (item.amount ?? 0) >= cfg.upcomingMinBillAmount;
    case "task":
      // High priority is the only reason a task that far out is "attention".
      return item.score >= urgencyScore(item.daysUntil) + 100;
    case "goal":
    case "alert":
      return true;
    default:
      return false;
  }
}
