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
import { sumMonthlyIncomeNow } from "@shared/obligation-windows";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useState, useMemo, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
// hashNavigate handles query-carrying targets ("/linked?tab=documents") correctly
// under hash routing (see HubShell.tsx note).
import { hashNavigate } from "@/lib/hashNavigate";
import { apiRequest } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useOverflowX } from "@/hooks/useOverflowX";
import { computeHealthScore } from "@/lib/tracker-health";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { groupDocumentDates } from "@shared/document-dates";
import type { DashboardStats, Tracker } from "@shared/schema";
import { MetricCard } from "@/components/ui/metric-card";
import { formatMoneyRound } from "@/lib/format";
import { HUB_TABS } from "./hub-routes";
import { Wallet, ArrowLeftRight, HeartPulse, Flame, CheckCircle2, FileText } from "lucide-react";

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
  const { data: trackers, isPending: trackersPending } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/trackers${param}`).then(r => r.json()),
    staleTime: 30_000,
    placeholderData: undefined,
  });

  // NET WORTH — the server's filtered finance snapshot is the single source of
  // truth (same numbers HeroKPISection/NetWorthPopup trust, NW-5). No client
  // roll-up fallback here: "—" until the snapshot lands beats a wrong flash.
  const snap = enhanced?.financeSnapshot;
  const netWorth = snap != null ? (snap.totalAssetValue ?? 0) - (snap.totalLiabilities ?? 0) : null;

  // CASH FLOW — mirrors HeroKPISection's definition exactly: monthly incomes
  // minus (month expenses + monthlyized active obligations).
  const incomes: any[] = Array.isArray(incomesRaw) ? incomesRaw : incomesRaw?.items || [];
  const monthlyIncome = sumMonthlyIncomeNow(incomes, BROWSER_TIMEZONE);
  const monthlySpend = snap?.totalMonthlySpend ?? stats?.monthlySpend;
  const cashFlow = monthlySpend != null
    ? monthlyIncome - (monthlySpend + (snap?.monthlyObligationTotal ?? 0))
    : null;

  // computeHealthScore returns null for BOTH "still loading" and "this scope
  // has no health/fitness readings to score" — and the chip rendered "—" for
  // both, so a person with no trackers looked like a broken tile next to a
  // person with a score (QA report 2026-08-05, "Bob shows — while Mike shows
  // 78"). Say which: "…" while the list is in flight, "—" once it has landed
  // and there is genuinely nothing to score.
  const health = trackers ? computeHealthScore(trackers) : null;
  const healthValue = health != null ? String(health) : trackersPending ? "…" : "—";

  const streak = stats
    ? Math.max(0, ...(stats.streaks || []).map(s => s.days || 0), stats.journalStreak || 0)
    : null;

  const tasksDue = stats?.activeTasks;
  const tasksLate: number = (enhanced?.overdueTasks || []).length;

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

  // Each chip wears the colour of the tab it belongs to, from the one place
  // those colours are declared.
  const tabAccent = (id: string) => HUB_TABS.find(t => t.id === id)!.accent;

  // Values are listed as deps because a chip changing from "—" to "1,398,804"
  // is what most often pushes the row into (or out of) overflow.
  const [stripRef, clipped] = useOverflowX<HTMLDivElement>([
    netWorth, cashFlow, health, streak, tasksDue, tasksLate, expDocs.length, minDocDays,
  ]);

  return (
    // Horizontal scroll with an edge fade so cut-off chips read as "more to
    // the right" instead of a broken layout at narrow widths — but only when
    // something is genuinely cut off. On a desktop the six chips fit and share
    // the full width, and fading the last one there just looked like a bug.
    <div
      ref={stripRef}
      className={`flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar ${
        clipped ? "[mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]" : ""
      }`}
      data-testid="hub-kpi-strip"
    >
      <StatChip
        icon={Wallet}
        accent={tabAccent("finance")}
        label="Net Worth"
        value={netWorth == null ? "—" : `${netWorth < 0 ? "-" : ""}${fmtMoney(netWorth)}`}
        tone={netWorth != null && netWorth < 0 ? "neg" : undefined}
        onClick={() => setPopup("networth")}
        testId="hub-kpi-networth"
      />
      <StatChip
        icon={ArrowLeftRight}
        accent={tabAccent("finance")}
        label="Cash Flow"
        value={cashFlow == null ? "—" : `${cashFlow >= 0 ? "+" : "-"}${fmtMoney(cashFlow)}`}
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
        sub={minDocDays != null && isFinite(minDocDays) ? (minDocDays < 0 ? "overdue" : `≤${minDocDays}d`) : undefined}
        subTone={minDocDays != null && minDocDays < 0 ? "neg" : "warn"}
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
  );
}
