// ── Hub tab ↔ route mapping (pure, no React) ────────────────────────────────
// The unified hub (Dashboard + Profiles + Linked consolidation, 2026-07) is a
// persistent shell over EXISTING routes — tabs navigate, they don't hold page
// state. This module is the single source of truth for which locations count
// as "inside the hub" and which chip is active. Unit-tested in
// tests/hub-routes.test.ts.
//
// HARD RULE: nothing under components/hub/ may import from @/pages/* — the
// shell is eagerly mounted in App.tsx; a page import would drag a 7k-line
// lazy chunk into the main bundle. (Guard test enforces this.)

export type HubTabId =
  | "executive"
  | "trackers"
  | "finance"
  | "health"
  | "assets"
  | "liabilities"
  | "documents"
  | "info";

export interface HubTab {
  id: HubTabId;
  label: string;
  /** Default navigation target. The Info tab's real target depends on the
   *  current profile selection — use infoTabRoute() instead. */
  route: string;
}

export const HUB_TABS: HubTab[] = [
  { id: "executive",   label: "Executive",   route: "/dashboard" },
  { id: "trackers",    label: "Trackers",    route: "/trackers" },
  { id: "finance",     label: "Finance",     route: "/dashboard/finance" },
  { id: "health",      label: "Health",      route: "/health" },
  { id: "assets",      label: "Assets",      route: "/linked?tab=assets" },
  { id: "liabilities", label: "Liabilities", route: "/liabilities" },
  { id: "documents",   label: "Documents",   route: "/linked?tab=documents" },
  { id: "info",        label: "Info",        route: "/profiles" },
];

/** Info tab target: the selected profile's own page when exactly one profile
 *  is selected; otherwise the People grid. (User decision 2026-07-08.) */
export function infoTabRoute(selectedIds: string[]): string {
  return selectedIds.length === 1 ? `/profiles/${selectedIds[0]}` : "/profiles";
}

function splitLocation(location: string): { path: string; query: URLSearchParams } {
  const [rawPath, rawQuery] = (location || "/").split("?");
  const path = (rawPath.replace(/\/+$/, "") || "/");
  return { path, query: new URLSearchParams(rawQuery || "") };
}

/** Which chip is active for a location. `selectedIds` disambiguates the Info
 *  tab: /profiles/:id is Info only when :id is the single selected profile —
 *  visiting some other asset/liability profile shows the shell with no chip lit. */
export function activeHubTab(location: string, selectedIds: string[] = []): HubTabId | null {
  const { path, query } = splitLocation(location);

  if (path === "/dashboard") return "executive";
  if (path === "/trackers") return "trackers";
  if (path === "/dashboard/finance" || path === "/finance") return "finance";
  if (path === "/health" || path === "/dashboard/health") return "health";
  if (path === "/liabilities") return "liabilities";
  if (path === "/profiles") return "info";

  if (path === "/linked") {
    // trackers.tsx getQuerySection contract: ?tab= selects the section.
    const tab = (query.get("tab") || "").toLowerCase();
    if (tab === "assets" || tab === "profiles") return "assets";
    if (tab === "documents") return "documents";
    if (tab === "trackers") return "trackers";
    if (tab === "liabilities") return "liabilities";
    return null; // plain /linked = the legacy "All" view — no chip active
  }

  const detail = path.match(/^\/profiles?\/([^/]+)$/);
  if (detail) {
    return selectedIds.length === 1 && detail[1] === selectedIds[0] ? "info" : null;
  }

  return null;
}

/** Locations where the hub shell (KPI strip + switcher + chips) renders.
 *  Deliberately NOT all /dashboard/* sub-pages — tasks/journal/habits/bills
 *  keep standalone chrome in v1. */
export function isHubRoute(location: string): boolean {
  const { path } = splitLocation(location);
  if (
    path === "/dashboard" ||
    path === "/dashboard/finance" ||
    path === "/dashboard/health" ||
    path === "/finance" ||
    path === "/trackers" ||
    path === "/linked" ||
    path === "/liabilities" ||
    path === "/health" ||
    path === "/profiles"
  ) return true;
  // Profile detail pages (people, assets, liabilities) keep the hub chrome so
  // every profile feels like its own dashboard.
  return /^\/profiles?\/[^/]+$/.test(path);
}

/** Nav active-state helper: the single "Dashboard" nav item lights up for any
 *  hub location (sidebar, mobile bottom nav, SwipeNav). */
export function isHubLocationForNav(location: string): boolean {
  return isHubRoute(location);
}
