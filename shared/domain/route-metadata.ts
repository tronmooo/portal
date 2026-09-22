// shared/domain/route-metadata.ts — one table of routes, titles and labels.
//
// The tab title was set by a map in App.tsx AND by a useEffect in each of 24
// pages, with different strings; three routes (/trackers, /linked,
// /liabilities) rendered one component that titled itself "Linked — Portol"
// when the user was looking at Assets or Documents. This is the one route
// metadata map: route → page title, navigation label, breadcrumb, canonical
// path — and the ?tab= contract of the hub routes is honoured here.
//
// Pure. Pinned by tests/consistency-layer-routes.test.ts.

export const APP_NAME = "Portol";
export const TITLE_SEPARATOR = " — ";

export interface RouteMeta {
  /** wouter pattern or exact path. */
  route: string;
  /** "Assets" — the tab title without the app suffix. */
  pageTitle: string;
  navigationLabel: string;
  breadcrumb: string[];
  /** Where a link to this section should point. */
  canonicalPath: string;
  section: "chat" | "dashboard" | "calendar" | "money" | "life" | "documents" | "profiles" | "settings" | "public";
}

const R = (route: string, pageTitle: string, canonicalPath: string, section: RouteMeta["section"], breadcrumb: string[] = [pageTitle], navigationLabel = pageTitle): RouteMeta =>
  ({ route, pageTitle, navigationLabel, breadcrumb, canonicalPath, section });

export const ROUTE_METADATA: readonly RouteMeta[] = [
  R("/chat", "Chat", "/chat", "chat"),
  R("/dashboard", "Dashboard", "/dashboard", "dashboard"),
  R("/dashboard/executive", "Dashboard", "/dashboard", "dashboard"),
  R("/dashboard/daily", "Daily", "/dashboard/daily", "dashboard", ["Dashboard", "Daily"]),
  R("/trackers", "Trackers", "/trackers", "life"),
  R("/liabilities", "Liabilities", "/liabilities", "money"),
  R("/finance", "Finance", "/finance", "money"),
  R("/dashboard/finance", "Finance", "/finance", "money"),
  R("/wellness", "Wellness", "/wellness", "life"),
  R("/health", "Wellness", "/wellness", "life"),
  R("/dashboard/health", "Wellness", "/wellness", "life"),
  R("/habits", "Habits", "/habits", "life"),
  R("/dashboard/habits", "Habits", "/habits", "life"),
  R("/journal", "Journal", "/journal", "life"),
  R("/dashboard/journal", "Journal", "/journal", "life"),
  R("/tasks", "Tasks", "/tasks", "life"),
  R("/dashboard/tasks", "Tasks", "/tasks", "life"),
  R("/goals", "Goals", "/goals", "life"),
  R("/dashboard/goals", "Goals", "/goals", "life"),
  R("/bills", "Bills", "/bills", "money"),
  R("/obligations", "Bills", "/bills", "money"),
  R("/dashboard/obligations", "Bills", "/bills", "money"),
  R("/artifacts", "Artifacts", "/artifacts", "documents"),
  R("/dashboard/artifacts", "Artifacts", "/artifacts", "documents"),
  R("/dashboard/documents", "Documents", "/linked?tab=documents", "documents"),
  R("/calendar", "Calendar", "/calendar", "calendar"),
  R("/insights", "Insights", "/insights", "dashboard"),
  R("/profiles", "Info", "/profiles", "profiles", ["Profiles", "Info"]),
  R("/profiles/list", "Profiles", "/profiles/list", "profiles"),
  R("/settings", "Settings", "/settings", "settings"),
  R("/privacy", "Privacy Policy", "/privacy", "public"),
  R("/terms", "Terms of Service", "/terms", "public"),
  R("/reset-password", "Reset Password", "/reset-password", "public"),
];

/** The hub's `/linked?tab=` contract, and what each tab is called. */
export const LINKED_TAB_TITLES: Record<string, { pageTitle: string; canonicalPath: string; section: RouteMeta["section"] }> = {
  assets:      { pageTitle: "Assets",      canonicalPath: "/linked?tab=assets",      section: "money" },
  profiles:    { pageTitle: "Assets",      canonicalPath: "/linked?tab=assets",      section: "money" },
  documents:   { pageTitle: "Documents",   canonicalPath: "/linked?tab=documents",   section: "documents" },
  trackers:    { pageTitle: "Trackers",    canonicalPath: "/trackers",               section: "life" },
  liabilities: { pageTitle: "Liabilities", canonicalPath: "/liabilities",            section: "money" },
  info:        { pageTitle: "Info",        canonicalPath: "/profiles",               section: "profiles" },
};

function splitLocation(location: string): { path: string; params: URLSearchParams } {
  const [rawPath, query = ""] = String(location || "").split("?");
  const path = rawPath.replace(/\/+$/, "") || "/";
  return { path, params: new URLSearchParams(query) };
}

/**
 * Metadata for a location. Dynamic routes (`/profiles/:id`, `/documents/:id`,
 * `/editor/:id`, `/share/:token`) resolve to their section's generic title;
 * the caller may refine it with `dynamicTitle` once the record has loaded.
 */
export function routeMetaFor(location: string): RouteMeta {
  const { path, params } = splitLocation(location);
  if (path === "/linked") {
    const tab = String(params.get("tab") || "").toLowerCase();
    const t = LINKED_TAB_TITLES[tab];
    if (t) return R(path, t.pageTitle, t.canonicalPath, t.section, [t.pageTitle]);
    return R(path, "Linked", "/linked", "life");
  }
  const exact = ROUTE_METADATA.find((r) => r.route === path);
  if (exact) return exact;
  if (/^\/profiles\/[^/]+\/info$/.test(path)) return R(path, "Info", path, "profiles", ["Profiles", "Info"]);
  if (/^\/(profiles|profile)\/[^/]+/.test(path)) return R(path, "Profile", path, "profiles", ["Profiles", "Profile"]);
  if (/^\/documents\/[^/]+\/review$/.test(path)) return R(path, "Review Document", path, "documents", ["Documents", "Review"]);
  if (/^\/documents\/[^/]+/.test(path)) return R(path, "Document", path, "documents", ["Documents", "Document"]);
  if (/^\/editor\//.test(path)) return R(path, "Editor", path, "documents", ["Artifacts", "Editor"]);
  if (/^\/share\//.test(path)) return R(path, "Shared", path, "public");
  if (path === "/") return ROUTE_METADATA.find((r) => r.route === "/dashboard")!;
  return R(path, "Page not found", path, "public");
}

/** "Assets — Portol". `dynamicTitle` (a profile's name) replaces the generic title. */
export function pageTitleFor(location: string, dynamicTitle?: string | null): string {
  const meta = routeMetaFor(location);
  const head = dynamicTitle && dynamicTitle.trim() ? `${dynamicTitle.trim()}${meta.breadcrumb.length > 1 ? ` · ${meta.pageTitle}` : ""}` : meta.pageTitle;
  return `${head}${TITLE_SEPARATOR}${APP_NAME}`;
}

/** The canonical path a link to `location` should use. */
export function canonicalPathFor(location: string): string {
  return routeMetaFor(location).canonicalPath;
}
