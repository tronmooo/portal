// ── Executive tab — an attention center, not a board ─────────────────────────
// One question: what requires my attention right now?
//
// This tab used to render 17 collapsible sections (agenda, overdue, tasks,
// priority, habits, reminders, birthdays, appointments, important dates, docs,
// bills, calendar, notifications, projects, activity, notes, AI brief) plus a
// Today strip. Four of them were urgency from a different angle, and the rest
// restated data that already has a home on the Calendar, Trackers, Documents,
// Liabilities, Goals or profile pages. The same record could appear three
// times under three different labels.
//
// What's left is: six context tiles, a one-glance brief, and a single ranked
// feed. What qualifies as attention — and, critically, the dedupe that stops
// one record being counted twice — lives in shared/attention.ts, so this file
// only decides presentation and which mutation a button fires.
//
// Removed content was not deleted from the app, only from this tab:
//   agenda/calendar/birthdays/appointments/important dates → /calendar
//   upcoming + high-priority tasks                          → /dashboard/tasks
//   full habit list                                         → /dashboard/habits
//   bills module                                            → /dashboard/obligations
//   projects/goals                                          → /goals
//   recent activity + notes                                 → /journal
import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, recoverWedgedQueries, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import { BillsPopup, EventsPopup, DocsPopup } from "@/components/dashboard/BriefingPopups";
import { AttentionFeed } from "@/components/dashboard/AttentionFeed";
import { AttentionFilters, useAttentionPrefs } from "@/components/dashboard/AttentionFilters";
import type { DashboardStats } from "@shared/schema";
// One relative-due formatter for the whole app. Interpolating a raw `daysUntil`
// here is what produced "Lawn care ($40) due in -29d".
import { dueLabel } from "@shared/now-rank";
import { computeAttention, type AttentionItem } from "@shared/attention";
import { isHabitDueOn, isHabitDoneOn } from "@shared/habit-schedule";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";

type PopupKind = "tasks" | "habits" | "bills" | "events" | "docs" | null;

const ACCENTS: Record<string, string> = {
  tasks:    "217 91% 65%",  // blue
  habits:   "155 65% 45%",  // emerald
  docs:     "0 72% 58%",    // red
  bills:    "48 96% 53%",   // yellow
  calendar: "239 84% 67%",  // indigo
  alerts:   "280 75% 62%",  // purple
};

function Section({ id, title, children, testId }: {
  id: string; title: string; children: React.ReactNode; testId: string;
}) {
  const [open, setOpen] = useState(true);
  const accent = ACCENTS[id] || "240 10% 60%";
  return (
    <div
      className="mb-2 rounded-lg border bg-card/40 px-2 pt-0.5 pb-1.5"
      style={{ borderColor: `hsl(${accent} / 0.25)` }}
      data-testid={testId}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 py-1.5 text-left group"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">{title}</span>
        <ChevronDown className={`h-3 w-3 ml-auto text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && children}
    </div>
  );
}

// Top stat tile — big count plus a small unit next to it ("3 due today"), a
// decision-oriented sub-line, clickable. `prominent` gives the Attention tile
// the strongest visual weight on the board.
function StatTile({ label, value, unit, sub, accent, onClick, testId, prominent }: {
  label: string; value: string; unit?: string; sub?: string; accent: string;
  onClick: () => void; testId: string; prominent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="rounded-xl border px-2.5 py-2 text-left card-lift transition-all"
      style={{
        borderColor: `hsl(${accent} / ${prominent ? 0.55 : 0.30})`,
        background: `linear-gradient(135deg, hsl(${accent} / ${prominent ? 0.20 : 0.12}) 0%, hsl(var(--card)) 75%)`,
        ...(prominent ? { boxShadow: `0 0 16px hsl(${accent} / 0.18)` } : {}),
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-0.5 min-w-0">
        <span className={`metric-value ${prominent ? "text-2xl" : "text-xl"}`} style={{ color: `hsl(${accent})` }}>{value}</span>
        {unit && <span className="text-[11px] font-medium truncate" style={{ color: `hsl(${accent})` }}>{unit}</span>}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </button>
  );
}

const normName = (s: any) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Display-level bill dedupe: "Verizon Phone Bill payment" and "Phone Bill
// payment" at the same $86.50 are one bill entered twice. Collapses rows only
// when the amounts match exactly AND the normalized names match or nest —
// "rent the 1st" ($2,500) vs "rent" ($300) stays two rows for the user to
// reconcile. The row with the more specific (longer) name survives.
function dedupeBills(rows: any[]): any[] {
  const out: any[] = [];
  for (const b of rows || []) {
    const n = normName(b.name);
    const idx = out.findIndex(o => Number(o.amount) === Number(b.amount) && (() => {
      const m = normName(o.name);
      return m === n || (n && m && (m.includes(n) || n.includes(m)));
    })());
    if (idx === -1) out.push(b);
    else if (n.length > normName(out[idx].name).length) out[idx] = b;
  }
  return out;
}

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced, ready = true }: {
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
  /** Gate for this component's own queries (PERF 2026-07-16): the dashboard
   * passes bootstrapSettled so these resolve from the bootstrap-seeded cache
   * instead of firing 7 network requests that race the bootstrap download on
   * weak mobile links. Defaults true so other callers are unaffected; the
   * dashboard's gate self-releases after 8s even if bootstrap hangs. */
  ready?: boolean;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [popup, setPopup] = useState<PopupKind>(null);
  // Which item's money-moving button is armed for the confirming second tap.
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const mode = filterMode;
  const ids = filterIds;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const amp = param ? "&" : "?";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
  const in45 = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

  // NOTE (BUG-20260715-everyone-zeros): none of these query functions may
  // swallow errors into a cached-as-success empty value (`.catch(() => [])`).
  // A transient failure — e.g. the pre-auth boot window racing token restore —
  // then renders as "0 in every category" for the whole staleTime window.
  // Letting the error propagate keeps react-query in error state (data stays
  // undefined → section shows empty NOW but refetches on mount/focus/switch).
  const { data: tasksRaw = [], isPending: tasksPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habitsRaw = [], isPending: habitsPending } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  // 45-day window: the feed only uses today's timed events, but the tiles show
  // "next up" beyond today. One fetch serves both.
  const { data: timelineRaw = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, in45, mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/calendar/timeline${param}${amp}start=${todayStr}&end=${in45}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Reminders are profile-scoped like every other briefing query — pass the
  // active filter so a selected profile shows only its own reminders (the
  // server enforces strict isolation; unlinked reminders appear only in the
  // unfiltered "Everyone" view). Keying on mode/ids makes switching profiles
  // refetch instead of showing another profile's cached reminders.
  const { data: remindersRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/reminders", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/reminders${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: goalsRaw = [], isPending: goalsPending } = useQuery<any[]>({
    queryKey: ["/api/goals", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/goals${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: notificationsRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/notifications", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/notifications${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Dismissed alerts. The old panel filtered on `n.dismissed` — a field
  // buildNotifications never sets — and never read this preference, so an alert
  // the user dismissed from the bell came straight back on the dashboard.
  const { data: dismissedIds = [] } = useQuery<string[]>({
    queryKey: ["/api/preferences/dismissed_notifications"],
    enabled: ready,
    queryFn: () => apiRequest("GET", "/api/preferences/dismissed_notifications")
      .then(r => r.json())
      .then(d => { try { return JSON.parse(d?.value || "[]"); } catch { return []; } }),
    staleTime: 60_000,
  });

  const { prefs, setPrefs } = useAttentionPrefs(ready);

  // "Hide test data" (default) — the header toggle flips this flag app-wide,
  // but this tab previously never consumed it, so AUDIT/QA/W2/SMOKE rows leaked
  // into every section regardless of the toggle. Same shared detector the
  // finance surfaces use (shared/test-data).
  const showTestData = useShowTestData();
  // Notification titles wrap the entity name in a prefix ("Overdue bill: QA
  // Test Subscription") — the anchored patterns miss those, so also test each
  // after-colon segment.
  const testText = (s: any): boolean => {
    if (isTestDataRow(s)) return true;
    const str = String(s || "");
    return str.includes(":") && str.split(":").slice(1).some((part: string) => isTestDataRow(part.trim()));
  };
  const isTestRow = (r: any) =>
    testText(r?.name) || testText(r?.title) || isTestDataRow(r?.description) ||
    testText(r?.message) || isTestDataRow(r?.documentName);
  const hideTest = <T,>(rows: T[]): T[] => (showTestData ? rows : (rows || []).filter(r => !isTestRow(r)));
  const tasks = hideTest(tasksRaw || []);
  const habits = hideTest(habitsRaw || []);
  const timeline = hideTest(timelineRaw || []);
  const reminders = hideTest(Array.isArray(remindersRaw) ? remindersRaw : []);
  const notifications = hideTest(Array.isArray(notificationsRaw) ? notificationsRaw : []);
  const goals = hideTest(goalsRaw || []);
  const allBills = dedupeBills(hideTest(enhanced?.financeSnapshot?.upcomingBills || []));
  const allExpiringDocs = hideTest<any>(enhanced?.expiringDocuments || []);

  // STUCK-LOADING DEADLINE (2026-07-16): if any tile-feeding query is still
  // unresolved after 12s (wedged fetch, failed enhanced, cold instance), show
  // the Retry banner instead of letting "loading" tiles sit forever.
  const anyBriefPending = tasksPending || habitsPending || timelinePending || goalsPending || enhanced === undefined;
  const [briefStuck, setBriefStuck] = useState(false);
  useEffect(() => {
    if (!anyBriefPending) { setBriefStuck(false); return; }
    const t = setTimeout(() => setBriefStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [anyBriefPending]);

  // ── The feed ───────────────────────────────────────────────────────────────
  const snoozedDocumentIds = useMemo(() => Object.keys(loadDocSnoozeMap()), [allExpiringDocs.length]);
  const attention = useMemo(() => computeAttention({
    today: todayStr,
    tasks, bills: allBills, documents: allExpiringDocs, habits,
    reminders, events: timeline, goals, notifications,
    dismissedNotificationIds: dismissedIds,
    snoozedDocumentIds,
  }, showSuppressed
    // "Show lower-priority" widens the same model rather than switching to a
    // second one — one set of rules, one place to reason about.
    ? { ...prefs, minTier: "upcoming" as const, upcomingMinBillAmount: 0, docsWithinDays: 90, billsWithinDays: 60, tasksWithinDays: 30 }
    : prefs),
  [todayStr, tasks, allBills, allExpiringDocs, habits, reminders, timeline, goals, notifications, dismissedIds, snoozedDocumentIds, prefs, showSuppressed]);

  // ── Tile derivations ───────────────────────────────────────────────────────
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const fmtShort = (d: string) => new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const nowClock = new Date().toTimeString().slice(0, 5);

  const pending = (tasks || []).filter((t: any) => t.status !== "done");
  const overdueTasks = pending.filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) < todayStr);
  const agendaTasks = pending.filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) === todayStr);
  const highCount = pending.filter((t: any) => ["high", "urgent"].includes(String(t.priority || "").toLowerCase())).length;
  const doneToday = (tasks || []).filter((t: any) => t.status === "done" && String(t.completedAt || t.updatedAt || "").slice(0, 10) === todayStr).length;

  // Habits: scheduled-today only. The frequency rule lives in shared now, so a
  // weekly habit no longer counts as "due" on the other six days.
  const habitsDueToday = (habits || []).filter((h: any) => isHabitDueOn(h, todayStr));
  const habitsDoneCount = habitsDueToday.filter((h: any) => isHabitDoneOn(h, todayStr)).length;
  const missedCount = habitsDueToday.length - habitsDoneCount;

  const tl = (timeline || []).filter((i: any) => (i.date || "").slice(0, 10) >= todayStr);
  const eventsToday = tl.filter((i: any) => i.type === "event" && (i.date || "").slice(0, 10) === todayStr);
  const futureEvents = tl.filter((i: any) => i.type === "event" && (i.date || "").slice(0, 10) > todayStr);
  const nextTodayEvent = eventsToday
    .filter((i: any) => i.time && i.time >= nowClock)
    .sort((a: any, b: any) => String(a.time).localeCompare(String(b.time)))[0]
    || eventsToday.find((i: any) => !i.time);
  const nextFutureEvent = futureEvents.slice().sort((a: any, b: any) => String(a.date || "").localeCompare(String(b.date || "")))[0];
  const nextEventLabel = nextTodayEvent
    ? `Next: ${nextTodayEvent.title}${nextTodayEvent.time ? ` · ${nextTodayEvent.time}` : ""}`
    : nextFutureEvent
      ? `Next: ${nextFutureEvent.title} · ${fmtShort(String(nextFutureEvent.date))}`
      : "nothing scheduled";

  const bills = allBills.filter((b: any) => b.daysUntil <= 21);
  const overdueBillCount = bills.filter((b: any) => b.status === "overdue").length;
  const billsUpcomingTotal = bills.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0);
  const nextBill = bills.filter((b: any) => b.status !== "overdue")
    .slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  const nextBillDate = nextBill
    ? fmtShort(String(nextBill.dueDate || "").slice(0, 10) || new Date(Date.now() + (nextBill.daysUntil || 0) * 86400000).toLocaleDateString("en-CA"))
    : null;

  const docExpiryPhrase = (d: number) =>
    d < 0 ? (d === -1 ? "expired yesterday" : `expired ${Math.abs(d)} days ago`)
    : d === 0 ? "expires today" : d === 1 ? "expires tomorrow" : `expires in ${d} days`;
  const visibleDocs = allExpiringDocs.filter((d: any) => !snoozedDocumentIds.includes(d.documentId));
  const docsSoonCount = visibleDocs.filter((d: any) => typeof d.daysUntil === "number" && d.daysUntil <= 30).length;
  const nextDoc = visibleDocs
    .filter((d: any) => typeof d.daysUntil === "number" && d.daysUntil <= 30)
    .slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];

  // Attention tile sub-line: top two contributors, most severe first, then a
  // "N more" tail so the parts always account for the headline number (a "29"
  // headline with a "9 · 6" sub-line read as broken math).
  const attnCounts = attention.counts;
  const byKind = (k: string) => attention.items.filter(i => i.kind === k).length;
  const attnParts: Array<{ label: string; n: number }> = [];
  const overdueTaskItems = attention.items.filter(i => i.kind === "task" && (i.daysUntil ?? 0) < 0).length;
  if (overdueTaskItems) attnParts.push({ label: plural(overdueTaskItems, "overdue task"), n: overdueTaskItems });
  const overdueBillItems = attention.items.filter(i => i.kind === "bill" && (i.daysUntil ?? 0) < 0).length;
  if (overdueBillItems) attnParts.push({ label: plural(overdueBillItems, "overdue bill"), n: overdueBillItems });
  const billsDueTodayItems = attention.items.filter(i => i.kind === "bill" && i.daysUntil === 0).length;
  if (billsDueTodayItems) attnParts.push({ label: `${plural(billsDueTodayItems, "bill")} due today`, n: billsDueTodayItems });
  if (byKind("document")) attnParts.push({ label: plural(byKind("document"), "expiring doc"), n: byKind("document") });
  if (byKind("alert")) attnParts.push({ label: plural(byKind("alert"), "alert"), n: byKind("alert") });
  if (byKind("reminder")) attnParts.push({ label: `${plural(byKind("reminder"), "reminder")} due`, n: byKind("reminder") });
  if (byKind("habit")) attnParts.push({ label: `${plural(byKind("habit"), "habit card")}`, n: byKind("habit") });
  const attnShown = attnParts.slice(0, 2);
  const attnMore = attention.items.length - attnShown.reduce((s, p) => s + p.n, 0);
  const attnSub = [...attnShown.map(p => p.label), attnMore > 0 ? `${attnMore} more` : null].filter(Boolean).join(" · ");

  // AI Executive Brief — honest, instant bullets derived from the feed above
  // (no per-load AI call). The AI chat can still create/modify any of the
  // underlying records; these lines just reflect the current state.
  const aiBrief: Array<{ text: string; tone?: "pos" | "neg" | "warn"; go?: () => void }> = [];
  // Lead bullet covers tasks AND bills: opening with a green "No overdue
  // tasks." while overdue bills sit two bullets down read as a contradiction.
  if (overdueTasks.length > 0) aiBrief.push({ text: `${overdueTasks.length} task${overdueTasks.length > 1 ? "s" : ""} overdue — start with “${overdueTasks[0].title}”.`, tone: "neg", go: () => setPopup("tasks") });
  else if (overdueBillCount > 0) aiBrief.push({ text: `No overdue to-do tasks, but ${plural(overdueBillCount, "overdue bill")} to pay.`, tone: "warn", go: () => setPopup("bills") });
  else aiBrief.push({ text: "Nothing overdue — tasks and bills are clear.", tone: "pos" });
  if (nextDoc) aiBrief.push({ text: `${nextDoc.documentName || nextDoc.name || nextDoc.fieldName || "A document"} ${docExpiryPhrase(nextDoc.daysUntil)}.`, tone: nextDoc.daysUntil <= 21 ? "neg" : "warn", go: () => setPopup("docs") });
  if (missedCount > 0) aiBrief.push({ text: `${missedCount} habit${missedCount > 1 ? "s" : ""} still due today.`, tone: "warn", go: () => setPopup("habits") });
  const soonestBill = bills.slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  if (soonestBill) aiBrief.push({ text: `${soonestBill.name} ($${Number(soonestBill.amount).toLocaleString()}) ${dueLabel(soonestBill.daysUntil)}.`, tone: soonestBill.daysUntil <= 1 ? "neg" : undefined, go: () => setPopup("bills") });

  // ── Actions ────────────────────────────────────────────────────────────────
  const markBusy = (key: string, on: boolean) =>
    setBusyKeys(prev => { const next = new Set(prev); on ? next.add(key) : next.delete(key); return next; });

  const payBill = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/obligations/${id}/pay`, {}); },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      // Cache bus: obligations domain also refreshes stats/cashflow/loans so
      // every linked surface updates in one shot.
      invalidateDomain("obligations");
    },
    onError: () => toast({ title: "Payment failed", variant: "destructive" }),
  });
  const completeTask = useMutation({
    mutationFn: async (id: string) => { await apiRequest("PATCH", `/api/tasks/${id}`, { status: "done" }); },
    onSuccess: () => { toast({ title: "Task completed" }); invalidateDomain("tasks"); },
    onError: () => toast({ title: "Couldn't complete task", variant: "destructive" }),
  });
  const checkinHabit = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/habits/${id}/checkin`, {}); },
    onSuccess: () => { toast({ title: "Checked in" }); invalidateDomain("habits"); },
    onError: () => toast({ title: "Check-in failed", variant: "destructive" }),
  });
  const dismissReminders = useMutation({
    mutationFn: async (idList: string[]) => {
      for (const id of idList) await apiRequest("DELETE", `/api/reminders/${id}`);
    },
    onSuccess: () => { toast({ title: "Reminder dismissed" }); queryClient.invalidateQueries({ queryKey: ["/api/reminders"] }); },
    onError: () => toast({ title: "Couldn't dismiss reminder", variant: "destructive" }),
  });
  const dismissAlert = useMutation({
    // Same store the bell and the AI's dismiss_notifications tool write to, so
    // a dismissal here silences it everywhere.
    mutationFn: async (id: string) => {
      const merged = Array.from(new Set([...(dismissedIds || []), id]));
      await apiRequest("PUT", "/api/preferences/dismissed_notifications", { value: JSON.stringify(merged) });
    },
    onSuccess: () => {
      toast({ title: "Alert dismissed" });
      queryClient.invalidateQueries({ queryKey: ["/api/preferences/dismissed_notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: () => toast({ title: "Couldn't dismiss alert", variant: "destructive" }),
  });

  const idOf = (item: AttentionItem) => item.sourceKey.split(":").slice(1).join(":");

  const onAction = (item: AttentionItem) => {
    const kind = item.action?.kind;
    if (!kind || kind === "open") { navigate(item.href); return; }
    const key = item.key;
    const run = (p: Promise<any>) => { markBusy(key, true); p.finally(() => markBusy(key, false)); };
    switch (kind) {
      case "pay":
        // Money moves once. First tap arms, second commits; the arm lapses so a
        // stray tap can't sit primed on screen.
        if (armedKey !== key) {
          setArmedKey(key);
          setTimeout(() => setArmedKey(k => (k === key ? null : k)), 4000);
          return;
        }
        setArmedKey(null);
        run(payBill.mutateAsync(idOf(item)));
        return;
      case "complete": run(completeTask.mutateAsync(idOf(item))); return;
      case "checkin": run(checkinHabit.mutateAsync(idOf(item))); return;
      case "dismiss":
        if (item.kind === "reminder") {
          // A rolled-up medication row stands for every dose under it.
          const idList = item.children?.length ? item.children.map(idOf) : [idOf(item)];
          run(dismissReminders.mutateAsync(idList));
        } else {
          run(dismissAlert.mutateAsync(item.key.replace(/^alert:/, "")));
        }
        return;
      default:
        navigate(item.href);
    }
  };

  const feedLoading = anyBriefPending && attention.items.length === 0;

  return (
    <div data-testid="executive-briefing">
      {/* STUCK-LOADING BANNER (2026-07-16): a tile must never say "loading"
          forever. If any feeding query is still unresolved after 12s, surface
          a Retry that cancels wedged requests and refetches what's on screen. */}
      {briefStuck && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2" data-testid="brief-stuck-banner">
          <span className="text-xs text-muted-foreground">Some sections are taking too long to load.</span>
          <button
            className="text-xs font-medium text-primary hover:underline shrink-0"
            onClick={() => { setBriefStuck(false); void recoverWedgedQueries(); }}
            data-testid="brief-stuck-retry"
          >Retry</button>
        </div>
      )}

      {/* Context tiles. These are the "am I OK right now" layer — they open the
          owning module's popup and never duplicate the feed below.
          Loading-vs-empty (BUG-20260715-everyone-zeros): while a tile's query
          is still pending (cold Everyone switch, cold reload) it shows "…",
          never a hard 0 — a wall of zeros reads as "aggregation is broken". */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2" data-testid="brief-stat-row">
        <StatTile prominent label="Attention"
          value={tasksPending || enhanced === undefined ? "…" : String(attention.items.length)}
          unit={tasksPending || enhanced === undefined ? undefined : attention.items.length > 0 ? (attention.items.length === 1 ? "item needs review" : "items need review") : undefined}
          sub={tasksPending || enhanced === undefined ? "loading" : attention.items.length === 0 ? "Nothing needs review" : attnSub}
          accent={attention.items.length === 0 ? "155 65% 45%" : attnCounts.immediate > 0 ? "0 72% 58%" : "43 96% 56%"}
          onClick={() => document.querySelector('[data-testid="attention-feed"]')?.scrollIntoView({ behavior: "smooth", block: "start" })}
          testId="brief-stat-attention" />
        <StatTile label="Tasks"
          value={tasksPending ? "…" : String(agendaTasks.length)} unit={tasksPending ? undefined : "due today"}
          sub={tasksPending ? "loading"
            : overdueTasks.length || highCount ? `${overdueTasks.length} overdue · ${highCount} high priority`
            : doneToday > 0 ? `${plural(doneToday, "task")} completed today`
            : `${plural(pending.length, "open task")}`}
          accent={ACCENTS.tasks} onClick={() => setPopup("tasks")} testId="brief-stat-tasks" />
        <StatTile label="Events"
          value={timelinePending ? "…" : String(eventsToday.length)} unit={timelinePending ? undefined : "today"}
          sub={timelinePending ? "loading" : nextEventLabel}
          accent={ACCENTS.calendar} onClick={() => setPopup("events")} testId="brief-stat-events" />
        <StatTile label="Bills"
          value={enhanced === undefined ? "…" : `$${Math.round(billsUpcomingTotal).toLocaleString()}`}
          unit={enhanced === undefined ? undefined : "due soon"}
          sub={enhanced === undefined ? "loading"
            : overdueBillCount ? `${plural(overdueBillCount, "overdue bill")}${nextBillDate ? ` · next due ${nextBillDate}` : ""}`
            : nextBillDate ? `next due ${nextBillDate}`
            : "nothing due in 3 weeks"}
          accent={ACCENTS.bills} onClick={() => setPopup("bills")} testId="brief-stat-bills" />
        <StatTile label="Documents"
          value={enhanced === undefined ? "…" : String(docsSoonCount)}
          unit={enhanced === undefined ? undefined : docsSoonCount === 1 ? "needs attention" : "need attention"}
          sub={enhanced === undefined ? "loading" : nextDoc ? `${nextDoc.documentName || nextDoc.name || "Document"} ${docExpiryPhrase(nextDoc.daysUntil)}` : "all good"}
          accent={ACCENTS.docs} onClick={() => setPopup("docs")} testId="brief-stat-documents" />
        {/* Zero habits ≠ "all done" — it means nothing is scheduled. */}
        <StatTile label="Habits"
          value={habitsPending ? "…" : habitsDueToday.length === 0 ? "—" : `${habitsDoneCount} of ${habitsDueToday.length}`}
          unit={habitsPending || habitsDueToday.length === 0 ? undefined : "completed"}
          sub={habitsPending ? "loading" : habitsDueToday.length === 0 ? "No habits scheduled today" : missedCount > 0 ? `${missedCount} remaining today` : "all done today"}
          accent={ACCENTS.habits} onClick={() => setPopup("habits")} testId="brief-stat-habits" />
      </div>

      <Section id="alerts" title="AI Executive Brief" testId="brief-ai">
        <div className="space-y-0.5 pb-0.5">
          {aiBrief.map((b, i) => (
            <button key={i} onClick={b.go} className="w-full flex items-start gap-1.5 py-[3px] px-1 text-left text-xs hover:bg-muted/40 rounded-sm">
              <span className="mt-[3px]" style={{ color: "hsl(280 75% 66%)" }}>✦</span>
              <span className={`flex-1 ${b.tone === "neg" ? "text-red-500" : b.tone === "warn" ? "text-amber-500" : b.tone === "pos" ? "text-emerald-500" : ""}`}>{b.text}</span>
            </button>
          ))}
        </div>
      </Section>

      {/* ── The feed ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-1.5 mt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Needs your attention
        </h2>
        <button
          onClick={() => setFiltersOpen(o => !o)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          data-testid="attention-filters-toggle"
          aria-expanded={filtersOpen}
        >
          <SlidersHorizontal className="h-3 w-3" />
          Filters
        </button>
      </div>
      {filtersOpen && <AttentionFilters prefs={prefs} onChange={setPrefs} />}

      <AttentionFeed
        items={attention.items}
        counts={attention.counts}
        suppressed={attention.suppressed}
        loading={feedLoading}
        onAction={onAction}
        busyKeys={busyKeys}
        armedKey={armedKey}
        onShowSuppressed={() => setShowSuppressed(s => !s)}
        showingSuppressed={showSuppressed}
      />

      {/* The SAME popups the dashboard KPI tiles use — statically imported here
          (part of the dashboard chunk), so a tile click always opens them even
          if a lazy chunk fetch would have failed. */}
      {popup === "tasks" && <TasksPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "habits" && <HabitsPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "bills" && <BillsPopup open onClose={() => setPopup(null)} bills={allBills} />}
      {popup === "events" && <EventsPopup open onClose={() => setPopup(null)} items={tl} todayStr={todayStr} />}
      {popup === "docs" && <DocsPopup open onClose={() => setPopup(null)} docs={visibleDocs} />}
    </div>
  );
}

export default ExecutiveBriefing;
