// ── Hub shell ────────────────────────────────────────────────────────────────
// The persistent chrome of the unified hub (Dashboard + Profiles + Linked
// consolidation): date line + profile switcher, KPI stat strip, and the chip
// tab row. Mounted ONCE by App.tsx (outside AppRouter's <Suspense>) whenever
// isHubRoute(location) — it persists across tab switches and lazy-chunk loads,
// so the strip never flickers while a page chunk streams in.
//
// Tabs NAVIGATE between existing routes (see hub-routes.ts) — the shell holds
// no page state, and removing it reverts the app to the pre-hub behavior.
import { useEffect } from "react";
import { useLocation } from "wouter";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
// hashNavigate (NOT wouter navigate) — tab routes carry queries ("/linked?tab=assets")
// and wouter's hash navigate hoists the query OUT of the hash ("?tab=assets#/linked"),
// where trackers.tsx getQuerySection would never see it on subsequent in-hash navs.
import { hashNavigate, hashReplace } from "@/lib/hashNavigate";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useResumeTick } from "@/hooks/useResumeTick";
import { HUB_TABS, activeHubTab, infoTabRoute, reconcileInfoRoute } from "./hub-routes";
import { HubKpiStrip } from "./HubKpiStrip";
import { HubProfileSwitcher } from "./HubProfileSwitcher";

export function HubShell() {
  const [location] = useLocation();
  const scope = useProfileScope();
  const active = activeHubTab(location, [...scope.selectedIds]);

  // PROFILE-SCOPE RECONCILIATION. Info is the only tab whose route embeds a
  // profile id, so switching the scope (e.g. to Everyone) left the user staring
  // at the previously-selected profile's personal details while every other tab
  // re-aggregated. Correct the URL instead of rendering a stale scope. Replace,
  // don't push, so Back doesn't bounce between the two.
  const selectedKey = [...scope.selectedIds].join(",");
  useEffect(() => {
    const target = reconcileInfoRoute(location, [...scope.selectedIds]);
    if (target) hashReplace(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, selectedKey]);

  // STALE-CLOCK FIX (2026-07-21): re-render once per resume-after-long-absence
  // so the date line rolls over. Without this, a PWA frozen overnight kept
  // showing yesterday's date ("Monday, July 20" on Tuesday) because nothing
  // ever re-rendered this component after resume.
  useResumeTick();
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
      <div className="flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-2 [mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]" role="tablist" aria-label="Hub sections">
        {HUB_TABS.map(tab => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              data-testid={`hub-tab-${tab.id}`}
              onClick={() => hashNavigate(tab.id === "info" ? infoTabRoute([...scope.selectedIds]) : tab.route)}
              className={`shrink-0 rounded-full px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold transition-colors ${
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
