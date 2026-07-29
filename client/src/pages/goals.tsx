import { useMemo } from "react";
import { Target, AlertTriangle, Flame, CheckCircle2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { useQuery } from "@tanstack/react-query";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileScope } from "@/hooks/useProfileScope";
import { GoalsSection } from "@/pages/dashboard";
import { goalsQueryKey } from "@shared/query-keys";
import { goalProgress, goalStatus } from "@shared/goal-progress";
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
      // Direction-aware progress and one shared status rule. The old
      // `current / target` ratio ran a weight-loss goal backwards to >= 100%,
      // which counted it as completed and `continue`d past the overdue branch
      // — so these tiles reported "0 Overdue" directly above a section headed
      // "OVERDUE — ACTION NEEDED (1)" (audit findings U3 and D2).
      const { percent: pct } = goalProgress(g);
      const state = goalStatus(g, now);
      if (state === "complete") { completed++; continue; }
      if (status === "abandoned") continue;
      active++; pctSum += pct; pctCount++;
      const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - now) / 86400000) : null;
      if (state === "overdue") overdue++;
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
    <PageContainer width="5xl" testId="page-goals">
      <PageHeader title="Goals" icon={Target} accent="262 70% 62%" backHref="/dashboard"
        actions={<MultiProfileFilter onChange={() => {}} compact />} />

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
    </PageContainer>
  );
}
