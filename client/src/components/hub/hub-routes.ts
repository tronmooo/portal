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

import { isProfileTabSlug } from "@/lib/profile-tab-slugs";

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
  /** The tab's identity colour as an HSL triple (`H S% L%`, no wrapper).
   *
   *  One place, so a tab is the same colour everywhere it appears. Documents
   *  orange used to be written out independently in three files — the section
   *  header in trackers.tsx, the doc-type map, and the KPI chip — and they
   *  drifted. HubShell publishes the active tab's value as `--tab-accent`, so
   *  the chip, the headings and the cards on that page all read one variable. */
  accent: string;
}

export const HUB_TABS: HubTab[] = [
  { id: "executive",   label: "Executive",   route: "/dashboard",              accent: "262 70% 62%" },
  { id: "trackers",    label: "Trackers",    route: "/trackers",               accent: "173 60% 44%" },
  { id: "finance",     label: "Finance",     route: "/dashboard/finance",      accent: "155 65% 45%" },
  { id: "wellness",    label: "Wellness",    route: "/wellness",               accent: "0 72% 58%" },
  { id: "assets",      label: "Assets",      route: "/linked?tab=assets",      accent: "262 60% 62%" },
  { id: "liabilities", label: "Liabilities", route: "/liabilities",            accent: "0 72% 55%" },
  { id: "documents",   label: "Documents",   route: "/linked?tab=documents",   accent: "25 80% 54%" },
  { id: "info",        label: "Info",        route: "/profiles",               accent: "213 90% 62%" },
];

/** The active tab's accent, or the app's default when no chip is lit (a deep
 *  profile page). Never returns undefined, so callers can set it blindly. */
export function hubTabAccent(id: HubTabId | null): string {
  return HUB_TABS.find(t => t.id === id)?.accent ?? "213 90% 62%";
}

/** Info tab target: the selected profile's lightweight Info page when exactly
 *  one profile is selected; otherwise the People grid. (User decision
 *  2026-07-08: Info is a quick reference, distinct from the deep /profiles/:id
 *  page.) */
export function infoTabRoute(selectedIds: string[]): string {
  return selectedIds.length === 1 ? `/profiles/${selectedIds[0]}/info` : "/profiles";
}

/**
 * The Info route the current location SHOULD be, or null when it's already
 * correct. Every other hub tab has a fixed route that re-reads the profile
 * scope on render, so switching to "Everyone" re-aggregates them. Info is the
 * exception — its route embeds a profile id — so nothing moved the user off
 * `/profiles/<someone>/info` when the scope changed underneath them.
 *
 * QA report 2026-07-25: "'Everyone -> Info' displayed only the Test profile's
 * personal information instead of an Everyone summary or list of people. Other
 * tabs aggregate profiles, but Info behaves like the self profile remained
 * selected."
 *
 * Returns null for any non-Info location, so callers can apply it blindly.
 */
export function reconcileInfoRoute(location: string, selectedIds: string[] = []): string | null {
  const { path } = splitLocation(location);
  const infoMatch = path.match(/^\/profiles\/([^/]+)\/info$/);
  if (!infoMatch) return null;
  const target = infoTabRoute(selectedIds);
  if (target === path) return null;
  return target;
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
  // The profiles index is a plain list, not a profile — no hub chrome.
  if (path === "/profiles/list") return false;
  // Profile detail pages (people, assets, liabilities) + any tab deep-link
  // (/profiles/:id/finance, …) keep the hub chrome so every profile feels like
  // its own dashboard. A non-tab second segment is not a profile route.
  const sub = path.match(/^\/profiles?\/[^/]+(?:\/([^/]+))?$/);
  if (!sub) return false;
  return sub[1] === undefined || isProfileTabSlug(sub[1]);
}

/** Nav active-state helper: the single "Dashboard" nav item lights up for any
 *  hub location (sidebar, mobile bottom nav, SwipeNav). */
export function isHubLocationForNav(location: string): boolean {
  return isHubRoute(location);
}
