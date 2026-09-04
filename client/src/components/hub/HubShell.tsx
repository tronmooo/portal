// ── Hub shell ────────────────────────────────────────────────────────────────
// The persistent chrome of the unified hub (Dashboard + Profiles + Linked
// consolidation): date line + profile switcher, KPI stat strip, and the chip
// tab row. Mounted ONCE by App.tsx (outside AppRouter's <Suspense>) whenever
// isHubRoute(location) — it persists across tab switches and lazy-chunk loads,
// so the strip never flickers while a page chunk streams in.
//
// Tabs NAVIGATE between existing routes (see hub-routes.ts) — the shell holds
// no page state, and removing it reverts the app to the pre-hub behavior.
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
// hashNavigate (NOT wouter navigate) — tab routes carry queries ("/linked?tab=assets")
// and wouter's hash navigate hoists the query OUT of the hash ("?tab=assets#/linked"),
// where trackers.tsx getQuerySection would never see it on subsequent in-hash navs.
import { hashNavigate, hashReplace } from "@/lib/hashNavigate";
import { useProfileScope } from "@/hooks/useProfileScope";
import { prefetchScopeBootstrap } from "@/lib/scope-prefetch";
import { preloadHubTabChunk } from "@/lib/navigation-prefetch";
import { useResumeTick } from "@/hooks/useResumeTick";
import { useOverflowX } from "@/hooks/useOverflowX";
import { HUB_TABS, activeHubTab, hubTabAccent, infoTabRoute, reconcileInfoRoute } from "./hub-routes";
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
  // Only a SCOPE change corrects the URL. Running this on every location
  // change too meant that opening any person's Info page (from search, the
  // bell, the people grid, a link) while scoped to someone else was replaced
  // at once by the scoped person's page — every person but the selected one
  // was unreachable, and the dispatcher deliberately does not repoint the
  // scope when a person is opened.
  const selectedKey = [...scope.selectedIds].join(",");
  const lastSelectedKey = useRef(selectedKey);
  useEffect(() => {
    if (lastSelectedKey.current === selectedKey) return;
    lastSelectedKey.current = selectedKey;
    const target = reconcileInfoRoute(location, [...scope.selectedIds]);
    if (target) hashReplace(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, selectedKey]);

  // ONE REQUEST PER SCOPE (2026-09-04). Only the Executive tab fetched
  // /api/dashboard-bootstrap; the KPI strip issues no requests by design and
  // every other tab read the slots the bootstrap seeds. So a reload or deep
  // link onto Assets / Finance / Wellness never fired the bootstrap at all:
  // the strip sat on "…" and each tab paid its own cold serverless round-trip
  // for lists the bootstrap already returns. The shell is the one component
  // mounted for every hub route, so it owns that request now — on mount and
  // on every scope change. Tabs then paint from the seeded cache (their own
  // queries join this in-flight request, see seededQueryFn) and the Executive
  // page's identical useQuery collapses onto it too.
  useEffect(() => {
    void prefetchScopeBootstrap(scope.mode, [...scope.selectedIds]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // STALE-CLOCK FIX (2026-07-21): re-render once per resume-after-long-absence
  // so the date line rolls over. Without this, a PWA frozen overnight kept
  // showing yesterday's date ("Monday, July 20" on Tuesday) because nothing
  // ever re-rendered this component after resume.
  useResumeTick();
  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: BROWSER_TIMEZONE,
  });

  const [tabsRef, tabsClipped] = useOverflowX<HTMLDivElement>([]);

  return (
    // --tab-accent is published here and read by the tab chip, the KPI strip's
    // underline, and every SectionHeading on the page below. One variable, so a
    // tab is one colour instead of three files each picking their own.
    <div
      className="shrink-0 border-b border-border/50 bg-background/95 px-3 md:px-6 pt-2 pb-0 space-y-2"
      style={{ ["--tab-accent" as any]: hubTabAccent(active) }}
      data-testid="hub-shell"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground truncate" data-testid="hub-date">{dateLabel}</span>
        <HubProfileSwitcher />
      </div>
      <HubKpiStrip />
      {/* The right-edge fade means "there are more tabs this way", so it only
          belongs here when there actually are — on a desktop all eight fit. */}
      <div
        ref={tabsRef}
        className={`flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-2 ${
          tabsClipped ? "[mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]" : ""
        }`}
        role="tablist"
        aria-label="Hub sections"
      >
        {HUB_TABS.map(tab => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              data-testid={`hub-tab-${tab.id}`}
              onClick={() => hashNavigate(tab.id === "info" ? infoTabRoute([...scope.selectedIds]) : tab.route)}
              // Warm the destination's JavaScript while the pointer is still
              // on its way: a first tab open no longer waits on a chunk
              // download on top of its data. Best-effort, idempotent.
              onPointerEnter={() => preloadHubTabChunk(tab.id)}
              onPointerDown={() => preloadHubTabChunk(tab.id)}
              onTouchStart={() => preloadHubTabChunk(tab.id)}
              onFocus={() => preloadHubTabChunk(tab.id)}
              // The active chip wears the tab's own colour rather than one
              // app-wide primary, so the strip tells you where you are at a
              // glance and agrees with the page it opens.
              style={isActive ? {
                background: `hsl(${tab.accent} / 0.16)`,
                color: `hsl(${tab.accent})`,
                boxShadow: `inset 0 0 0 1px hsl(${tab.accent} / 0.35)`,
              } : undefined}
              className={`pressable shrink-0 rounded-full px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                isActive ? "" : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
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
