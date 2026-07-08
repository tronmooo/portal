// ── Hub shell ────────────────────────────────────────────────────────────────
// The persistent chrome of the unified hub (Dashboard + Profiles + Linked
// consolidation): date line + profile switcher, KPI stat strip, and the chip
// tab row. Mounted ONCE by App.tsx (outside AppRouter's <Suspense>) whenever
// isHubRoute(location) — it persists across tab switches and lazy-chunk loads,
// so the strip never flickers while a page chunk streams in.
//
// Tabs NAVIGATE between existing routes (see hub-routes.ts) — the shell holds
// no page state, and removing it reverts the app to the pre-hub behavior.
import { useLocation } from "wouter";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import { HUB_TABS, activeHubTab, infoTabRoute } from "./hub-routes";
import { HubKpiStrip } from "./HubKpiStrip";
import { HubProfileSwitcher } from "./HubProfileSwitcher";

export function HubShell() {
  const [location, navigate] = useLocation();
  const scope = useProfileScope();
  const active = activeHubTab(location, [...scope.selectedIds]);

  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: BROWSER_TIMEZONE,
  });

  return (
    <div className="shrink-0 border-b border-border/50 bg-background/95 px-3 md:px-6 pt-2 pb-0 space-y-2" data-testid="hub-shell">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground truncate" data-testid="hub-date">{dateLabel}</span>
        <HubProfileSwitcher />
      </div>
      <HubKpiStrip />
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-2" role="tablist" aria-label="Hub sections">
        {HUB_TABS.map(tab => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              data-testid={`hub-tab-${tab.id}`}
              onClick={() => navigate(tab.id === "info" ? infoTabRoute([...scope.selectedIds]) : tab.route)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
