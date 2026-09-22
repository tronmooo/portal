// shared/entity-routes.ts — the ONE answer to "where does this record live?"
//
// Rules 23/24: every searchable entity type has a canonical destination, and
// every surface that links to a record (chat receipts, search results,
// notifications, dashboard cards, recent activity, calendar occurrences)
// resolves it HERE. Before this file there were eleven inline route builders
// and they disagreed: a task went to `/tasks?focus=<id>` (nothing read
// `focus`), a tracker finding went to `/trackers?open=<id>` (the page reads
// `?tracker=`), a document expiry went to a bare `/documents` (no such route),
// and a loan receipt went to the generic `/profiles` list.
//
// Pure. Imports nothing from client/ or server/. The `highlight` query
// parameter (shared/record-highlight) is the single deep-link mechanism for
// list pages; record pages (/profiles/:id, /documents/:id, /editor/:id) take
// the id in the path.

import { highlightHref, type RecordHighlightType } from "./record-highlight";

export type RoutableEntityType =
  | "person"
  | "profile"
  | "asset"
  | "liability"
  | "account"
  | "expense"
  | "income"
  | "paycheck"
  | "document"
  | "tracker"
  | "trackerEntry"
  | "habit"
  | "task"
  | "event"
  | "obligation"
  | "goal"
  | "journal"
  | "artifact"
  | "note"
  | "memory"
  | "budget";

export const ROUTABLE_ENTITY_TYPES: readonly RoutableEntityType[] = [
  "person", "profile", "asset", "liability", "account",
  "expense", "income", "paycheck", "document", "tracker", "trackerEntry",
  "habit", "task", "event", "obligation", "goal", "journal",
  "artifact", "note", "memory", "budget",
];

export function isRoutableEntityType(value: unknown): value is RoutableEntityType {
  return typeof value === "string" && (ROUTABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

export interface RouteContext {
  /**
   * The profile the record hangs off. For profile-anchored systems (a
   * birthday event, a bill on a loan, a paycheck on a person) the profile IS
   * the page you edit the date on, so it wins over the list page. Record
   * pages (document, task, tracker, artifact…) ignore it.
   */
  profileId?: string;
  /** Prefix the result with `#` for raw hash hrefs (`<a href>`, calendar sources). */
  hash?: boolean;
  /** For a tracker entry: the tracker it belongs to. */
  parentId?: string;
  /** Optional tab on a profile page (`/profiles/:id/:tab`). */
  tab?: string;
}

/**
 * Aliases other modules use for the same thing. `_type` from /api/search,
 * SourceSystem from calendar-occurrences, notification/activity type strings,
 * OwnedEntityType from shared/ownership, KNOWN_ENTITY_TYPES in server/routes.
 */
export const ENTITY_TYPE_ALIASES: Record<string, RoutableEntityType> = {
  self: "person",
  pet: "person",
  people: "person",
  vehicle: "asset",
  property: "asset",
  investment: "asset",
  domain: "asset",
  subscription: "asset",
  medical: "asset",
  loan: "liability",
  bill: "obligation",
  obligations: "obligation",
  journal_entry: "journal",
  tracker_entry: "trackerEntry",
  task_completed: "task",
  liability_payment: "liability",
  paychecks: "paycheck",
  incomes: "income",
  expenses: "expense",
  documents: "document",
  tasks: "task",
  habits: "habit",
  events: "event",
  goals: "goal",
  trackers: "tracker",
  artifacts: "artifact",
  memories: "memory",
  profiles: "profile",
};

/** A RoutableEntityType for any of the spellings above, or null. */
export function normalizeEntityType(value: unknown): RoutableEntityType | null {
  if (typeof value !== "string" || !value) return null;
  if (isRoutableEntityType(value)) return value;
  const alias = ENTITY_TYPE_ALIASES[value] || ENTITY_TYPE_ALIASES[value.toLowerCase()];
  return alias || null;
}

// ─── Route table ─────────────────────────────────────────────────────────────

/** The list page for each type — where a link with no id lands. */
const LIST_ROUTES: Record<RoutableEntityType, string> = {
  person: "/profiles",
  profile: "/profiles",
  asset: "/linked?tab=assets",
  liability: "/liabilities",
  account: "/dashboard/finance",
  expense: "/dashboard/finance",
  income: "/dashboard/finance",
  paycheck: "/dashboard/finance",
  budget: "/dashboard/finance",
  // There is no bare /documents route (App.tsx); the documents list is the
  // hub's Documents tab.
  document: "/linked?tab=documents",
  tracker: "/trackers",
  trackerEntry: "/trackers",
  habit: "/dashboard/habits",
  task: "/dashboard/tasks",
  event: "/calendar",
  obligation: "/dashboard/obligations",
  goal: "/goals",
  journal: "/dashboard/journal",
  artifact: "/artifacts",
  note: "/artifacts",
  memory: "/chat",
};

/** Types whose record page IS the profile row (`/profiles/:id`). */
const PROFILE_BACKED = new Set<RoutableEntityType>(["person", "profile", "asset", "liability", "account"]);

/**
 * Types whose date lives ON a profile when one is given: tapping "Joe's
 * Birthday" opens Joe; a loan payment opens the loan. Record-owning systems
 * (document, task, tracker, artifact, expense, journal) are NOT here — a
 * document expiry belongs to the document even when it is linked to a person
 * (user report 2026-07-25).
 */
const PROFILE_ANCHORED = new Set<RoutableEntityType>([
  "person", "profile", "asset", "liability", "account",
  "event", "obligation", "income", "paycheck", "goal", "habit", "budget",
]);

/** The highlight type a list page reads for each list-routed entity. */
const HIGHLIGHT_TYPE: Partial<Record<RoutableEntityType, RecordHighlightType>> = {
  expense: "expense",
  income: "income",
  paycheck: "income",
  budget: "budget",
  task: "task",
  habit: "habit",
  obligation: "obligation",
  goal: "goal",
  journal: "journal",
  event: "event",
  trackerEntry: "trackerEntry",
};

function withHash(path: string, hash?: boolean): string {
  return hash ? `#${path}` : path;
}

/** The list page for a type (no id), e.g. `document` → `/linked?tab=documents`. */
export function listRouteForEntity(type: RoutableEntityType | string, ctx?: Pick<RouteContext, "hash">): string {
  const t = normalizeEntityType(type);
  return withHash(t ? LIST_ROUTES[t] : "/dashboard", ctx?.hash);
}

/**
 * The canonical path for a record.
 *
 *   person/profile/asset/liability/account → /profiles/:id
 *   document                              → /documents/:id
 *   tracker                               → /trackers?tracker=:id
 *   artifact/note                         → /editor/:id
 *   expense                               → /dashboard/finance?highlight=expense:<id>
 *   income/paycheck                       → /dashboard/finance?highlight=income:<id>
 *   task                                  → /dashboard/tasks?highlight=task:<id>
 *   habit                                 → /dashboard/habits?highlight=habit:<id>
 *   obligation                            → /dashboard/obligations?highlight=obligation:<id>
 *   goal                                  → /goals?highlight=goal:<id>
 *   journal                               → /dashboard/journal?highlight=journal:<id>
 *   event                                 → /calendar?highlight=event:<id>
 *
 * No id → the list page. Never `/documents`, never `?open=`, never `?focus=`.
 */
export function routeForEntity(
  type: RoutableEntityType | string,
  id?: string | number | null,
  ctx?: RouteContext,
): string {
  const t = normalizeEntityType(type);
  if (!t) return withHash(ctx?.profileId ? `/profiles/${ctx.profileId}` : "/dashboard", ctx?.hash);
  const rid = id == null ? "" : String(id).trim();

  if (PROFILE_BACKED.has(t)) {
    const pid = rid || ctx?.profileId || "";
    if (!pid) return withHash(LIST_ROUTES[t], ctx?.hash);
    return withHash(ctx?.tab ? `/profiles/${pid}/${ctx.tab}` : `/profiles/${pid}`, ctx?.hash);
  }

  // A profile-anchored date with a profile: the profile is the record.
  if (ctx?.profileId && PROFILE_ANCHORED.has(t)) {
    return withHash(`/profiles/${ctx.profileId}`, ctx?.hash);
  }

  if (!rid) return withHash(LIST_ROUTES[t], ctx?.hash);

  switch (t) {
    case "document": return withHash(`/documents/${rid}`, ctx?.hash);
    case "tracker": return withHash(`/trackers?tracker=${rid}`, ctx?.hash);
    case "artifact":
    case "note": return withHash(`/editor/${rid}`, ctx?.hash);
    case "trackerEntry": {
      const base = ctx?.parentId ? `/trackers?tracker=${ctx.parentId}` : LIST_ROUTES.trackerEntry;
      return withHash(highlightHref(base, "trackerEntry", rid), ctx?.hash);
    }
    case "memory": return withHash(LIST_ROUTES.memory, ctx?.hash);
    default: {
      const ht = HIGHLIGHT_TYPE[t];
      return withHash(ht ? highlightHref(LIST_ROUTES[t], ht, rid) : LIST_ROUTES[t], ctx?.hash);
    }
  }
}

// ─── Search rows ─────────────────────────────────────────────────────────────

// Profile.type values, mirrored from shared/asset-value + profile-dedup so
// this module stays import-light (it is loaded by the search matcher on the
// server and by every list page on the client).
const PERSON_TYPES = new Set(["self", "person", "pet"]);
const LIABILITY_TYPES = new Set(["liability", "loan"]);
const ACCOUNT_TYPES = new Set(["account"]);

/**
 * The routable type of a `/api/search` row: `_type` plus, for profile rows,
 * the profile's own `type` (a person, an asset, a loan, an account).
 */
export function entityTypeFromSearchRow(row: any): RoutableEntityType | null {
  if (!row || typeof row !== "object") return null;
  const raw = String(row._type || row.entityType || row.type || "");
  if (raw === "profile" || (row._type == null && row.parentProfileId !== undefined)) {
    const pt = String(row.type || "").toLowerCase();
    if (PERSON_TYPES.has(pt)) return "person";
    if (LIABILITY_TYPES.has(pt)) return "liability";
    if (ACCOUNT_TYPES.has(pt)) return "account";
    if (pt && pt !== "profile") return "asset";
    return "profile";
  }
  return normalizeEntityType(raw);
}

/** `routeForEntity` for a search row, using the row's own id. */
export function routeForSearchRow(row: any, ctx?: RouteContext): string | null {
  const t = entityTypeFromSearchRow(row);
  if (!t) return null;
  return routeForEntity(t, row?.id, ctx);
}
