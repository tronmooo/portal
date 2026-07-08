// ── Hub KPI strip ────────────────────────────────────────────────────────────
// The compact stat chips pinned above every hub tab: NET WORTH · CASH FLOW ·
// HEALTH · STREAK · TASKS DUE · DOCS EXP. Chips navigate to the owning tab —
// popups stay on the dashboard's KPI section.
//
// CACHE-KEY LOCKSTEP (do not change casually): every query below uses the
// dashboard's literal key shape `[endpoint, filterMode, ...filterIds]`
// (see dashboard.tsx bootstrapQuery/statsQuery and HeroKPISection's incomes
// key) — NOT profileScopeKey() — so this strip resolves from the caches that
// /api/dashboard-bootstrap seeding (lib/bootstrap-seed.ts) already fills and
// fires zero extra requests on the happy path. The one exception is
// /api/trackers (not bootstrap-seeded): the HEALTH chip shows "—" until it
// lands, and its key/URL match the trackers page exactly so the cache is
// shared with the Trackers tab.
import { useQuery } from "@tanstack/react-query";
// hashNavigate handles query-carrying targets ("/linked?tab=documents") correctly
// under hash routing (see HubShell.tsx note).
import { hashNavigate } from "@/lib/hashNavigate";
import { apiRequest } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import { computeHealthScore } from "@/lib/tracker-health";
import type { DashboardStats, Tracker } from "@shared/schema";

function fmtMoney(n: number): string {
  return Math.round(Math.abs(n)).toLocaleString("en-US");
}

function StatChip({ label, value, accent, sub, subTone, onClick, testId }: {
  label: string;
  value: string;
  accent?: "pos" | "neg" | "warn";
  sub?: string;
  subTone?: "pos" | "neg" | "warn";
  onClick: () => void;
  testId: string;
}) {
  const tone = (t?: "pos" | "neg" | "warn") =>
    t === "pos" ? "text-emerald-500" : t === "neg" ? "text-red-500" : t === "warn" ? "text-amber-500" : "text-foreground";
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="shrink-0 flex items-baseline gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-1.5 hover:bg-accent/50 transition-colors text-left"
    >
      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${tone(accent)}`}>{value}</span>
      {sub && <span className={`text-[10px] font-mono font-semibold ${tone(subTone)}`}>{sub}</span>}
    </button>
  );
}

export function HubKpiStrip() {
  const navigate = hashNavigate;
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
  const { data: trackers } = useQuery<Tracker[]>({
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
  const monthlyIncome = incomes.reduce((s: number, i: any) => s + (i.amount || 0), 0);
  const monthlySpend = snap?.totalMonthlySpend ?? stats?.monthlySpend;
  const cashFlow = monthlySpend != null
    ? monthlyIncome - (monthlySpend + (snap?.monthlyObligationTotal ?? 0))
    : null;

  const health = trackers ? computeHealthScore(trackers) : null;

  const streak = stats
    ? Math.max(0, ...(stats.streaks || []).map(s => s.days || 0), stats.journalStreak || 0)
    : null;

  const tasksDue = stats?.activeTasks;
  const tasksLate: number = (enhanced?.overdueTasks || []).length;

  const expDocs: any[] = enhanced?.expiringDocuments || [];
  const minDocDays = expDocs.length > 0
    ? Math.min(...expDocs.map((d: any) => (typeof d.daysUntil === "number" ? d.daysUntil : Infinity)))
    : null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar" data-testid="hub-kpi-strip">
      <StatChip
        label="Net Worth"
        value={netWorth == null ? "—" : `${netWorth < 0 ? "-" : ""}${fmtMoney(netWorth)}`}
        accent={netWorth != null && netWorth < 0 ? "neg" : undefined}
        onClick={() => navigate("/dashboard/finance")}
        testId="hub-kpi-networth"
      />
      <StatChip
        label="Cash Flow"
        value={cashFlow == null ? "—" : `${cashFlow >= 0 ? "+" : "-"}${fmtMoney(cashFlow)}`}
        accent={cashFlow == null ? undefined : cashFlow >= 0 ? "pos" : "neg"}
        onClick={() => navigate("/dashboard/finance")}
        testId="hub-kpi-cashflow"
      />
      <StatChip
        label="Health"
        value={health == null ? "—" : String(health)}
        accent={health != null && health >= 70 ? "pos" : health != null && health < 45 ? "warn" : undefined}
        onClick={() => navigate("/health")}
        testId="hub-kpi-health"
      />
      <StatChip
        label="Streak"
        value={streak == null ? "—" : `${streak}D`}
        sub={streak != null && streak > 0 ? "★" : undefined}
        subTone="warn"
        onClick={() => navigate("/habits")}
        testId="hub-kpi-streak"
      />
      <StatChip
        label="Tasks Due"
        value={tasksDue == null ? "—" : String(tasksDue)}
        sub={tasksLate > 0 ? `${tasksLate} late` : undefined}
        subTone="neg"
        onClick={() => navigate("/tasks")}
        testId="hub-kpi-tasks"
      />
      <StatChip
        label="Docs Exp"
        value={String(expDocs.length)}
        sub={minDocDays != null && isFinite(minDocDays) ? (minDocDays < 0 ? "overdue" : `≤${minDocDays}d`) : undefined}
        subTone={minDocDays != null && minDocDays < 0 ? "neg" : "warn"}
        onClick={() => navigate("/linked?tab=documents")}
        testId="hub-kpi-docs"
      />
    </div>
  );
}
