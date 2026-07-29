// client/src/lib/page-title.ts — One mapping from "where am I" to "what is
// this page called".
//
// Five routes render TrackersPage: /trackers, /linked, /liabilities, /assets
// and /documents. Two different places decided what the browser tab said about
// them, and they disagreed:
//
//   App.tsx <RouteTitle>   a path → title map, run on every location change
//   trackers.tsx           an effect that set "Linked" for /linked and
//                          "Trackers" for literally everything else
//
// TrackersPage mounted second and won. That is why the Liabilities page's tab
// read "Trackers" during the audit (finding P3), and why adding /assets and
// /documents to the route map alone did nothing — the page stomped the title
// a beat later. A static check that the map contained the right entries passed
// while the running app still showed the wrong name.
//
// So the section is the single truth: it is what the page actually displays,
// it survives the user switching tabs without changing the route, and both
// title writers now derive from it.

/** The sections TrackersPage can display. Mirrors its `sectionFilter`. */
export type HubSection = "all" | "profiles" | "liabilities" | "documents" | "trackers";

/**
 * Browser-tab titles. "Linked" is deliberately absent: it named a route, not
 * a place the user was ever taught, and it was applied to two different pages.
 */
const SECTION_TITLE: Record<HubSection, string> = {
  all: "Assets & Documents",
  profiles: "Assets",
  liabilities: "Debts",
  documents: "Documents",
  trackers: "Trackers",
};

export function titleForSection(section: HubSection): string {
  return `${SECTION_TITLE[section] ?? "Portol"} — Portol`;
}

/**
 * The section a bare route displays before any `?tab=` is applied.
 *
 * `/assets` and `/documents` are real routes precisely so they can be typed,
 * bookmarked and shared; they used to exist only as `/linked?tab=…`.
 */
export function sectionForPath(path: string): HubSection {
  const p = (path || "").toLowerCase();
  if (p.startsWith("/trackers") || p.startsWith("/dashboard/health") || p.startsWith("/health")) return "trackers";
  if (p.startsWith("/liabilities")) return "liabilities";
  if (p.startsWith("/assets")) return "profiles";
  if (p.startsWith("/documents")) return "documents";
  return "all";
}

/** The section named by a `?tab=` query, or null when it names none. */
export function sectionForQuery(query: string | null | undefined): HubSection | null {
  if (!query) return null;
  let tab: string | null = null;
  try {
    tab = new URLSearchParams(query.replace(/^\?/, "")).get("tab");
  } catch {
    return null;
  }
  if (!tab) return null;
  // The nav has always written ?tab=assets for the section the page calls
  // "profiles"; keep honouring both spellings.
  if (tab === "assets") return "profiles";
  if (["all", "trackers", "documents", "liabilities", "profiles"].includes(tab)) return tab as HubSection;
  return null;
}

/**
 * The section a full location resolves to — query wins over path, matching
 * TrackersPage's own precedence.
 */
export function sectionForLocation(location: string): HubSection {
  const [path, query] = String(location || "/").split("?");
  return sectionForQuery(query) ?? sectionForPath(path);
}

/** True when this location is one TrackersPage owns the title for. */
export function isSectionRoute(location: string): boolean {
  const path = String(location || "/").split("?")[0].replace(/\/+$/, "") || "/";
  return ["/trackers", "/linked", "/liabilities", "/assets", "/documents"].includes(path);
}
