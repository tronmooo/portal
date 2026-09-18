// ── Hub KPI strip ────────────────────────────────────────────────────────────
// The compact stat chips pinned above every hub tab: NET WORTH · CASH FLOW ·
// HEALTH · STREAK · TASKS DUE · DOCS EXP. Chips navigate to the owning tab —
// popups stay on the dashboard's KPI section.
//
// CACHE-KEY LOCKSTEP (do not change casually): every query below uses the
// dashboard's literal key shape `[endpoint, mode, ...filterIds]` — the same
// shape scopedKey() (see dashboard.tsx bootstrapQuery/statsQuery and
// HeroKPISection's incomes key) builds — so this strip resolves from the caches that
// /api/dashboard-bootstrap seeding (lib/bootstrap-seed.ts) already fills and
// fires zero extra requests on the happy path. The one exception is
// /api/trackers (not bootstrap-seeded): the HEALTH chip shows "—" until it
// lands, and its key/URL match the trackers page exactly so the cache is
// shared with the Trackers tab.
import { sumMonthIncomeNow } from "@shared/obligation-windows";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useState, useMemo, useRef, useCallback, useEffect, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
// hashNavigate handles query-carrying targets ("/linked?tab=documents") correctly
// under hash routing (see HubShell.tsx note).
import { hashNavigate } from "@/lib/hashNavigate";
import { apiRequest } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useOverflowX } from "@/hooks/useOverflowX";
import { collectMetrics, wellnessScore, resolveWellnessSubject, belongsToSubject } from "@shared/wellness-readout";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { groupDocumentDates } from "@shared/document-dates";
import type { DashboardStats, Tracker } from "@shared/schema";
import { MetricCard } from "@/components/ui/metric-card";
import { formatMoneyRound } from "@/lib/format";
import { countTasksByDay } from "@shared/task-counts";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import { HUB_TABS } from "./hub-routes";
import { Wallet, ArrowLeftRight, HeartPulse, Flame, CheckCircle2, FileText, ChevronLeft, ChevronRight } from "lucide-react";

// Drill-down popups — the SAME components the dashboard uses (user rule:
// every stat opens its existing popup; never duplicate one). Lazy-loaded:
// the strip is in the eager bundle and HeroKPIPopups drags recharts along
// (~500KB), so the chunks download on first chip click, not on app boot.
// FAIL-SAFE: if the chunk fetch fails (typical cause: a stale cached
// index.html referencing renamed chunk files right after a deploy), we
// navigate to the module's page instead of silently doing nothing.
function lazyPopup<T>(load: () => Promise<T>, pick: (m: T) => React.ComponentType<any>, fallbackRoute: string): React.ComponentType<any> {
  return lazy(() =>
    load().then(m => ({ default: pick(m) })).catch(() => ({
      default: (() => { hashNavigate(fallbackRoute); return null; }) as React.ComponentType<any>,
    })),
  );
}
const NetWorthPopup = lazyPopup(() => import("@/components/dashboard/HeroKPIPopups"), m => m.NetWorthPopup, "/dashboard/finance");
// One data type = one UI (2026-08-13): cash flow opens the canonical waterfall
// (finance/CashFlowView), the same interface Executive and Finance open.
const CashFlowPopup = lazyPopup(() => import("@/components/finance/CashFlowView"), m => m.CashFlowView, "/dashboard/finance");
const TasksPopup = lazyPopup(() => import("@/components/dashboard/TaskHabitPopups"), m => m.TasksPopup, "/dashboard/tasks");
const HabitsPopup = lazyPopup(() => import("@/components/dashboard/TaskHabitPopups"), m => m.HabitsPopup, "/dashboard/habits");
// DOCS EXP opened the Documents tab instead of a popup — the one number on the
// strip you could not read (user report 2026-09-04: "there is no pop up here …
// it just redirects me somewhere"). It now opens the SAME expirations popup the
// Executive briefing's Documents card opens, with renew, dismiss and open-record
// on every row.
const DocsPopup = lazyPopup(() => import("@/components/dashboard/BriefingPopups"), m => m.DocsPopup, "/linked?tab=documents");

// The strip shows whole dollars; the shared formatter does the grouping.
const fmtMoney = (n: number) => formatMoneyRound(n).replace(/^-?\$/, "");

// One KPI chip. This was a bare label + number in a pill — the first thing you
// see on every screen and the least informative element on it. It is now a
// MetricCard, the same tile the dashboard and wellness tabs use: an icon
// medallion, a number that counts up, and the sub-badge promoted to a coloured
// corner marker instead of grey text trailing the value.
//
// No sparkline here on purpose. A trend line would need net-worth history,
// which this strip does not fetch, and the strip's whole design constraint is
// that it resolves from caches the bootstrap already filled and issues zero
// extra requests. A chart that is empty on every cold load is worse than none.
function StatChip({ label, value, icon, accent, tone, sub, subTone, onClick, testId }: {
  label: string;
  value: string;
  icon: any;
  /** Tab-identity colour for the medallion (hub-routes.ts). */
  accent: string;
  /** Overrides the accent when the value itself is good or bad. */
  tone?: "pos" | "neg" | "warn";
  sub?: string;
  subTone?: "pos" | "neg" | "warn";
  onClick: () => void;
  testId: string;
}) {
  const TONE_HSL: Record<string, string> = {
    pos: "155 65% 45%", neg: "0 72% 58%", warn: "38 96% 54%",
  };
  const valueAccent = tone ? TONE_HSL[tone] : accent;
  return (
    <MetricCard
      label={label}
      value={value}
      accent={valueAccent}
      icon={icon}
      onClick={onClick}
      testId={testId}
      density="dense"
      // grow + min-w-fit: share out any spare width so six chips span the strip
      // on a desktop instead of huddling at the left with a third of the row
      // empty — but never shrink below the number they exist to show, so on a
      // phone they keep their natural size and the row scrolls as before.
      className="grow basis-0 min-w-fit"
      headerRight={sub ? (
        <span className={`text-[11px] font-bold whitespace-nowrap ${
          subTone === "pos" ? "text-emerald-500" : subTone === "neg" ? "text-red-500" : "text-amber-500"
        }`}>{sub}</span>
      ) : undefined}
    />
  );
}

export function HubKpiStrip() {
  const navigate = hashNavigate;
  const [popup, setPopup] = useState<"networth" | "cashflow" | "tasks" | "habits" | "docs" | null>(null);
  const scope = useProfileScope();
  const mode = scope.mode;
  const ids = scope.selectedIds;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["/api/stats", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/stats${param}`).then(r => r.json()),
    staleTime: 30_000,
    placeholderData: undefined,
  });
  const { data: enhanced } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/dashboard-enhanced${param}`).then(r => r.json()),
    staleTime: 30_000,
    placeholderData: undefined,
  });
  const { data: incomesRaw } = useQuery<any>({
    queryKey: ["/api/incomes", mode, ...ids, "hero"],
    queryFn: () => apiRequest("GET", `/api/incomes${param}`).then(r => r.json()),
    staleTime: 60_000,
    placeholderData: undefined,
  });
  // TASKS DUE — the SAME cache slot and the SAME counting rule as the
  // Executive tab's Tasks card (QA 2026-09-18 BUG-10: the chip said "9 · 5
  // late" while the card said "8 Remaining · 4 Overdue"; the chip read
  // /api/stats + /api/dashboard-enhanced, two older snapshots, and stayed
  // wrong through two reloads). Key shape ["/api/tasks", mode, ...ids] is
  // what ExecutiveBriefing/TasksPopup use, so one invalidation refreshes all.
  const { data: tasksRaw } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
    placeholderData: undefined,
  });
  const showTestData = useShowTestData();
  const { data: trackers, isPending: trackersPending } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/trackers${param}`).then(r => r.json()),
    staleTime: 30_000,
    placeholderData: undefined,
  });
  // Needed to resolve WHOSE wellness the chip is showing — health data is read
  // for one person, never blended (same rule as pages/wellness.tsx). The slim
  // profile list is already cached by the nav chrome, so this is free.
  const { data: profilesLite } = useQuery<any[]>({
    queryKey: ["/api/profiles/lite"],
    queryFn: () => apiRequest("GET", "/api/profiles/lite").then(r => r.json()),
    staleTime: 300_000,
  });

  // NET WORTH — the server's filtered finance snapshot is the single source of
  // truth (same numbers HeroKPISection/NetWorthPopup trust, NW-5). No client
  // roll-up fallback here: "—" until the snapshot lands beats a wrong flash.
  const snap = enhanced?.financeSnapshot;
  const netWorth = snap != null ? (snap.totalAssetValue ?? 0) - (snap.totalLiabilities ?? 0) : null;

  // CASH FLOW — the ONE definition, straight off the snapshot:
  //   IN  = recurring income + paychecks actually received
  //   OUT = month expenses + bill money still owed this month
  // OUT was `expenses + monthly-equivalent of every bill`, so every bill that
  // had already been paid was counted twice (paying one writes an expense).
  const incomes: any[] = Array.isArray(incomesRaw) ? incomesRaw : incomesRaw?.items || [];
  const monthlyIncome = snap?.monthlyIncome != null
    ? Number(snap.monthlyIncome) || 0
    : sumMonthIncomeNow(incomes, null, BROWSER_TIMEZONE);
  const monthlySpend = snap?.totalMonthlySpend ?? stats?.monthlySpend;
  const cashFlow = monthlySpend != null
    ? monthlyIncome - (monthlySpend + Number(snap?.unpaidBillsThisMonth ?? snap?.monthlyObligationTotal ?? 0))
    : null;

  // WELLNESS — the SAME score the Wellness tab shows, computed by the same
  // function over the same subject (shared/wellness-readout). The chip sits
  // directly above that tab and navigates to it, so a second, differently
  // derived number here is a contradiction on one screen: this chip read 75
  // off the legacy tracker-activity score while the tab, rebuilt on the
  // canonical metrics, read 96.
  //
  // Null means BOTH "still loading" and "nothing connected to score", and the
  // chip rendered "—" for both — so a person with no trackers looked broken
  // next to a person with a score (QA 2026-08-05, "Bob shows — while Mike
  // shows 78"). Say which: "…" in flight, "—" once the list has landed.
  const health = useMemo(() => {
    if (!trackers) return null;
    const { subject, isSelf } = resolveWellnessSubject(
      (profilesLite || []) as any[],
      mode === "selected" ? ids : [],
    );
    const mine = trackers.filter((t) => belongsToSubject((t as any).linkedProfiles, subject, isSelf));
    return wellnessScore(collectMetrics(mine as any)).value;
  }, [trackers, profilesLite, mode, ids.join(",")]);
  const healthValue = health != null ? String(health) : trackersPending ? "…" : "—";

  const streak = stats
    ? Math.max(0, ...(stats.streaks || []).map(s => s.days || 0), stats.journalStreak || 0)
    : null;

  const taskCounts = useMemo(() => {
    if (!Array.isArray(tasksRaw)) return null;
    // "Hide test data" (default) — the card hides the same rows.
    const rows = showTestData ? tasksRaw : tasksRaw.filter((t: any) => !isTestDataRow(t?.title) && !isTestDataRow(t?.description));
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
    return countTasksByDay(rows, todayStr, BROWSER_TIMEZONE);
  }, [tasksRaw, showTestData]);
  // Remaining = every open task (dated or not), exactly the card's "Remaining".
  const tasksDue = taskCounts
    ? taskCounts.overdue + taskCounts.dueToday + taskCounts.upcoming + taskCounts.undated
    : stats?.activeTasks;
  const tasksLate: number = taskCounts ? taskCounts.overdue : (enhanced?.overdueTasks || []).length;

  // DOCS EXP — the rows the popup will list, counted the way it lists them.
  //
  // The raw feed is one row per dated FIELD, before dismissals: a policy that
  // expires and takes its premium on the same day is two rows, and a row the
  // user dismissed is still in it. Counting that fed the chip a number the
  // popup then contradicted. Snooze-filter and group first (the same two
  // helpers the popup and the Executive card use), so the tile promises
  // exactly what opening it delivers.
  const rawExpDocs: any[] = enhanced?.expiringDocuments || [];
  const snoozedDocIds = useMemo(() => Object.keys(loadDocSnoozeMap()), [rawExpDocs.length]);
  const expDocs = useMemo(
    () => groupDocumentDates(
      rawExpDocs.filter((d: any) => !snoozedDocIds.includes(d?.ruleId) && !snoozedDocIds.includes(d?.documentId)),
    ),
    [rawExpDocs, snoozedDocIds],
  );
  const minDocDays = expDocs.length > 0
    ? Math.min(...expDocs.map((d: any) => (typeof d.daysUntil === "number" ? d.daysUntil : Infinity)))
    : null;
  // The chip's count is every expiring document; its caption used to be
  // driven by the single soonest one, so one overdue plus one due in 8 days
  // read "2 · overdue". Count the two states separately.
  const overdueDocs = expDocs.filter((d: any) => typeof d.daysUntil === "number" && d.daysUntil < 0).length;
  const docsSub = expDocs.length === 0 ? undefined
    : overdueDocs > 0 ? `${overdueDocs} overdue${expDocs.length > overdueDocs ? ` · ${expDocs.length - overdueDocs} soon` : ""}`
    : minDocDays != null && isFinite(minDocDays) ? `≤${minDocDays}d` : undefined;

  // Each chip wears the colour of the tab it belongs to, from the one place
  // those colours are declared.
  const tabAccent = (id: string) => HUB_TABS.find(t => t.id === id)!.accent;

  // Values are listed as deps because a chip changing from "—" to "1,398,804"
  // is what most often pushes the row into (or out of) overflow.
  const [stripRef, clipped] = useOverflowX<HTMLDivElement>([
    netWorth, cashFlow, health, streak, tasksDue, tasksLate, expDocs.length, minDocDays,
  ]);
  // QA 2026-09-18 BUG-28: at 1442px the strip ended mid-word ("5 lat") with
  // the DOCS EXP chip off-screen and nothing saying so — it scrolled, but the
  // mask fade was subtle and there were no controls. Now: a gradient on the
  // overflowing edge(s) plus arrow buttons that page the strip.
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const readEdges = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, [stripRef]);
  useEffect(() => { readEdges(); }, [clipped, readEdges]);
  const page = (dir: 1 | -1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, Math.round(el.clientWidth * 0.6)), behavior: "smooth" });
  };
  const showLeft = clipped && !atStart;
  const showRight = clipped && !atEnd;

  return (
    <div className="relative" data-testid="hub-kpi-strip-wrap">
    {/* Horizontal scroll. The gradient + arrow on an edge mean "more chips
        this way", and appear only when something is genuinely cut off. */}
    <div
      ref={stripRef}
      onScroll={readEdges}
      className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar scroll-smooth"
      data-testid="hub-kpi-strip"
      data-clipped={clipped ? "true" : "false"}
    >
      <StatChip
        icon={Wallet}
        accent={tabAccent("finance")}
        label="Net Worth"
        value={netWorth == null ? "—" : `${netWorth < 0 ? "-" : ""}$${fmtMoney(netWorth)}`}
        tone={netWorth != null && netWorth < 0 ? "neg" : undefined}
        onClick={() => setPopup("networth")}
        testId="hub-kpi-networth"
      />
      <StatChip
        icon={ArrowLeftRight}
        accent={tabAccent("finance")}
        label="Cash Flow"
        value={cashFlow == null ? "—" : `${cashFlow >= 0 ? "+" : "-"}$${fmtMoney(cashFlow)}`}
        tone={cashFlow == null ? undefined : cashFlow >= 0 ? "pos" : "neg"}
        onClick={() => setPopup("cashflow")}
        testId="hub-kpi-cashflow"
      />
      <StatChip
        icon={HeartPulse}
        accent={tabAccent("wellness")}
        label="Wellness"
        value={healthValue}
        tone={health != null && health >= 70 ? "pos" : health != null && health < 45 ? "warn" : undefined}
        onClick={() => navigate("/wellness")}
        testId="hub-kpi-health"
      />
      <StatChip
        icon={Flame}
        accent="25 90% 58%"
        label="Streak"
        value={streak == null ? "—" : `${streak}D`}
        sub={streak != null && streak > 0 ? "★" : undefined}
        subTone="warn"
        onClick={() => setPopup("habits")}
        testId="hub-kpi-streak"
      />
      <StatChip
        icon={CheckCircle2}
        accent={tabAccent("executive")}
        label="Tasks Due"
        value={tasksDue == null ? "—" : String(tasksDue)}
        sub={tasksLate > 0 ? `${tasksLate} late` : undefined}
        subTone="neg"
        onClick={() => setPopup("tasks")}
        testId="hub-kpi-tasks"
      />
      <StatChip
        icon={FileText}
        accent={tabAccent("documents")}
        label="Docs Exp"
        value={String(expDocs.length)}
        sub={docsSub}
        subTone={overdueDocs > 0 ? "neg" : "warn"}
        onClick={() => setPopup("docs")}
        testId="hub-kpi-docs"
      />

      {/* Drill-down popups — the exact components the dashboard KPI tiles use.
          Mounted only while open so the lazy chunk loads on first click. */}
      <Suspense fallback={null}>
        {popup === "networth" && <NetWorthPopup open onOpenChange={(o: boolean) => !o && setPopup(null)} filterMode={mode} filterIds={ids} />}
        {popup === "cashflow" && <CashFlowPopup open onOpenChange={(o: boolean) => !o && setPopup(null)} filterMode={mode} filterIds={ids} />}
        {popup === "tasks" && <TasksPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
        {popup === "habits" && <HabitsPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
        {/* Pass the RAW rows: the popup applies the same snooze filter and
            grouping itself, and its dismiss action needs every rule id a card
            stands for. The chip's count above is derived the same way. */}
        {popup === "docs" && <DocsPopup open onClose={() => setPopup(null)} docs={rawExpDocs} />}
      </Suspense>
    </div>
    {showLeft && (
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center" data-testid="hub-kpi-fade-left">
        <div className="absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-background to-transparent" aria-hidden="true" />
        <button type="button" onClick={() => page(-1)} aria-label="Scroll stats left"
          className="pointer-events-auto relative ml-0.5 h-7 w-7 rounded-full border border-border bg-background/95 shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground"
          data-testid="hub-kpi-scroll-left">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    )}
    {showRight && (
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end" data-testid="hub-kpi-fade-right">
        <div className="absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent" aria-hidden="true" />
        <button type="button" onClick={() => page(1)} aria-label="Scroll stats right"
          className="pointer-events-auto relative mr-0.5 h-7 w-7 rounded-full border border-border bg-background/95 shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground"
          data-testid="hub-kpi-scroll-right">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    )}
    </div>
  );
}
