// shared/now-rank.ts — the single ranking model behind the dashboard "Now Queue".
//
// Pure, dependency-free, and DOM/DB-free so the client (NowQueueSection) and any
// server-side briefing resolver consume the EXACT same scored list. This is the
// "one source of truth" the Dashboard v2 plan calls for: the Now Queue and the
// AI briefing rank the same entities the AI chat writes, so they can never
// contradict each other or the data on screen.
//
// score = Urgency (dominant) + Impact + Confidence. Higher = surfaces sooner.

export type NowKind = "task" | "bill" | "event" | "document" | "goal";
export type NowAction = "complete" | "pay" | "open";

export interface NowItem {
  /** Stable key for React. */
  key: string;
  /** Underlying entity id (for mutations / navigation). */
  sourceId: string;
  kind: NowKind;
  title: string;
  /** Why-it-matters chip, e.g. "$140 · due in 2d", "ID expires in 9d", "47d overdue". */
  detail: string;
  /** Negative = overdue, 0 = today, positive = days out. null = undated. */
  daysUntil: number | null;
  amount?: number;
  /** Primary affordance shown on the row. */
  action: NowAction;
  /** Navigation target (hash path, no leading '#'). */
  href: string;
  /** HSL accent string (no hsl() wrapper) for the row icon/treatment. */
  accent: string;
  score: number;
}

export interface NowInputs {
  now?: Date;
  /** enhanced.overdueTasks: [{ id, title, dueDate, priority }] */
  overdueTasks?: any[];
  /** enhanced.tasksDueSoon / enhanced.upcomingTasks: [{ id, title, dueDate, priority }] */
  dueSoonTasks?: any[];
  /** enhanced.financeSnapshot.upcomingBills: [{ id, name, amount, dueDate, daysUntil, autopay, category }] */
  bills?: any[];
  /** enhanced.expiringDocuments: [{ documentId, documentName, expirationDate, daysUntil, status }] */
  documents?: any[];
  /** /api/events rows: [{ id, title, date, time, category, location }] */
  events?: any[];
  /** /api/goals rows (GoalItem-shaped): [{ id, title, deadline, target, current, status }] */
  goals?: any[];
  /** How far ahead (days) an item may be and still count as "now". Default 30. */
  horizonDays?: number;
}

const ACCENT = {
  task: "262 70% 62%",
  bill: "43 85% 52%",
  event: "200 80% 55%",
  document: "205 90% 58%",
  goal: "155 60% 48%",
} as const;

function daysBetween(now: Date, dateStr: string | undefined | null): number | null {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).length <= 10 ? `${dateStr}T12:00:00` : dateStr);
  if (isNaN(d.getTime())) return null;
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(d); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Urgency curve — overdue dominates, then today, then a smooth decay outward.
//
// Exported so shared/attention.ts ranks on the SAME curve instead of growing a
// second one. Two urgency models that disagree is how the dashboard ended up
// with four sections that each thought something different was most urgent.
export function urgencyScore(daysUntil: number | null): number {
  if (daysUntil == null) return 120;            // undated but surfaced (e.g. a flagged item)
  if (daysUntil < 0) return 1000 + Math.min(365, -daysUntil); // overdue: older = higher
  if (daysUntil === 0) return 950;              // today
  if (daysUntil <= 2) return 820;
  if (daysUntil <= 7) return 640;
  if (daysUntil <= 14) return 440;
  if (daysUntil <= 30) return 260;
  return Math.max(40, 200 - daysUntil);
}

/**
 * "in 5d" / "today" / "29d overdue" — THE relative-due formatter.
 *
 * User report 2026-07-26, #16:
 *   "AI Executive Brief says: 'Lawn care ($40) due in -29d.' Past dates should
 *    say '29 days overdue', never 'due in -29d'."
 *
 * That string was built inline in ExecutiveBriefing, and four other screens had
 * their own copy of the same three lines — each one interpolating a raw
 * `daysUntil` that goes negative once a date passes. This function is the one
 * every caller now uses, so a past date reads as overdue everywhere at once.
 *
 * Exported because the bug was never in the logic here; it was in the four
 * places that never called it.
 */
export function dayLabel(daysUntil: number | null | undefined): string {
  if (daysUntil == null || !Number.isFinite(daysUntil)) return "";
  const d = Math.trunc(daysUntil);
  if (d < 0) return `${Math.abs(d)}d overdue`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
}

/** Same rule, phrased for a sentence: "due today", "due in 5d", "29d overdue". */
export function dueLabel(daysUntil: number | null | undefined): string {
  const label = dayLabel(daysUntil);
  if (!label) return "";
  return (daysUntil ?? 0) < 0 ? label : `due ${label}`;
}

// Documents whose expiry carries real consequence rank above a random receipt.
const CRITICAL_DOC = /(id|passport|licen|insur|registration|visa|permit|ssn|social|title|deed|will|medical|prescription)/i;

export function computeNowItems(input: NowInputs): NowItem[] {
  const now = input.now ?? new Date();
  const horizon = input.horizonDays ?? 30;
  const out: NowItem[] = [];

  // ── Tasks ──────────────────────────────────────────────────────────────
  const seenTask = new Set<string>();
  const pushTask = (t: any) => {
    if (!t || !t.id || seenTask.has(t.id)) return;
    seenTask.add(t.id);
    const du = daysBetween(now, t.dueDate);
    if (du != null && du > horizon) return;
    const impact = String(t.priority).toLowerCase() === "high" ? 120 : String(t.priority).toLowerCase() === "low" ? -20 : 30;
    out.push({
      key: `task:${t.id}`, sourceId: t.id, kind: "task",
      title: t.title || "Task",
      detail: du == null ? "no due date" : dayLabel(du),
      daysUntil: du, action: "complete", href: "/dashboard/tasks",
      accent: ACCENT.task, score: urgencyScore(du) + impact,
    });
  };
  (input.overdueTasks || []).forEach(pushTask);
  (input.dueSoonTasks || []).forEach(pushTask);

  // ── Bills ──────────────────────────────────────────────────────────────
  for (const b of input.bills || []) {
    if (!b || !b.id) continue;
    const du = typeof b.daysUntil === "number" ? b.daysUntil : daysBetween(now, b.dueDate);
    if (du != null && du > Math.min(horizon, 30)) continue; // bills: keep the next-30 window
    const amt = Number(b.amount) || 0;
    // Money at risk is real impact; autopay reduces urgency (it self-charges).
    const impact = Math.min(220, amt / 25) + (b.autopay ? -120 : 0);
    const dl = dayLabel(du);
    out.push({
      key: `bill:${b.id}`, sourceId: b.id, kind: "bill",
      title: b.name || "Bill",
      detail: [amt ? `$${Math.round(amt).toLocaleString()}` : null, dl].filter(Boolean).join(" · "),
      daysUntil: du, amount: amt,
      // Bills open their liability profile — the record that owns the payment.
      // (Bills list page deleted 2026-08; unlinked bills open Money's pop-up.)
      action: b.autopay ? "open" : "pay",
      href: b.linkedLiabilityId ? `/profiles/${b.linkedLiabilityId}` : "/finance?popup=bills",
      accent: ACCENT.bill, score: urgencyScore(du) + impact,
    });
  }

  // ── Documents (expiring) ────────────────────────────────────────────────
  for (const d of input.documents || []) {
    const id = d?.documentId || d?.id;
    if (!id) continue;
    const du = typeof d.daysUntil === "number" ? d.daysUntil : daysBetween(now, d.expirationDate);
    if (du != null && du > horizon) continue;
    const name = d.documentName || d.name || "Document";
    const critical = CRITICAL_DOC.test(`${name} ${d.documentType || ""} ${d.fieldName || ""}`);
    out.push({
      key: `doc:${id}:${d.fieldName || ""}`, sourceId: id, kind: "document",
      title: name,
      detail: `expires ${dayLabel(du)}`,
      daysUntil: du, action: "open", href: `/documents/${id}`,
      accent: ACCENT.document, score: urgencyScore(du) + (critical ? 160 : 20),
    });
  }

  // ── Events (next up) ────────────────────────────────────────────────────
  for (const e of input.events || []) {
    if (!e || !e.id) continue;
    const du = daysBetween(now, e.date || e.startDate);
    if (du == null || du < 0 || du > 7) continue; // only the immediate horizon for events
    out.push({
      key: `event:${e.id}`, sourceId: e.id, kind: "event",
      title: e.title || "Event",
      detail: [dayLabel(du), e.time || null].filter(Boolean).join(" · "),
      daysUntil: du, action: "open", href: "/calendar",
      accent: ACCENT.event, score: urgencyScore(du) + 40,
    });
  }

  // ── Goals (overdue / at-risk only) ──────────────────────────────────────
  for (const g of input.goals || []) {
    if (!g || !g.id) continue;
    const status = String(g.status || "").toLowerCase();
    if (status === "completed" || status === "abandoned") continue;
    const du = daysBetween(now, g.deadline);
    if (du == null) continue;
    const pct = Number(g.target) > 0 ? (Number(g.current) || 0) / Number(g.target) * 100 : 0;
    const overdue = du < 0 && pct < 100;
    const atRisk = du >= 0 && du <= 14 && pct < 50;
    if (!overdue && !atRisk) continue;
    out.push({
      key: `goal:${g.id}`, sourceId: g.id, kind: "goal",
      title: g.title || "Goal",
      detail: overdue ? `${Math.abs(du)}d overdue · ${Math.round(pct)}%` : `${dayLabel(du)} · ${Math.round(pct)}%`,
      daysUntil: du, action: "open", href: "/goals",
      accent: ACCENT.goal, score: urgencyScore(du) + (overdue ? 120 : 60),
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
