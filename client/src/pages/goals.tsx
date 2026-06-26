import { useMemo } from "react";
import { ArrowLeft, Target, AlertTriangle, Flame, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileScope } from "@/hooks/useProfileScope";
import { GoalsSection } from "@/pages/dashboard";
import { goalsQueryKey } from "@shared/query-keys";
import { apiRequest } from "@/lib/queryClient";

export default function GoalsPage() {
  // Single source of truth: read the active scope reactively instead of
  // mirroring it into local state via the chip's onChange.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();

  // When "everyone", pass no ids so GoalsSection shows every profile's goals.
  const ids = filterMode === "everyone" ? [] : filterIds;
  const profileParam = ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";

  // Reads the SAME cache slot GoalsSection uses (goalsQueryKey) — deduped, no
  // extra request — just to compute the v2 summary header.
  const { data: goals = [] } = useQuery<any[]>({
    queryKey: goalsQueryKey(ids),
    queryFn: () => apiRequest("GET", `/api/goals${profileParam}`).then(r => r.json()),
  });

  const summary = useMemo(() => {
    const now = Date.now();
    let active = 0, completed = 0, overdue = 0, atRisk = 0, pctSum = 0, pctCount = 0;
    for (const g of (Array.isArray(goals) ? goals : [])) {
      const status = String(g.status || "").toLowerCase();
      const pct = Number(g.target) > 0 ? Math.min(100, (Number(g.current) || 0) / Number(g.target) * 100) : 0;
      if (status === "completed" || pct >= 100) { completed++; continue; }
      if (status === "abandoned") continue;
      active++; pctSum += pct; pctCount++;
      const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - now) / 86400000) : null;
      if (daysLeft != null && daysLeft < 0 && pct < 100) overdue++;
      else if (daysLeft != null && daysLeft <= 14 && pct < 50) atRisk++;
    }
    return { active, completed, overdue, atRisk, avg: pctCount ? Math.round(pctSum / pctCount) : 0 };
  }, [goals]);

  const chips = [
    { label: "Active", value: summary.active, color: "262 70% 62%", Icon: Target },
    { label: "At risk", value: summary.atRisk, color: "43 85% 52%", Icon: AlertTriangle },
    { label: "Overdue", value: summary.overdue, color: "0 72% 55%", Icon: Flame },
    { label: "Done", value: summary.completed, color: "155 60% 48%", Icon: CheckCircle2 },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full pb-24" data-testid="page-goals">
      {/* v2 header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
            aria-label="Back"
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold flex-1">Goals</h1>
        <MultiProfileFilter onChange={() => {}} compact />
      </div>

      {/* v2 summary header — overall progress + status breakdown */}
      <div className="rounded-2xl border border-border/50 bg-card/60 p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Overall progress</p>
          <p className="text-sm font-bold tabular-nums" style={{ color: "hsl(262 70% 62%)" }}>{summary.avg}%</p>
        </div>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-muted/60">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${summary.avg}%`, background: "hsl(262 70% 62%)" }} />
        </div>
        <div className="grid grid-cols-4 gap-2">
          {chips.map(({ label, value, color, Icon }) => (
            <div key={label} className="flex flex-col items-center rounded-xl border border-border/40 py-2">
              <Icon className="mb-1 h-4 w-4" style={{ color: `hsl(${color})` }} />
              <span className="text-base font-bold tabular-nums leading-none">{value}</span>
              <span className="mt-0.5 text-[9px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <GoalsSection profileIds={ids} />
    </div>
  );
}
