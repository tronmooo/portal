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

/** Every location that shows the Info tab, in any of its spellings:
 *  the single-profile page, the combined "everyone" page, and the
 *  `/linked?tab=info` deep-link a user can type or bookmark.
 *
 *  `/linked?tab=info` is NOT a section trackers.tsx knows (getQuerySection
 *  accepts all|trackers|documents|liabilities|assets), so it silently fell
 *  through to the unfiltered "All" list — a different screen from the Info
 *  chip, with the profile scope apparently ignored. QA report 2026-08-05.
 *  Treating it as an Info location routes both spellings to one destination. */
export function isInfoLocation(location: string): boolean {
  const { path, query } = splitLocation(location);
  if (path === "/profiles") return true;
  if (/^\/profiles\/[^/]+\/info$/.test(path)) return true;
  if (path === "/linked" && (query.get("tab") || "").toLowerCase() === "info") return true;
  return false;
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
 * INVARIANT — this is the ONLY thing allowed to redirect an Info location.
 * It is a fixpoint: applying it to its own output always returns null
 * (`infoTabRoute(ids)` is the one target for a scope, and both Info paths are
 * recognised above). The Info PAGE must therefore never navigate on its own.
 * It used to: `/profiles` redirected to the Self profile's Info page while this
 * function redirected `/profiles/<self>/info` back to `/profiles` whenever the
 * scope wasn't exactly one person. The two bounced off each other forever —
 * React error #185, "Maximum update depth exceeded", a white-screen crash on
 * every switch to Everyone from an Info page (QA report 2026-08-05).
 *
 * Returns null for any non-Info location, so callers can apply it blindly.
 *
 * `scopeChanged` (default true) says WHY we're reconciling. The rewrite above
 * exists for scope-follows-URL staleness: the scope moved and the location
 * still names the old person. When only the LOCATION changed — the user
 * clicked a person card on the Everyone grid, or opened a deep link — the URL
 * is their explicit intent, and a person who is in scope must open. Without
 * that distinction, every card on the Everyone people grid bounced straight
 * back to the grid (QA run 002, B12). A person OUTSIDE the scope reconciles
 * either way.
 */
export function reconcileInfoRoute(
  location: string,
  selectedIds: string[] = [],
  opts: { scopeChanged?: boolean } = {},
): string | null {
  if (!isInfoLocation(location)) return null;
  const { path } = splitLocation(location);
  // /profiles is correct under EVERY scope: it renders the people in scope, and
  // it is what "Go to Profiles", the People stat card and every "back to
  // profiles" link mean. Redirecting it to the selected person's page would
  // send all of them into one person's Info page instead of the list — and the
  // default scope is a single profile (initDefaultProfileFilter seeds Self), so
  // that would be nearly always.
  if (path === "/profiles") return null;
  const person = path.match(/^\/profiles\/([^/]+)\/info$/)?.[1];
  const inScope = !!person && (selectedIds.length === 0 || selectedIds.includes(person));
  if (inScope && opts.scopeChanged === false) return null;
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
    // ?tab=info is redirected to the real Info route (reconcileInfoRoute); light
    // its chip for the frame before that lands rather than flashing no chip.
    if (tab === "info") return "info";
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
