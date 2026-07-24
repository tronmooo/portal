// ── Briefing model — the ONE derivation behind the Executive tab ─────────────
// Before this module the Executive tab ran ~14 independent filters over the
// same 7 queries and rendered the overlaps: `upcomingTasks` was `!dueDate ||
// dueDate >= today`, an unbounded SUPERSET of both `agendaTasks` and
// `highPriority`, so a high-priority task due today drew in three sections at
// once; "Calendar · Next 14d" re-rendered Birthdays + Appointments + Important
// Dates wholesale; and the AI brief / Attention tile restated the tiles in
// prose and as a count.
//
// The fix is structural, not editorial. Every datum is normalized to a
// BriefingItem with a stable `key`, and buckets are assigned by a PRIORITY
// CASCADE: passes run attention → today → next14 → open → recent, and `push`
// refuses a key it has already seen. An item therefore lands in its
// highest-priority bucket and *cannot* appear in a second one. Adding a new
// section later cannot reintroduce double-rendering without deliberately
// bypassing `push`.
//
// Pure and React-free on purpose — tests/dashboard-dedup.test.ts drives it
// directly with fixtures.

export type BriefingKind =
  | "task" | "event" | "bill" | "doc" | "habit"
  | "reminder" | "goal" | "note" | "alert" | "activity";

/** The five surfaces of the Executive tab, in cascade priority order. */
export type BriefingBucket = "attention" | "today" | "next14" | "open" | "recent";

export type Severity = "critical" | "warning" | "info";

/** Popup panels a row can open. Mirrors popups/registry.ts PANEL_IDS. */
export type PanelId =
  | "tasks" | "habits" | "obligations" | "timeline"
  | "goals" | "notes" | "reminders" | "attention";

export interface BriefingItem {
  /** `${kind}:${id}` — the dedup identity. Unique across the whole model. */
  key: string;
  kind: BriefingKind;
  id: string;
  title: string;
  /** YYYY-MM-DD, or null for undated items (backlog tasks, notes). */
  date: string | null;
  /** HH:MM, or null. */
  time: string | null;
  severity: Severity;
  bucket: BriefingBucket;
  /** Left cell: "Today", "3d", "overdue", "✓ done". */
  when: string;
  /** Right cell: "$120", "high", "12🔥". */
  meta: string;
  /** Why it's in `attention` — only set for attention items. */
  reason?: string;
  /** Grouping label inside the attention list. */
  group: string;
  panel: PanelId;
  /** Optional sub-tab / focus target inside the panel. */
  sub?: string;
  /** Route to navigate to instead of opening a panel (notifications only). */
  navTo?: string;
  done?: boolean;
  amount?: number;
  tone?: "pos" | "neg" | "warn";
  raw?: any;
}

export interface BriefingTiles {
  today: { value: string; unit?: string; sub: string; pct: number };
  tasks: { value: string; unit?: string; sub: string };
  obligations: { value: string; unit?: string; sub: string; critical: boolean };
  habits: { value: string; unit?: string; sub: string };
}

export interface BriefingModel {
  items: BriefingItem[];
  buckets: Record<BriefingBucket, BriefingItem[]>;
  counts: Record<BriefingBucket, number>;
  tiles: BriefingTiles;
  /** True when any attention item is critical — drives the section accent. */
  hasCritical: boolean;
}

export interface BriefingInput {
  todayStr: string;
  nowMs: number;
  tasks: any[];
  habits: any[];
  /** /api/calendar/timeline — only `type: "event"` rows are consumed; task /
   *  habit / obligation rows are dropped because /api/tasks, /api/habits and
   *  the finance snapshot are authoritative for those and carry live state. */
  timeline: any[];
  reminders: any[];
  goals: any[];
  journal: any[];
  notifications: any[];
  /** enhanced.financeSnapshot.upcomingBills */
  bills: any[];
  /** enhanced.expiringDocuments, already snooze-filtered by the caller. */
  expiringDocs: any[];
  /** stats.recentActivity */
  activity: any[];
}

// ── Section caps. Anything past the cap is reachable via the panel. ──────────
export const BUCKET_CAPS: Record<BriefingBucket, number> = {
  attention: 20, today: 25, next14: 40, open: 20, recent: 12,
};

const DAY_MS = 86400000;

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

export function daysBetween(fromStr: string, toStr: string): number {
  return Math.round(
    (new Date(toStr + "T00:00:00").getTime() - new Date(fromStr + "T00:00:00").getTime()) / DAY_MS,
  );
}

/** "Today" / "Tomorrow" / "Friday" / "Mar 4" */
export function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return "Today";
  const diff = daysBetween(todayStr, dateStr);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" });
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const d10 = (v: any): string | null => {
  const s = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function docExpiryPhrase(d: number): string {
  if (d < 0) return d === -1 ? "expired yesterday" : `expired ${Math.abs(d)} days ago`;
  if (d === 0) return "expires today";
  if (d === 1) return "expires tomorrow";
  return `expires in ${d} days`;
}

const money = (n: any) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Build the whole Executive tab from the raw query results. */
export function buildBriefingModel(input: BriefingInput): BriefingModel {
  const { todayStr, nowMs } = input;
  const in14 = addDays(todayStr, 14);
  const nowClock = new Date(nowMs).toTimeString().slice(0, 5);

  const items: BriefingItem[] = [];
  const seen = new Set<string>();
  /** The dedup gate. First bucket to claim a key owns it — later passes lose. */
  const push = (item: Omit<BriefingItem, "key"> & { key: string }): boolean => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    items.push(item as BriefingItem);
    return true;
  };

  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const habits = Array.isArray(input.habits) ? input.habits : [];
  const timeline = Array.isArray(input.timeline) ? input.timeline : [];
  const reminders = Array.isArray(input.reminders) ? input.reminders : [];
  const goals = Array.isArray(input.goals) ? input.goals : [];
  const journal = Array.isArray(input.journal) ? input.journal : [];
  const notifications = Array.isArray(input.notifications) ? input.notifications : [];
  const bills = Array.isArray(input.bills) ? input.bills : [];
  const expiringDocs = Array.isArray(input.expiringDocs) ? input.expiringDocs : [];
  const activity = Array.isArray(input.activity) ? input.activity : [];

  // ── Normalized source rows ────────────────────────────────────────────────
  const pending = tasks.filter((t: any) => t.status !== "done");
  const doneToday = tasks.filter(
    (t: any) => t.status === "done" && d10(t.completedAt || t.updatedAt) === todayStr,
  ).length;
  const isHigh = (t: any) => ["high", "urgent"].includes(String(t.priority || "").toLowerCase());

  // Only `event` rows survive from the timeline — see BriefingInput.timeline.
  const events = timeline
    .filter((i: any) => i.type === "event" && d10(i.date) && d10(i.date)! >= todayStr)
    .sort((a: any, b: any) =>
      String(a.date).localeCompare(String(b.date)) || String(a.time || "").localeCompare(String(b.time || "")));

  const habitRows = habits.map((h: any) => ({
    id: String(h.id),
    name: h.name,
    doneToday: (h.checkins || []).some((c: any) => d10(c.date) === todayStr),
    streak: h.currentStreak ?? h.streak ?? 0,
  }));
  const habitsMissed = habitRows.filter((h) => !h.doneToday).length;
  const habitsDone = habitRows.length - habitsMissed;

  const activeReminders = reminders
    .filter((r: any) => !r.firedAt)
    .sort((a: any, b: any) => new Date(a.fireAt || 0).getTime() - new Date(b.fireAt || 0).getTime());

  const liveNotifs = notifications.filter((n: any) => !n.dismissed);
  const criticalNotifs = liveNotifs.filter((n: any) => n.severity === "critical");

  const activeGoals = goals.filter((g: any) => g.status === "active" || !g.status);

  const notifRoute = (n: any): string | undefined => {
    if (n.entityType === "document" && n.entityId) return `/documents/${n.entityId}`;
    if (n.entityType === "profile" && n.entityId) return `/profiles/${n.entityId}`;
    return undefined;
  };
  const notifPanel = (n: any): PanelId =>
    n.entityType === "task" ? "tasks" : n.entityType === "habit" ? "habits" : "timeline";

  // ══ PASS 1 — ATTENTION ═════════════════════════════════════════════════════
  // Late, imminent, or explicitly flagged. Absorbs the old Overdue, High
  // Priority, Notifications and AI Executive Brief sections plus the Attention
  // tile — all of which were views of this same union.
  for (const t of pending) {
    const due = d10(t.dueDate);
    if (!due || due >= todayStr) continue;
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: due, time: null, severity: "critical", bucket: "attention",
      when: "overdue", meta: String(t.priority || "—"),
      reason: `Overdue — was due ${dayLabel(due, todayStr)}`,
      group: "Overdue tasks", panel: "tasks", sub: "overdue", tone: "neg", raw: t,
    });
  }
  for (const b of bills) {
    const overdue = b.status === "overdue";
    const dueToday = !overdue && b.daysUntil === 0;
    if (!overdue && !dueToday) continue;
    push({
      key: `bill:${b.id}`, kind: "bill", id: String(b.id), title: b.name,
      date: d10(b.dueDate), time: null,
      severity: overdue ? "critical" : "warning", bucket: "attention",
      when: overdue ? "overdue" : "today", meta: money(b.amount),
      reason: `${money(b.amount)} ${overdue ? "overdue" : "due today"}`,
      group: "Bills requiring action", panel: "obligations", sub: "bills",
      amount: Number(b.amount) || 0, tone: "neg", raw: b,
    });
  }
  for (const doc of expiringDocs) {
    if (typeof doc.daysUntil !== "number" || doc.daysUntil > 30) continue;
    push({
      key: `doc:${doc.documentId || doc.id}`, kind: "doc",
      id: String(doc.documentId || doc.id),
      title: doc.documentName || doc.name || doc.fieldName || "Document",
      date: d10(doc.expirationDate), time: null,
      severity: doc.daysUntil < 0 ? "critical" : "warning", bucket: "attention",
      when: doc.daysUntil < 0 ? "expired" : `${doc.daysUntil}d`,
      meta: doc.daysUntil < 0 ? "expired" : `${doc.daysUntil}d`,
      reason: docExpiryPhrase(doc.daysUntil),
      group: "Expiring documents", panel: "obligations", sub: "docs",
      tone: doc.daysUntil <= 21 ? "neg" : "warn", raw: doc,
    });
  }
  for (const n of criticalNotifs) {
    push({
      key: `alert:${n.id}`, kind: "alert", id: String(n.id), title: n.title,
      date: null, time: null, severity: "critical", bucket: "attention",
      when: "⚠", meta: "", reason: "Critical notification",
      group: "Alerts", panel: notifPanel(n), navTo: notifRoute(n), tone: "neg", raw: n,
    });
  }
  for (const r of activeReminders) {
    if (!r.fireAt || new Date(r.fireAt).getTime() >= nowMs) continue;
    push({
      key: `reminder:${r.id}`, kind: "reminder", id: String(r.id),
      title: r.title || r.message || r.content || "Reminder",
      date: d10(r.fireAt), time: null, severity: "warning", bucket: "attention",
      when: "fired", meta: "", reason: "Fired — not dismissed",
      group: "Reminders", panel: "reminders", tone: "warn", raw: r,
    });
  }
  for (const g of activeGoals) {
    const target = d10(g.targetDate || g.dueDate);
    if (!target || target >= todayStr) continue;
    push({
      key: `goal:${g.id}`, kind: "goal", id: String(g.id), title: g.title,
      date: target, time: null, severity: "warning", bucket: "attention",
      when: "past due", meta: g.target ? `${Math.round(((g.current ?? 0) / g.target) * 100)}%` : "",
      reason: `Target date passed ${dayLabel(target, todayStr)}`,
      group: "Goals past target", panel: "goals", tone: "warn", raw: g,
    });
  }

  // ══ PASS 2 — TODAY ═════════════════════════════════════════════════════════
  // Everything scheduled for today that pass 1 did not already claim. Absorbs
  // the old Today's Agenda section AND the full-width Today strip.
  for (const e of events) {
    if (d10(e.date) !== todayStr) continue;
    push({
      key: `event:${e.sourceId || e.id}:${d10(e.date)}`, kind: "event",
      id: String(e.sourceId || e.id), title: e.title,
      date: todayStr, time: e.time || null, severity: "info", bucket: "today",
      when: e.time || (e.allDay ? "all day" : "today"), meta: e.category || "event",
      group: "Today", panel: "timeline", raw: e,
    });
  }
  for (const t of pending) {
    if (d10(t.dueDate) !== todayStr) continue;
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: todayStr, time: null,
      severity: isHigh(t) ? "warning" : "info", bucket: "today",
      when: "today", meta: String(t.priority || "—"),
      group: "Today", panel: "tasks", tone: isHigh(t) ? "warn" : undefined, raw: t,
    });
  }
  for (const h of habitRows) {
    push({
      key: `habit:${h.id}`, kind: "habit", id: h.id, title: h.name,
      date: todayStr, time: null, severity: "info", bucket: "today",
      when: h.doneToday ? "✓ done" : "✗ due", meta: `${h.streak}🔥`,
      group: "Habits", panel: "habits", done: h.doneToday,
      tone: h.doneToday ? "pos" : undefined, raw: h,
    });
  }
  for (const r of activeReminders) {
    const fire = r.fireAt ? new Date(r.fireAt) : null;
    if (!fire || isNaN(fire.getTime()) || fire.toLocaleDateString("en-CA") !== todayStr) continue;
    push({
      key: `reminder:${r.id}`, kind: "reminder", id: String(r.id),
      title: r.title || r.message || r.content || "Reminder",
      date: todayStr, time: fire.toTimeString().slice(0, 5),
      severity: "info", bucket: "today",
      when: fire.toTimeString().slice(0, 5), meta: "reminder",
      group: "Today", panel: "reminders", raw: r,
    });
  }

  // ══ PASS 3 — NEXT 14 DAYS ══════════════════════════════════════════════════
  // One dated timeline. Absorbs Calendar·14d, Birthdays, Appointments,
  // Important Dates and the non-urgent tail of Bills — the four regex splits
  // become filter chips over this one list instead of four sections.
  for (const e of events) {
    const date = d10(e.date)!;
    if (date <= todayStr || date > in14) continue;
    push({
      key: `event:${e.sourceId || e.id}:${date}`, kind: "event",
      id: String(e.sourceId || e.id), title: e.title,
      date, time: e.time || null, severity: "info", bucket: "next14",
      when: dayLabel(date, todayStr), meta: `${daysBetween(todayStr, date)}d`,
      group: "Upcoming", panel: "timeline", raw: e,
    });
  }
  for (const b of bills) {
    if (typeof b.daysUntil !== "number" || b.daysUntil <= 0 || b.daysUntil > 14) continue;
    push({
      key: `bill:${b.id}`, kind: "bill", id: String(b.id), title: b.name,
      date: d10(b.dueDate), time: null,
      severity: b.daysUntil <= 3 ? "warning" : "info", bucket: "next14",
      when: `${b.daysUntil}d`, meta: money(b.amount),
      group: "Bills", panel: "obligations", sub: "bills",
      amount: Number(b.amount) || 0, tone: b.daysUntil <= 3 ? "warn" : undefined, raw: b,
    });
  }
  for (const t of pending) {
    const due = d10(t.dueDate);
    if (!due || due <= todayStr || due > in14) continue;
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: due, time: null,
      severity: isHigh(t) ? "warning" : "info", bucket: "next14",
      when: dayLabel(due, todayStr), meta: String(t.priority || "—"),
      group: "Tasks", panel: "tasks", tone: isHigh(t) ? "warn" : undefined, raw: t,
    });
  }

  // ══ PASS 4 — OPEN WORK ═════════════════════════════════════════════════════
  // Undated or beyond the 14-day horizon. Absorbs Upcoming Tasks and Open
  // Projects.
  for (const t of pending) {
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: d10(t.dueDate), time: null,
      severity: isHigh(t) ? "warning" : "info", bucket: "open",
      when: d10(t.dueDate) ? dayLabel(d10(t.dueDate)!, todayStr) : "—",
      meta: String(t.priority || "—"),
      group: "Tasks", panel: "tasks", tone: isHigh(t) ? "warn" : undefined, raw: t,
    });
  }
  for (const g of activeGoals) {
    push({
      key: `goal:${g.id}`, kind: "goal", id: String(g.id), title: g.title,
      date: d10(g.targetDate || g.dueDate), time: null,
      severity: "info", bucket: "open", when: "goal",
      meta: g.target ? `${Math.round(((g.current ?? 0) / g.target) * 100)}%` : "",
      group: "Goals", panel: "goals", tone: "pos", raw: g,
    });
  }
  for (const e of events) {
    const date = d10(e.date)!;
    if (date <= in14) continue;
    push({
      key: `event:${e.sourceId || e.id}:${date}`, kind: "event",
      id: String(e.sourceId || e.id), title: e.title,
      date, time: e.time || null, severity: "info", bucket: "open",
      when: dayLabel(date, todayStr), meta: `${daysBetween(todayStr, date)}d`,
      group: "Later", panel: "timeline", raw: e,
    });
  }
  for (const doc of expiringDocs) {
    if (typeof doc.daysUntil === "number" && doc.daysUntil <= 30) continue;
    push({
      key: `doc:${doc.documentId || doc.id}`, kind: "doc",
      id: String(doc.documentId || doc.id),
      title: doc.documentName || doc.name || doc.fieldName || "Document",
      date: d10(doc.expirationDate), time: null, severity: "info", bucket: "open",
      when: typeof doc.daysUntil === "number" ? `${doc.daysUntil}d` : "—",
      meta: "document", group: "Documents", panel: "obligations", sub: "docs", raw: doc,
    });
  }

  // ══ PASS 5 — RECENT ════════════════════════════════════════════════════════
  for (const n of journal) {
    push({
      key: `note:${n.id}`, kind: "note", id: String(n.id),
      title: String(n.content || "").slice(0, 90),
      date: d10(n.date || n.createdAt), time: null, severity: "info", bucket: "recent",
      when: String(n.date || n.createdAt || "").slice(5, 10) || "note", meta: "",
      group: "Notes", panel: "notes", raw: n,
    });
  }
  for (const n of liveNotifs) {
    push({
      key: `alert:${n.id}`, kind: "alert", id: String(n.id), title: n.title,
      date: null, time: null, severity: "info", bucket: "recent",
      when: n.severity === "warning" ? "!" : "·", meta: "",
      group: "Notifications", panel: notifPanel(n), navTo: notifRoute(n),
      tone: n.severity === "warning" ? "warn" : undefined, raw: n,
    });
  }
  activity.forEach((a: any, i: number) => {
    push({
      key: `activity:${a.id ?? i}`, kind: "activity", id: String(a.id ?? i),
      title: a.description, date: null, time: null, severity: "info", bucket: "recent",
      when: "✓", meta: "", group: "Activity", panel: "notes", tone: "pos", raw: a,
    });
  });

  // ── Bucket + sort ─────────────────────────────────────────────────────────
  const buckets: Record<BriefingBucket, BriefingItem[]> = {
    attention: [], today: [], next14: [], open: [], recent: [],
  };
  for (const it of items) buckets[it.bucket].push(it);

  buckets.attention.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || String(a.date || "9999").localeCompare(String(b.date || "9999")));
  // Timed items first in chronological order, untimed after.
  buckets.today.sort((a, b) =>
    (a.time ? 0 : 1) - (b.time ? 0 : 1) || String(a.time || "").localeCompare(String(b.time || "")));
  buckets.next14.sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
    || String(a.time || "").localeCompare(String(b.time || "")));
  buckets.open.sort((a, b) =>
    String(a.date || "9999").localeCompare(String(b.date || "9999")));

  const counts = {
    attention: buckets.attention.length, today: buckets.today.length,
    next14: buckets.next14.length, open: buckets.open.length, recent: buckets.recent.length,
  };

  // ── Tiles. Counts and one headline only — tiles never list rows. ───────────
  const todayOpen = buckets.today.filter((i) => !i.done);
  const nextTimed = todayOpen.find((i) => i.time && i.time >= nowClock);
  const nextUp = nextTimed || todayOpen[0] || buckets.next14[0];
  const todayTotal = buckets.today.length + doneToday;
  const todayDoneCount = doneToday + habitsDone;
  const overdueCount = buckets.attention.filter((i) => i.kind === "task").length;
  const highCount = pending.filter(isHigh).length;

  const attnBills = buckets.attention.filter((i) => i.kind === "bill");
  const attnDocs = buckets.attention.filter((i) => i.kind === "doc");
  const soonBills = buckets.next14.filter((i) => i.kind === "bill");
  const billsTotal = [...attnBills, ...soonBills].reduce((s, i) => s + (i.amount || 0), 0);
  const obligationCount = attnBills.length + attnDocs.length + soonBills.length;
  const nextObligation = attnBills[0] || attnDocs[0] || soonBills[0];

  const tiles: BriefingTiles = {
    today: {
      value: String(todayOpen.length),
      unit: todayOpen.length === 1 ? "item left" : "items left",
      sub: nextUp
        ? `Next: ${nextUp.title}${nextUp.time ? ` · ${nextUp.time}` : ""}`
        : "Nothing scheduled today",
      pct: todayTotal > 0 ? Math.round((todayDoneCount / todayTotal) * 100) : 0,
    },
    tasks: {
      value: String(pending.length),
      unit: pending.length === 1 ? "open task" : "open tasks",
      sub: overdueCount || highCount
        ? `${overdueCount} overdue · ${highCount} high priority`
        : doneToday > 0 ? `${plural(doneToday, "task")} completed today` : "All clear",
    },
    obligations: {
      value: String(obligationCount),
      unit: obligationCount === 1 ? "needs action" : "need action",
      sub: nextObligation
        ? `${nextObligation.title} — ${nextObligation.reason || nextObligation.when}`
        : billsTotal > 0 ? `${money(billsTotal)} due in 14 days` : "Nothing due soon",
      critical: attnBills.some((i) => i.severity === "critical")
        || attnDocs.some((i) => i.severity === "critical"),
    },
    habits: {
      value: habitRows.length === 0 ? "—" : `${habitsDone} of ${habitRows.length}`,
      unit: habitRows.length === 0 ? undefined : "completed",
      sub: habitRows.length === 0 ? "No habits scheduled"
        : habitsMissed > 0 ? `${habitsMissed} remaining today` : "All done today",
    },
  };

  return {
    items, buckets, counts, tiles,
    hasCritical: buckets.attention.some((i) => i.severity === "critical"),
  };
}
