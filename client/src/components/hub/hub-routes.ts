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
  | "wellness"
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
  { id: "wellness",    label: "Wellness",    route: "/wellness" },
  { id: "assets",      label: "Assets",      route: "/linked?tab=assets" },
  { id: "liabilities", label: "Liabilities", route: "/liabilities" },
  { id: "documents",   label: "Documents",   route: "/linked?tab=documents" },
  { id: "info",        label: "Info",        route: "/profiles" },
];

/** Info tab target: the selected profile's lightweight Info page when exactly
 *  one profile is selected; otherwise the People grid. (User decision
 *  2026-07-08: Info is a quick reference, distinct from the deep /profiles/:id
 *  page.) */
export function infoTabRoute(selectedIds: string[]): string {
  return selectedIds.length === 1 ? `/profiles/${selectedIds[0]}/info` : "/profiles";
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
  if (path === "/wellness" || path === "/health" || path === "/dashboard/health") return "wellness";
  if (path === "/liabilities") return "liabilities";
  if (path === "/profiles") return "info";

  // Lightweight Info page for a specific profile.
  const infoMatch = path.match(/^\/profiles\/([^/]+)\/info$/);
  if (infoMatch) {
    return selectedIds.length === 1 && infoMatch[1] === selectedIds[0] ? "info" : null;
  }

  if (path === "/linked") {
    // trackers.tsx getQuerySection contract: ?tab= selects the section.
    const tab = (query.get("tab") || "").toLowerCase();
    if (tab === "assets" || tab === "profiles") return "assets";
    if (tab === "documents") return "documents";
    if (tab === "trackers") return "trackers";
    if (tab === "liabilities") return "liabilities";
    return null; // plain /linked = the legacy "All" view — no chip active
  }

  // The deep profile page (/profiles/:id, /profile/:id) shows the hub shell but
  // lights NO chip — the Info chip points at the lightweight /profiles/:id/info
  // page handled above.
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
    path === "/wellness" ||
    path === "/profiles"
  ) return true;
  // Profile detail pages (people, assets, liabilities) + the lightweight Info
  // page keep the hub chrome so every profile feels like its own dashboard.
  return /^\/profiles?\/[^/]+(\/info)?$/.test(path);
}

/** Nav active-state helper: the single "Dashboard" nav item lights up for any
 *  hub location (sidebar, mobile bottom nav, SwipeNav). */
export function isHubLocationForNav(location: string): boolean {
  return isHubRoute(location);
}
