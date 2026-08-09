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
// What's here now is six context tiles, a one-glance brief, and ten named
// sections: Immediate Attention, Today's Agenda, Habits Due Today, Bills,
// Upcoming (7d), Birthdays & Anniversaries, Documents & Expirations, Health,
// Recent Activity, and Insights.
//
// The sections are NOT the old board. Every record is routed to exactly ONE of
// them by shared/executive-sections.ts, so an overdue bill appears under
// Immediate Attention and nowhere else, and a derived "Critical notification"
// collapses onto the record it was derived from. This file only decides
// presentation and which mutation a button fires.
import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, recoverWedgedQueries, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import {
  ChevronDown, SlidersHorizontal, TriangleAlert, CheckCircle2, CalendarDays,
  DollarSign, FolderOpen, Flame, Sparkles, Gauge, type LucideIcon,
} from "lucide-react";
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import { BillsPopup, EventsPopup, DocsPopup } from "@/components/dashboard/BriefingPopups";
import { ExecutiveSections } from "@/components/dashboard/ExecutiveSections";
import { Medallion, CountUp } from "@/components/dashboard/visuals";
import { AttentionFilters, useAttentionPrefs } from "@/components/dashboard/AttentionFilters";
import type { DashboardStats } from "@shared/schema";
// One relative-due formatter for the whole app. Interpolating a raw `daysUntil`
// here is what produced "Lawn care ($40) due in -29d".
import { dueLabel } from "@shared/now-rank";
import type { AttentionItem } from "@shared/attention";
import { buildExecutiveSections } from "@shared/executive-sections";
import { rollupOccurrences, bucketsForKinds, breakdownLabel } from "@shared/dated-items";
import type { CalendarOccurrence, OccurrenceKind } from "@shared/calendar-occurrences";
import { isHabitDueOn, isHabitDoneOn } from "@shared/habit-schedule";
import { markOccurrence, pruneOccurrenceTags } from "@shared/recurring-dates";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import { canonicalTimelineWindow, timelineQueryKey, timelineUrl } from "@shared/calendar-window";

type PopupKind = "tasks" | "habits" | "bills" | "events" | "docs" | null;

const ACCENTS: Record<string, string> = {
  tasks:    "217 91% 65%",  // blue
  habits:   "155 65% 45%",  // emerald
  docs:     "0 72% 58%",    // red
  bills:    "48 96% 53%",   // yellow
  calendar: "239 84% 67%",  // indigo
  alerts:   "280 75% 62%",  // purple
};

// The AI brief lives in its own bubble. Purple, per the colour system: purple
// is what the app uses for AI everywhere else.
function BriefBubble({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const accent = ACCENTS.alerts;
  return (
    <section
      className="bubble bubble-enter mb-3 p-3.5 sm:p-4"
      style={{ ["--accent-hsl" as any]: accent, ["--i" as any]: 6 }}
      data-testid="brief-ai"
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 text-left touch-hit"
        aria-expanded={open}
      >
        <Medallion icon={Sparkles} accent={accent} size="sm" />
        <h3 className="flex-1 text-sm font-bold tracking-tight">Executive Brief</h3>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && children}
    </section>
  );
}

// Top stat tile — a bubble with a large icon medallion, a counting number and
// a decision-oriented sub-line. `prominent` gives the Attention tile the
// strongest weight on the page. Values arrive as strings because a tile may be
// showing "…" while its query is still in flight (BUG-20260715-everyone-zeros:
// a wall of hard zeros reads as "aggregation is broken"), so the counting
// animation only applies when the value is genuinely numeric.
//
// SPANNING (see the grid in ExecutiveBriefing): the prominent tile is the one
// that stretches, and it stretches by exactly the amount that makes seven tiles
// divide evenly into the column count — 2 of 2, 3 of 3, 2 of 4. That is the
// whole reason the grid never ends in a row of holes.
//
// A tile stretched across a wide row would otherwise be a phone tile with a
// band of dead space beside it, so in the 3-column layouts — the only ones
// where this tile is both full-row AND wide — the sub-line leaves the stack and
// pins to the tile's right edge. Per breakpoint:
//
//   base  2 cols · spans 2 · full row at phone width · stacked
//   sm    3 cols · spans 3 · full row, ~615px        · pinned
//   md    2 cols · spans 2 · sidebar cuts it to ~400 · stacked
//   lg    3 cols · spans 3 · ~720px                  · pinned
//   xl    4 cols · spans 2 · half a row              · stacked
const SUB_POSITION = [
  "w-full mt-1.5",                                                            // stacked
  "sm:w-auto sm:ml-auto sm:max-w-[50%] sm:self-center sm:text-right sm:mt-0",  // pinned
  "md:w-full md:ml-0 md:max-w-none md:self-auto md:text-left md:mt-1.5",       // stacked
  "lg:w-auto lg:ml-auto lg:max-w-[50%] lg:self-center lg:text-right lg:mt-0",  // pinned
  "xl:w-full xl:ml-0 xl:max-w-none xl:self-auto xl:text-left xl:mt-1.5",       // stacked
].join(" ");

function StatTile({ label, value, unit, sub, accent, icon, onClick, testId, prominent }: {
  label: string; value: string; unit?: string; sub?: string; accent: string;
  icon: LucideIcon; onClick: () => void; testId: string; prominent?: boolean;
}) {
  const numeric = /^\$?[\d,]+$/.test(value);
  const isMoney = value.startsWith("$");
  const numberValue = numeric ? Number(value.replace(/[$,]/g, "")) : 0;
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`bubble bubble-interactive bubble-enter text-left touch-hit ${
        prominent
          ? "p-3.5 col-span-2 sm:col-span-3 md:col-span-2 lg:col-span-3 xl:col-span-2"
          : "p-3"
      }`}
      style={{ ["--accent-hsl" as any]: accent }}
    >
      <div className={`flex items-start gap-2.5 ${prominent ? "flex-wrap" : ""}`}>
        <Medallion icon={icon} accent={accent} size={prominent ? "lg" : "sm"} />
        <div className="min-w-0 flex-1">
          <span className="block micro-label text-muted-foreground truncate">
            {label}
          </span>
          <div className="flex items-baseline gap-1 mt-0.5 min-w-0">
            <span className={`metric-value ${prominent ? "text-3xl" : "text-2xl"}`} style={{ color: `hsl(${accent})` }}>
              {numeric ? <>{isMoney && "$"}<CountUp value={numberValue} /></> : value}
            </span>
            {unit && <span className="text-[11px] font-semibold truncate" style={{ color: `hsl(${accent} / 0.85)` }}>{unit}</span>}
          </div>
        </div>
        {prominent && sub && (
          // Clamped rather than truncated: on the widths where this pins right,
          // the extra room is exactly where the rest of the sentence
          // ("· 8 expiring documents") finally fits.
          <div className={`${SUB_POSITION} text-[11px] text-muted-foreground line-clamp-2`}>
            {sub}
          </div>
        )}
      </div>
      {!prominent && sub && <div className="text-[11px] text-muted-foreground truncate mt-1.5">{sub}</div>}
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
  // Rows the user just completed, held for the exit animation so they slide
  // out instead of blinking away when the refetch lands.
  const [leavingKeys, setLeavingKeys] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const mode = filterMode;
  const ids = filterIds;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

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
  // [PERF 2026-07-31] Canonical shared window (shared/calendar-window.ts): the
  // same key the bootstrap seeds, the calendar page counts from and the month
  // grid renders — one cache slot instead of three cold fetches. The window
  // reaches back to monthStart−7 for the grid's sake; this tab only wants
  // today-onward, so past-dated rows are filtered out below.
  const timelineWindow = useMemo(() => canonicalTimelineWindow(todayStr), [todayStr]);
  const { data: timelineRaw = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: timelineQueryKey(timelineWindow, mode, ids),
    enabled: ready,
    queryFn: () => apiRequest("GET", timelineUrl(timelineWindow, mode, ids)).then(r => r.json()),
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
  // §10 Insights & Suggestions. The insights engine reads across trackers,
  // spending, habits, bills, journal, documents and goals — observations that
  // exist nowhere else on this tab. Lowest priority of the queries here, so it
  // gets the longest staleTime.
  const { data: insights = [] } = useQuery<any[]>({
    queryKey: ["/api/insights", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/insights${param}`).then(r => r.json()),
    staleTime: 5 * 60_000,
  });
  // §8 Health. Obligations carry `kind` and the taken-today payment ledger,
  // which the finance snapshot's flattened `upcomingBills` does not — without
  // them a daily medication is indistinguishable from an electricity bill.
  // Trackers carry the server-stamped `computed` bands and the dose history.
  //
  // Neither adds a round-trip: /api/dashboard-bootstrap already seeds both of
  // these exact keys (see lib/bootstrap-seed-keys.ts), and scopedKey produces
  // the same [endpoint, mode, ...ids] shape built here.
  const { data: obligationsRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/obligations", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/obligations${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: trackersRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/trackers", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/trackers${param}`).then(r => r.json()),
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
  // Canonical window includes pre-today rows for the calendar grid; this tab's
  // feed and tiles are today-onward only (preserves the previous behavior of
  // the old today→+45 fetch exactly).
  const timeline = hideTest((timelineRaw || []).filter((it: any) => String(it?.date || "").slice(0, 10) >= todayStr));
  const reminders = hideTest(Array.isArray(remindersRaw) ? remindersRaw : []);
  const notifications = hideTest(Array.isArray(notificationsRaw) ? notificationsRaw : []);
  const goals = hideTest(goalsRaw || []);
  const obligations = hideTest(Array.isArray(obligationsRaw) ? obligationsRaw : []);
  const trackers = hideTest(Array.isArray(trackersRaw) ? trackersRaw : []);
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

  // ── The windowed roll-up every tile counts from ─────────────────────────────
  //
  // Reported 2026-08-04: "Every badge, counter, and card must use the exact same
  // source of truth… The dashboard should never report 0 Tasks if there are
  // tasks with due dates." The tiles below used to re-scan the raw `tasks`
  // array while the Calendar page bucketed `/api/calendar/timeline` with its own
  // inline loop — two datasets, two answers, for one question.
  //
  // `rollupOccurrences` (shared/dated-items) is now the only bucketing code, and
  // it reads the CANONICAL timeline window — unfiltered by date, unlike the
  // today-onward `timeline` the feed uses, because a tile that cannot see
  // yesterday cannot report an overdue count.
  const datedRollup = useMemo(() => {
    const rows = hideTest(Array.isArray(timelineRaw) ? timelineRaw : []).map((item: any) => ({
      kind: (item?.type || "event") as OccurrenceKind,
      date: String(item?.date || "").slice(0, 10),
      effectiveDate: String(item?.date || "").slice(0, 10),
      status: item?.completed ? "done" : "upcoming",
    })) as unknown as CalendarOccurrence[];
    return rollupOccurrences(rows, todayStr);
  }, [timelineRaw, todayStr, showTestData]);
  // Tasks and habit schedules share one card, exactly as they share one chip on
  // the Recurring Dates screen (shared/calendar-categories KIND_TO_CATEGORY).
  const taskBuckets = useMemo(() => bucketsForKinds(datedRollup, ["task", "habit"]), [datedRollup]);

  // ── §11 AI Recommendations ─────────────────────────────────────────────────
  // Tap to generate, never on load: the endpoint is a model call, and a
  // dashboard open is not a request for advice. Held in state rather than a
  // query so mounting the tab can't trigger it.
  const [recommendations, setRecommendations] = useState<any[] | null>(null);
  const generateRecommendations = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("GET", `/api/dashboard/ai-suggestions?force=true${param ? `&${param.slice(1)}` : ""}`);
      return r.json();
    },
    onSuccess: (d: any) => {
      const rows = Array.isArray(d?.suggestions) ? d.suggestions : [];
      setRecommendations(rows);
      if (rows.length === 0) {
        toast({ title: "Nothing to suggest yet", description: "Add a little more data and try again." });
      }
    },
    onError: () => toast({ title: "Couldn't generate recommendations", variant: "destructive" }),
  });
  // A scope switch invalidates the advice — it was computed for the other
  // profile's data and would otherwise sit there looking current.
  useEffect(() => { setRecommendations(null); }, [mode, ids.join(",")]);

  // ── The sections ───────────────────────────────────────────────────────────
  const snoozedDocumentIds = useMemo(() => Object.keys(loadDocSnoozeMap()), [allExpiringDocs.length]);
  const sectionInput = useMemo(() => ({
    today: todayStr,
    tasks, bills: allBills, documents: allExpiringDocs, habits,
    reminders, events: timeline, goals, notifications,
    dismissedNotificationIds: dismissedIds,
    snoozedDocumentIds,
    recentActivity: stats?.recentActivity || [],
    insights, obligations, trackers,
    recommendations: recommendations || [],
  }), [todayStr, tasks, allBills, allExpiringDocs, habits, reminders, timeline, goals, notifications, dismissedIds, snoozedDocumentIds, stats, insights, obligations, trackers, recommendations]);

  const sections = useMemo(
    () => buildExecutiveSections(sectionInput, prefs),
    [sectionInput, prefs]);

  // The Attention tile counts the Immediate Attention section — the same rows
  // the user will see under it, so the headline can't disagree with the list.
  const immediate = sections.find(s => s.id === "immediate");

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

  // Day progress over COMPLETABLE items only. Events, bills and reminders have
  // no done-state, so including them would make the figure unable to reach
  // 100% — the bug that made "4 of 10 habits" render as 33%.
  const dayCompletable = agendaTasks.length + doneToday + habitsDueToday.length;
  const dayDone = doneToday + habitsDoneCount;
  const dayPct = dayCompletable > 0 ? Math.round((dayDone / dayCompletable) * 100) : 0;

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
  // headline with a "9 · 6" sub-line read as broken math). It counts the
  // Immediate Attention SECTION, so the tile and the list under it agree.
  const immediateItems = immediate?.items || [];
  const attnCount = immediate?.total ?? 0;
  const byKind = (k: string) => immediateItems.filter(i => i.kind === k).length;
  const attnParts: Array<{ label: string; n: number }> = [];
  if (byKind("task")) attnParts.push({ label: plural(byKind("task"), "overdue task"), n: byKind("task") });
  if (byKind("bill")) attnParts.push({ label: plural(byKind("bill"), "overdue bill"), n: byKind("bill") });
  if (byKind("document")) attnParts.push({ label: plural(byKind("document"), "expired doc"), n: byKind("document") });
  if (byKind("alert")) attnParts.push({ label: plural(byKind("alert"), "alert"), n: byKind("alert") });
  const attnShown = attnParts.slice(0, 2);
  const attnMore = attnCount - attnShown.reduce((s, p) => s + p.n, 0);
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
  /** Play the row out, then let the refetch remove it for real. */
  const markLeaving = (key: string) => {
    setLeavingKeys(prev => new Set(prev).add(key));
    setTimeout(() => setLeavingKeys(prev => { const n = new Set(prev); n.delete(key); return n; }), 400);
  };

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
  // A dose is recorded as an obligation payment dated today — the same write
  // the Wellness page makes, so marking it here and there cannot disagree.
  const markMedTaken = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/obligations/${id}/pay`, { date: todayStr });
    },
    onSuccess: () => { toast({ title: "Dose logged" }); invalidateDomain("obligations"); },
    onError: () => toast({ title: "Couldn't log dose", variant: "destructive" }),
  });
  // Checking off ONE occurrence of a recurring date. Same tag write the
  // calendar and the Recurring Dates manager make (shared/recurring-dates), so
  // this year goes done and next year's occurrence stays live automatically.
  //
  // The tags come from the timeline row we already hold rather than a fresh
  // read, so a tag edit made elsewhere inside the 60s cache window could be
  // overwritten. The canonical applyCalendarAction avoids that with a live row
  // lookup, but it needs a full CalendarSeries this tab does not build.
  const markOccurrenceDone = useMutation({
    mutationFn: async (row: any) => {
      const date = String(row?.date || "").slice(0, 10);
      const tags = pruneOccurrenceTags(markOccurrence(row?.meta?.tags ?? [], date, "done"), todayStr);
      await apiRequest("PATCH", `/api/events/${row.sourceId}`, { tags });
    },
    onSuccess: () => { toast({ title: "Marked done" }); invalidateDomain("events"); },
    onError: () => toast({ title: "Couldn't mark it done", variant: "destructive" }),
  });
  const completeTask = useMutation({
    mutationFn: async (id: string) => { await apiRequest("PATCH", `/api/tasks/${id}`, { status: "done" }); },
    onSuccess: () => { toast({ title: "Task completed" }); invalidateDomain("tasks"); },
    onError: () => toast({ title: "Couldn't complete task", variant: "destructive" }),
  });
  const checkinHabit = useMutation({
    // Records ONE completion. On a multi-completion habit the tile keeps
    // reading "1/2 done" until the target is met — checking in once does not
    // finish a habit whose target is 2.
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/habits/${id}/checkin`, { count: 1, source: "manual" }); },
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
    const run = (p: Promise<any>) => {
      markBusy(key, true);
      p.then(() => markLeaving(key)).catch(() => {}).finally(() => markBusy(key, false));
    };
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
      // No two-tap arming: logging a dose is trivially undone from Wellness,
      // unlike `pay`, which moves money.
      case "taken": run(markMedTaken.mutateAsync(idOf(item))); return;
      case "markdone": {
        // The row carries no tags of its own — look the occurrence back up in
        // the timeline by the id the item key was built from.
        const rowId = item.key.replace(/^event:/, "");
        const row = (Array.isArray(timelineRaw) ? timelineRaw : []).find((r: any) => r?.id === rowId);
        if (!row) { navigate(item.href); return; }
        run(markOccurrenceDone.mutateAsync(row));
        return;
      }
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

  const feedLoading = anyBriefPending && sections.length === 0;

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
      {/* COLUMN COUNT (2026-08-05). This row used to be `grid-cols-2
          sm:grid-cols-3`, capped at three columns forever, so every desktop
          width laid seven tiles out as 3 · 3 · 1 and the page opened on a row
          holding one tile and two holes.

          Two things drive the ladder below. First, the tile count: the Attention
          tile's span is picked so 7 tiles always divide evenly — spanning 2 over
          2 columns = 8 cells, spanning 3 over 3 = 9, spanning 2 over 4 = 8. No
          width ends in a gap. Second, THE SIDEBAR, which is what makes this
          non-monotonic: it becomes inline at md (768px, see use-mobile) and
          takes 16rem, so the content box actually SHRINKS from ~615px at sm to
          ~400px there. Holding 3 columns across that step is what truncated the
          units to "n…" and "nee…". Columns follow the content box, not the
          viewport: 2 · sm 3 · md 2 (sidebar arrives) · lg 3 · xl 4. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 mb-4" data-testid="brief-stat-row">
        <StatTile prominent label="Attention" icon={TriangleAlert}
          value={tasksPending || enhanced === undefined ? "…" : String(attnCount)}
          unit={tasksPending || enhanced === undefined ? undefined : attnCount > 0 ? (attnCount === 1 ? "item needs action" : "items need action") : undefined}
          sub={tasksPending || enhanced === undefined ? "loading" : attnCount === 0 ? "Nothing is overdue" : attnSub}
          accent={attnCount === 0 ? "155 65% 45%" : "0 72% 58%"}
          onClick={() => document.querySelector('[data-testid="exec-section-immediate"]')?.scrollIntoView({ behavior: "smooth", block: "start" })}
          testId="brief-stat-attention" />
        {/* Counts everything dated that needs action — overdue, today, and the
            next 30 days — with the Today · Upcoming · Overdue split underneath.
            It reads the shared roll-up, so it cannot say 0 while the calendar
            shows a dated task, and it agrees with the Calendar page's tiles. */}
        <StatTile label="Tasks" icon={CheckCircle2}
          value={timelinePending ? "…" : String(taskBuckets.attention)}
          unit={timelinePending ? undefined : taskBuckets.attention === 1 ? "needs action" : "need action"}
          sub={timelinePending ? "loading"
            : breakdownLabel(taskBuckets)
            || (doneToday > 0 ? `${plural(doneToday, "task")} completed today` : "Nothing scheduled")}
          accent={ACCENTS.tasks} onClick={() => setPopup("tasks")} testId="brief-stat-tasks" />
        <StatTile label="Events" icon={CalendarDays}
          value={timelinePending ? "…" : String(eventsToday.length)} unit={timelinePending ? undefined : "today"}
          sub={timelinePending ? "loading" : nextEventLabel}
          accent={ACCENTS.calendar} onClick={() => setPopup("events")} testId="brief-stat-events" />
        <StatTile label="Bills" icon={DollarSign}
          value={enhanced === undefined ? "…" : `$${Math.round(billsUpcomingTotal).toLocaleString()}`}
          unit={enhanced === undefined ? undefined : "due soon"}
          sub={enhanced === undefined ? "loading"
            : overdueBillCount ? `${plural(overdueBillCount, "overdue bill")}${nextBillDate ? ` · next due ${nextBillDate}` : ""}`
            : nextBillDate ? `next due ${nextBillDate}`
            : "nothing due in 3 weeks"}
          accent={ACCENTS.bills} onClick={() => setPopup("bills")} testId="brief-stat-bills" />
        <StatTile label="Documents" icon={FolderOpen}
          value={enhanced === undefined ? "…" : String(docsSoonCount)}
          unit={enhanced === undefined ? undefined : docsSoonCount === 1 ? "needs attention" : "need attention"}
          sub={enhanced === undefined ? "loading" : nextDoc ? `${nextDoc.documentName || nextDoc.name || "Document"} ${docExpiryPhrase(nextDoc.daysUntil)}` : "all good"}
          accent={ACCENTS.docs} onClick={() => setPopup("docs")} testId="brief-stat-documents" />
        {/* Zero habits ≠ "all done" — it means nothing is scheduled.
            "0 of 12" + "completed" does not fit a tile at any column count: it
            broke across two lines with the unit truncated to "complet…", which
            made this the one tile taller than its row. "0/12 done" says the same
            thing on one line, and the sub-line carries the detail. */}
        <StatTile label="Habits" icon={Flame}
          value={habitsPending ? "…" : habitsDueToday.length === 0 ? "—" : `${habitsDoneCount}/${habitsDueToday.length}`}
          unit={habitsPending || habitsDueToday.length === 0 ? undefined : "done"}
          sub={habitsPending ? "loading" : habitsDueToday.length === 0 ? "No habits scheduled today" : missedCount > 0 ? `${missedCount} remaining today` : "all done today"}
          accent={ACCENTS.habits} onClick={() => setPopup("habits")} testId="brief-stat-habits" />
        {/* The seventh tile. Rather than pad the row with another count that's
            already on screen, it carries the one thing nothing else answers:
            how much of today is actually finished. Completable items only —
            tasks and habits have a done-state, events and bills do not, so
            counting them would make the bar unable to reach 100%. */}
        <StatTile label="Today" icon={Gauge}
          value={tasksPending || habitsPending ? "…" : dayCompletable === 0 ? "—" : `${dayPct}%`}
          unit={tasksPending || habitsPending || dayCompletable === 0 ? undefined : "done"}
          sub={tasksPending || habitsPending ? "loading"
            : dayCompletable === 0 ? "Nothing scheduled today"
            : `${dayDone} of ${dayCompletable} tasks & habits`}
          accent="262 80% 66%" onClick={() => setPopup("tasks")} testId="brief-stat-today" />
      </div>

      <BriefBubble>
        <div className="mt-3 space-y-1.5">
          {aiBrief.map((b, i) => (
            <button key={i} onClick={b.go}
              className="bubble-row w-full flex items-start gap-2.5 px-3 py-2.5 text-left"
              style={{ ["--accent-hsl" as any]: ACCENTS.alerts }}>
              <span className="mt-[3px] shrink-0" style={{ color: "hsl(280 75% 66%)" }} aria-hidden="true">✦</span>
              <span className={`flex-1 text-[13px] leading-snug font-medium ${b.tone === "neg" ? "text-red-500" : b.tone === "warn" ? "text-amber-500" : b.tone === "pos" ? "text-emerald-500" : ""}`}>{b.text}</span>
            </button>
          ))}
        </div>
      </BriefBubble>

      {/* ── The feed ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-1.5 mt-3">
        <h2 className="micro-label text-muted-foreground">
          Needs your attention
        </h2>
        <div className="flex items-center gap-1.5">
          {/* Generating advice costs a model call, so it stays a deliberate tap
              rather than something a dashboard open triggers. Once generated,
              the rows render as the AI Recommendations section below. */}
          <button
            onClick={() => generateRecommendations.mutate()}
            disabled={generateRecommendations.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
            data-testid="exec-recommendations-generate"
          >
            <Sparkles className="h-3 w-3" />
            {generateRecommendations.isPending
              ? "Thinking…"
              : recommendations ? "Refresh advice" : "AI advice"}
          </button>
          <button
            onClick={() => setFiltersOpen(o => !o)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            data-testid="attention-filters-toggle"
            aria-expanded={filtersOpen}
          >
            <SlidersHorizontal className="h-3 w-3" />
            Filters
          </button>
        </div>
      </div>
      {filtersOpen && <AttentionFilters prefs={prefs} onChange={setPrefs} />}

      <ExecutiveSections
        sections={sections}
        loading={feedLoading}
        onAction={onAction}
        busyKeys={busyKeys}
        armedKey={armedKey}
        leavingKeys={leavingKeys}
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
