// ── Briefing model — the ONE derivation behind the Executive tab ─────────────
// Eight blocks (2026-07-25 spec), six of which are item lists produced here.
// Blocks 1 (Pulse) and 8 (Quick Capture) are aggregates/inputs, not lists.
//
// The mechanism that keeps a datum from rendering twice is unchanged and is the
// point of this module: everything is normalized to a BriefingItem keyed
// `${kind}:${id}`, then buckets are assigned by a PRIORITY CASCADE run against
// one shared `push` that refuses a key it has already seen. Passes run
//
//    attention → today → next14 → money → habits → projects
//
// so an item lands in its highest-priority block and *cannot* appear in a
// second. Moving a rule between passes moves the row between blocks; it never
// duplicates it.
//
// TWO PLACES THE SPEC OVERLAPS ITSELF, and how they are resolved:
//
//  1. "habits due" is listed under both Needs Attention (#2) and Today (#3).
//     Habits live in TODAY. They are a routine, not something late, and #2 is
//     "the only red on screen" — filling it with unchecked habits every morning
//     is precisely the noise this redesign removes. Today's progress bar also
//     needs them, which #3 explicitly asks for.
//  2. Habits are listed under both Today (#3) and Habits & Trackers (#6).
//     The habit ROWS live in Today (tap to check off). #6 carries streak chips,
//     which are aggregates over the same habits rather than copies of the rows,
//     plus trackers — a different entity, and the actual "let me log something"
//     surface that was missing.
//
// Pure and React-free on purpose — tests/dashboard-dedup.test.ts drives it
// directly with fixtures.

export type BriefingKind =
  | "task" | "event" | "bill" | "doc" | "habit"
  | "reminder" | "goal" | "tracker";

/** The six item-bearing blocks, in cascade priority order. */
export type BriefingBucket = "attention" | "today" | "next14" | "money" | "habits" | "projects";

export type Severity = "critical" | "warning" | "info";

/** Popup panels a row can open. Mirrors popups/registry.ts PANEL_IDS. */
export type PanelId =
  | "tasks" | "habits" | "obligations" | "timeline"
  | "goals" | "notes" | "reminders" | "attention"
  | "networth" | "cashflow" | "budget";

export interface BriefingItem {
  /** `${kind}:${id}` — the dedup identity. Unique across the whole model. */
  key: string;
  kind: BriefingKind;
  id: string;
  title: string;
  /** YYYY-MM-DD, or null for undated items. */
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
  /** Grouping label inside a block. */
  group: string;
  panel: PanelId;
  /** Optional sub-tab / focus target inside the panel. */
  sub?: string;
  done?: boolean;
  amount?: number;
  tone?: "pos" | "neg" | "warn";
  raw?: any;
}

/** Block 1 — the sticky strip. Four numbers, always visible. */
export interface PulseModel {
  netWorth: number;
  netWorthSub: string;
  cashFlow: number;
  cashFlowSub: string;
  /** Today's habit completion — concrete, not an invented composite score. */
  wellness: string;
  wellnessSub: string;
  /** Best active streak in days. */
  streak: number;
  streakSub: string;
}

/** Block 5 — near-term money view, not a Finance tab replacement. */
export interface MoneyModel {
  billsDue: BriefingItem[];
  billsTotal: number;
  monthlyIn: number;
  monthlyOut: number;
  cashFlow: number;
  assets: number;
  liabilities: number;
  /** "You own $412k against $180k owed." */
  balanceLine: string;
}

/** Block 6 — streaks (aggregates) + trackers (one-tap logging). */
export interface HabitsModel {
  /** Aggregate chips, NOT copies of the habit rows rendered in Today. */
  streaks: Array<{ id: string; name: string; days: number; doneToday: boolean }>;
  trackers: BriefingItem[];
  doneToday: number;
  total: number;
}

export interface BriefingModel {
  items: BriefingItem[];
  buckets: Record<BriefingBucket, BriefingItem[]>;
  counts: Record<BriefingBucket, number>;
  pulse: PulseModel;
  money: MoneyModel;
  habits: HabitsModel;
  /** Block 3's single synthesis line — what the standalone AI brief collapses to. */
  synthesis: string;
  /** Today's completion, for the progress bar in block 3. */
  todayPct: number;
  todayDone: number;
  todayTotal: number;
  hasCritical: boolean;
  /** Blocks that hide at zero and are currently empty — the "All clear" line. */
  allClear: string[];
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
  trackers: any[];
  /** enhanced.financeSnapshot.upcomingBills */
  bills: any[];
  /** enhanced.expiringDocuments, already snooze-filtered by the caller. */
  expiringDocs: any[];
  /** Aggregates for Pulse + Money. */
  finance: {
    assets: number;
    liabilities: number;
    monthlyIncome: number;
    monthlySpend: number;
    monthlyObligations: number;
  };
  /** stats.streaks / stats.journalStreak for the Pulse streak number. */
  streaks: Array<{ name: string; days: number }>;
  journalStreak: number;
}

/** Per-block render caps. Anything past the cap is reachable via the panel. */
export const BUCKET_CAPS: Record<BriefingBucket, number> = {
  attention: 12, today: 20, next14: 40, money: 8, habits: 8, projects: 8,
};

/** Blocks that disappear entirely when empty (spec render rule). */
export const HIDES_AT_ZERO: BriefingBucket[] = ["attention", "money", "habits", "projects"];

export const BLOCK_LABELS: Record<BriefingBucket, string> = {
  attention: "Needs Attention", today: "Today", next14: "Next 14 Days",
  money: "Money", habits: "Habits & Trackers", projects: "Open Projects",
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

const money = (n: any) => {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${v < 0 ? "-" : ""}$${Math.round(abs / 1000)}k`;
  return `${v < 0 ? "-" : ""}$${abs.toLocaleString()}`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Build the whole Executive tab from the raw query results. */
export function buildBriefingModel(input: BriefingInput): BriefingModel {
  const { todayStr, nowMs } = input;
  const in14 = addDays(todayStr, 14);
  const nowClock = new Date(nowMs).toTimeString().slice(0, 5);

  const items: BriefingItem[] = [];
  const seen = new Set<string>();
  /** The dedup gate. First bucket to claim a key owns it — later passes lose. */
  const push = (item: BriefingItem): boolean => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    items.push(item);
    return true;
  };

  const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
  const tasks = arr(input.tasks);
  const habits = arr(input.habits);
  const timeline = arr(input.timeline);
  const reminders = arr(input.reminders);
  const goals = arr(input.goals);
  const trackers = arr(input.trackers);
  const bills = arr(input.bills);
  const expiringDocs = arr(input.expiringDocs);
  const fin = input.finance || { assets: 0, liabilities: 0, monthlyIncome: 0, monthlySpend: 0, monthlyObligations: 0 };

  // ── Normalized source rows ────────────────────────────────────────────────
  const pending = tasks.filter((t: any) => t.status !== "done");
  const doneTodayCount = tasks.filter(
    (t: any) => t.status === "done" && d10(t.completedAt || t.updatedAt) === todayStr,
  ).length;
  const isHigh = (t: any) => ["high", "urgent"].includes(String(t.priority || "").toLowerCase());

  // Only `event` rows survive from the timeline — see BriefingInput.timeline.
  const events = timeline
    .filter((i: any) => i.type === "event" && d10(i.date) && d10(i.date)! >= todayStr)
    .sort((a: any, b: any) =>
      String(a.date).localeCompare(String(b.date)) || String(a.time || "").localeCompare(String(b.time || "")));

  const habitRows = habits
    .filter((h: any) => !h.archivedAt)
    .map((h: any) => ({
      id: String(h.id),
      name: h.name,
      // A habit with targetPerDay > 1 ("3× daily") is only done once it has
      // that many check-ins today — one tap must not read as complete.
      doneToday: arr(h.checkins).filter((c: any) => d10(c.date) === todayStr).length
        >= Math.max(1, Number(h.targetPerDay) || 1),
      streak: h.currentStreak ?? h.streak ?? 0,
      raw: h,
    }));
  const habitsMissed = habitRows.filter((h) => !h.doneToday).length;
  const habitsDone = habitRows.length - habitsMissed;

  const activeReminders = reminders
    .filter((r: any) => !r.firedAt)
    .sort((a: any, b: any) => new Date(a.fireAt || 0).getTime() - new Date(b.fireAt || 0).getTime());

  const activeGoals = goals.filter((g: any) => g.status === "active" || !g.status);

  // ══ PASS 1 — NEEDS ATTENTION (block 2) ═════════════════════════════════════
  // "The only red on screen. Hides at zero." Overdue + high priority +
  // documents expiring + bills past due. Habits deliberately excluded — see the
  // header note. Notifications are cut entirely (the bell icon owns them).
  for (const t of pending) {
    const due = d10(t.dueDate);
    if (!due || due >= todayStr) continue;
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: due, time: null, severity: "critical", bucket: "attention",
      when: "overdue", meta: String(t.priority || "—"),
      reason: `Overdue — was due ${dayLabel(due, todayStr)}`,
      group: "Overdue", panel: "tasks", sub: "overdue", tone: "neg", raw: t,
    });
  }
  for (const t of pending) {
    if (!isHigh(t)) continue;
    const due = d10(t.dueDate);
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: due, time: null, severity: "warning", bucket: "attention",
      when: due ? dayLabel(due, todayStr) : "—", meta: String(t.priority || "high"),
      reason: due ? `High priority · due ${dayLabel(due, todayStr)}` : "High priority",
      group: "High priority", panel: "tasks", tone: "warn", raw: t,
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
      reason: `${money(b.amount)} ${overdue ? "past due" : "due today"}`,
      group: "Bills past due", panel: "obligations", sub: "bills",
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
      group: "Documents expiring", panel: "obligations", sub: "docs",
      tone: doc.daysUntil <= 21 ? "neg" : "warn", raw: doc,
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

  // ══ PASS 2 — TODAY (block 3) ═══════════════════════════════════════════════
  // The merged timeline: events, tasks due, habits — with the progress bar.
  // Absorbs Today's Agenda, the Tasks/Events/Habits tiles and the AI brief
  // (which is now the single `synthesis` line rendered inside this card).
  for (const e of events) {
    if (d10(e.date) !== todayStr) continue;
    push({
      key: `event:${e.sourceId || e.id}:${d10(e.date)}`, kind: "event",
      id: String(e.sourceId || e.id), title: e.title,
      date: todayStr, time: e.time || null, severity: "info", bucket: "today",
      when: e.time || (e.allDay ? "all day" : "today"), meta: e.category || "event",
      group: "Schedule", panel: "timeline", raw: e,
    });
  }
  for (const t of pending) {
    if (d10(t.dueDate) !== todayStr) continue;
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: todayStr, time: null, severity: "info", bucket: "today",
      when: "task", meta: String(t.priority || "—"),
      group: "Due today", panel: "tasks", raw: t,
    });
  }
  for (const h of habitRows) {
    push({
      key: `habit:${h.id}`, kind: "habit", id: h.id, title: h.name,
      date: todayStr, time: null, severity: "info", bucket: "today",
      when: h.doneToday ? "✓" : "habit", meta: h.streak > 0 ? `${h.streak}🔥` : "",
      group: "Habits", panel: "habits", done: h.doneToday,
      tone: h.doneToday ? "pos" : undefined, raw: h.raw,
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
      group: "Schedule", panel: "reminders", raw: r,
    });
  }

  // ══ PASS 3 — NEXT 14 DAYS (block 4) ════════════════════════════════════════
  // Calendar, appointments, upcoming tasks, birthdays, important dates — one
  // card, collapsed to a count. Bills are NOT here; block 5 owns them.
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
  for (const t of pending) {
    const due = d10(t.dueDate);
    if (!due || due <= todayStr || due > in14) continue;
    push({
      key: `task:${t.id}`, kind: "task", id: String(t.id), title: t.title,
      date: due, time: null, severity: "info", bucket: "next14",
      when: dayLabel(due, todayStr), meta: String(t.priority || "—"),
      group: "Tasks", panel: "tasks", raw: t,
    });
  }

  // ══ PASS 4 — MONEY (block 5) ═══════════════════════════════════════════════
  // Near-term view only: bills due soon. Overdue/due-today bills were already
  // claimed by Needs Attention, which is the point of the cascade.
  for (const b of bills) {
    if (typeof b.daysUntil !== "number" || b.daysUntil <= 0 || b.daysUntil > 30) continue;
    push({
      key: `bill:${b.id}`, kind: "bill", id: String(b.id), title: b.name,
      date: d10(b.dueDate), time: null,
      severity: b.daysUntil <= 3 ? "warning" : "info", bucket: "money",
      when: `${b.daysUntil}d`, meta: money(b.amount),
      group: "Bills due soon", panel: "obligations", sub: "bills",
      amount: Number(b.amount) || 0, tone: b.daysUntil <= 3 ? "warn" : undefined, raw: b,
    });
  }

  // ══ PASS 5 — HABITS & TRACKERS (block 6) ═══════════════════════════════════
  // Habit ROWS live in Today; this block carries streak chips (aggregates, not
  // copies) plus trackers — the one-tap logging surface that was missing.
  for (const t of trackers) {
    const entries = arr(t.entries);
    const last = entries[entries.length - 1];
    const loggedToday = entries.some((e: any) => d10(e.timestamp || e.date) === todayStr);
    push({
      key: `tracker:${t.id}`, kind: "tracker", id: String(t.id), title: t.name,
      date: null, time: null, severity: "info", bucket: "habits",
      when: loggedToday ? "✓" : "log",
      meta: last?.values ? String(Object.values(last.values)[0] ?? "") : "",
      group: "Trackers", panel: "habits", done: loggedToday,
      tone: loggedToday ? "pos" : undefined, raw: t,
    });
  }

  // ══ PASS 6 — OPEN PROJECTS (block 7) ═══════════════════════════════════════
  for (const g of activeGoals) {
    const target = d10(g.targetDate || g.dueDate || g.deadline);
    push({
      key: `goal:${g.id}`, kind: "goal", id: String(g.id), title: g.title,
      date: target, time: null,
      severity: target && target < todayStr ? "warning" : "info", bucket: "projects",
      when: target ? dayLabel(target, todayStr) : "goal",
      meta: g.target ? `${Math.round(((g.current ?? 0) / g.target) * 100)}%` : "",
      group: "Goals", panel: "goals",
      tone: target && target < todayStr ? "warn" : "pos", raw: g,
    });
  }

  // ── Bucket + sort ─────────────────────────────────────────────────────────
  const buckets: Record<BriefingBucket, BriefingItem[]> = {
    attention: [], today: [], next14: [], money: [], habits: [], projects: [],
  };
  for (const it of items) buckets[it.bucket].push(it);

  buckets.attention.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || String(a.date || "9999").localeCompare(String(b.date || "9999")));
  // Timed items first in chronological order, untimed after, habits last.
  const todayRank = (i: BriefingItem) => (i.kind === "habit" ? 2 : i.time ? 0 : 1);
  buckets.today.sort((a, b) =>
    todayRank(a) - todayRank(b) || String(a.time || "").localeCompare(String(b.time || "")));
  buckets.next14.sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
    || String(a.time || "").localeCompare(String(b.time || "")));
  buckets.money.sort((a, b) => (a.raw?.daysUntil ?? 1e9) - (b.raw?.daysUntil ?? 1e9));

  const counts = {
    attention: buckets.attention.length, today: buckets.today.length,
    next14: buckets.next14.length, money: buckets.money.length,
    habits: buckets.habits.length, projects: buckets.projects.length,
  };

  // ── Block 1 — Pulse ───────────────────────────────────────────────────────
  // Net worth reads the SERVER snapshot totals (docs/dashboard-scope-contract.md
  // — the client must never re-walk profiles to recompute them).
  const netWorth = fin.assets - fin.liabilities;
  const monthlyOut = fin.monthlySpend + fin.monthlyObligations;
  const cashFlow = fin.monthlyIncome - monthlyOut;
  const bestStreak = Math.max(
    0, input.journalStreak || 0,
    ...arr(input.streaks).map((s: any) => Number(s?.days) || 0),
    ...habitRows.map((h) => Number(h.streak) || 0),
  );
  const bestStreakName = arr(input.streaks).slice().sort((a: any, b: any) => (b?.days || 0) - (a?.days || 0))[0]?.name
    || habitRows.slice().sort((a, b) => b.streak - a.streak)[0]?.name;

  const pulse: PulseModel = {
    netWorth,
    netWorthSub: `${money(fin.assets)} owned · ${money(fin.liabilities)} owed`,
    cashFlow,
    cashFlowSub: `${money(fin.monthlyIncome)} in · ${money(monthlyOut)} out`,
    wellness: habitRows.length === 0 ? "—" : `${habitsDone}/${habitRows.length}`,
    wellnessSub: habitRows.length === 0 ? "No habits yet"
      : habitsMissed === 0 ? "All done today" : `${habitsMissed} left today`,
    streak: bestStreak,
    streakSub: bestStreak === 0 ? "No active streak" : bestStreakName ? `Best: ${bestStreakName}` : "day streak",
  };

  // ── Block 5 — Money aggregates ────────────────────────────────────────────
  const moneyModel: MoneyModel = {
    billsDue: buckets.money,
    billsTotal: buckets.money.reduce((s, i) => s + (i.amount || 0), 0),
    monthlyIn: fin.monthlyIncome,
    monthlyOut,
    cashFlow,
    assets: fin.assets,
    liabilities: fin.liabilities,
    balanceLine: fin.assets === 0 && fin.liabilities === 0
      ? "No assets or liabilities tracked yet"
      : `${money(fin.assets)} in assets against ${money(fin.liabilities)} owed`,
  };

  // ── Block 6 — streak chips (aggregates over the Today habit rows) ─────────
  const habitsModel: HabitsModel = {
    streaks: habitRows
      .slice().sort((a, b) => b.streak - a.streak)
      .map((h) => ({ id: h.id, name: h.name, days: h.streak, doneToday: h.doneToday })),
    trackers: buckets.habits,
    doneToday: habitsDone,
    total: habitRows.length,
  };

  // ── Block 3 — progress bar + the one synthesis line ───────────────────────
  const todayDone = buckets.today.filter((i) => i.done).length + doneTodayCount;
  const todayTotal = buckets.today.length + doneTodayCount;
  const todayPct = todayTotal > 0 ? Math.round((todayDone / todayTotal) * 100) : 0;

  const todayOpen = buckets.today.filter((i) => !i.done);
  const nextTimed = todayOpen.find((i) => i.time && i.time >= nowClock) || todayOpen.find((i) => i.time);
  const criticalCount = buckets.attention.filter((i) => i.severity === "critical").length;
  const synthesis = (() => {
    if (criticalCount > 0) {
      const first = buckets.attention[0];
      return `${plural(criticalCount, "thing")} need${criticalCount === 1 ? "s" : ""} you first — start with “${first.title}”.`;
    }
    if (nextTimed) return `Next up: ${nextTimed.title} at ${nextTimed.time}.`;
    if (todayOpen.length > 0) return `${plural(todayOpen.length, "item")} left today, nothing time-boxed.`;
    if (todayTotal > 0) return "Everything scheduled for today is done.";
    return "Nothing scheduled today — a good day to get ahead.";
  })();

  // ── The "All clear" line: hide-at-zero blocks that are currently empty ────
  const allClear = HIDES_AT_ZERO
    .filter((b) => buckets[b].length === 0 && !(b === "habits" && habitsModel.total > 0))
    .map((b) => BLOCK_LABELS[b]);

  return {
    items, buckets, counts,
    pulse, money: moneyModel, habits: habitsModel,
    synthesis, todayPct, todayDone, todayTotal,
    hasCritical: criticalCount > 0,
    allClear,
  };
}
