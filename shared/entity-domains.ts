// ─── Entity → cache-domain vocabulary ───────────────────────────────
// The server knows WHAT it wrote ("a task", "an expense"). The client knows
// WHICH cache keys read that data. Before this file the two never spoke: the
// AI chat handler wrote to the database and the client responded by
// invalidating every /api/* query twice and waiting for the network, because
// nothing in the response said what had actually changed.
//
// This module is the shared vocabulary. `server/ai-envelope.ts` already
// classifies every tool into an entity type (TOOL_ENTITY); this maps that same
// entity type onto:
//   · the cache DOMAINS the client bus should invalidate (client/src/lib/cache-bus.ts)
//   · the list ENDPOINT whose cached rows can be patched in place, so a created
//     row is on screen before any refetch lands.
//
// Both sides import from here. Adding a tool without wiring it up fails
// tests/entity-domain-coverage.test.ts rather than silently producing a write
// the UI never shows.

/**
 * A logical category of data. Mutations declare the domain(s) they touch and
 * the client bus expands each to the full set of cache keys that depend on it.
 * The canonical expansion lives in client/src/lib/cache-bus.ts (DOMAIN_KEYS);
 * the type lives here so the server can name domains without importing client
 * code.
 */
export type Domain =
  | "tasks"
  | "habits"
  | "trackers"
  | "profiles"
  | "assets"
  | "liabilities"
  | "people"
  | "documents"
  | "expenses"
  | "incomes"
  | "obligations"
  | "budgets"
  | "goals"
  | "events"
  | "journal"
  | "notes"      // Notes — their own table, their own category
  | "artifacts"
  | "memories"
  | "notifications"
  | "preferences"
  | "dashboard"   // KPI tiles + dashboard-enhanced + stats
  | "everything"; // nuclear — for writes whose shape we can't name

/** The entity vocabulary used by TOOL_ENTITY in server/ai-envelope.ts. */
export type EntityType =
  | "task"
  | "expense"
  | "income"
  | "event"
  | "habit"
  | "tracker"
  | "trackerEntry"
  | "goal"
  | "profile"
  | "obligation"
  | "journal"
  | "memory"
  | "artifact"
  | "note"
  | "document"
  | "paycheck";

/**
 * Which cache domains a write to each entity ripples into.
 *
 * `profile` fans out to profiles + assets + liabilities + people on purpose:
 * assets and liabilities are not separate tables, they are Profile rows
 * discriminated by `type` (shared/schema.ts ProfileType). The bus's predicates
 * for those domains already overlap almost entirely, so the union costs one
 * extra predicate pass and removes a whole class of "created a car, the assets
 * list didn't move" bugs.
 *
 * `paycheck` maps to incomes because the incomes domain already carries
 * /api/paychecks.
 */
export const ENTITY_DOMAINS: Record<EntityType, Domain[]> = {
  task: ["tasks"],
  expense: ["expenses"],
  income: ["incomes"],
  event: ["events"],
  habit: ["habits"],
  tracker: ["trackers"],
  trackerEntry: ["trackers"],
  goal: ["goals"],
  profile: ["profiles", "assets", "liabilities", "people"],
  obligation: ["obligations", "liabilities"],
  journal: ["journal"],
  memory: ["memories"],
  artifact: ["artifacts"],
  note: ["notes"],
  document: ["documents"],
  paycheck: ["incomes"],
};

/**
 * The list endpoint whose cached array can be patched with the returned row.
 * `null` means "no patchable list" — the change still invalidates its domains,
 * it just can't be applied optimistically. Tracker ENTRIES live nested inside
 * their tracker's row rather than in a list of their own, which is why they
 * are domain-only.
 */
export const ENTITY_ENDPOINT: Record<EntityType, string | null> = {
  task: "/api/tasks",
  expense: "/api/expenses",
  income: "/api/incomes",
  event: "/api/events",
  habit: "/api/habits",
  tracker: "/api/trackers",
  trackerEntry: null,
  goal: "/api/goals",
  profile: "/api/profiles",
  obligation: "/api/obligations",
  journal: "/api/journal",
  memory: "/api/memories",
  artifact: "/api/artifacts",
  note: "/api/notes",
  document: "/api/documents",
  paycheck: "/api/paychecks",
};

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && value in ENTITY_DOMAINS;
}

/** Domains for an entity type; unknown/absent types fall back to "everything". */
export function domainsForEntity(entityType: string | null | undefined): Domain[] {
  return isEntityType(entityType) ? ENTITY_DOMAINS[entityType] : ["everything"];
}

/** Patchable list endpoint for an entity type, or null when there isn't one. */
export function endpointForEntity(entityType: string | null | undefined): string | null {
  return isEntityType(entityType) ? ENTITY_ENDPOINT[entityType] : null;
}

/**
 * Coarse fallback: cache domains for a ParsedAction type.
 *
 * The agentic loop knows exactly which entity each tool touched, so it builds a
 * precise manifest. The deterministic fast paths ("mood good", "slept 7 hours",
 * "remember that…") write straight through storage and only report an action
 * type — before this map they had no manifest at all, so every one of them fell
 * back to invalidating the entire cache. They still can't be patched
 * optimistically (there is no verified row), but they can at least refresh the
 * right domains instead of all of them.
 *
 * Unlisted types (including the read-only ones) return no domains, and the
 * caller decides what that means.
 */
export const ACTION_TYPE_DOMAINS: Record<string, Domain[]> = {
  create_profile: ENTITY_DOMAINS.profile,
  update_profile: ENTITY_DOMAINS.profile,
  create_liability: ["liabilities", "profiles", "obligations"],
  revalue_asset: ENTITY_DOMAINS.profile,
  create_tracker: ["trackers"],
  log_entry: ["trackers"],
  update_tracker_entry: ["trackers"],
  delete_tracker_entry: ["trackers"],
  create_task: ["tasks"],
  complete_task: ["tasks"],
  delete_task: ["tasks"],
  log_expense: ["expenses"],
  log_income: ["incomes"],
  log_paycheck: ["incomes"],
  create_event: ["events"],
  complete_event: ["events"],
  create_goal: ["goals"],
  create_habit: ["habits"],
  checkin_habit: ["habits"],
  uncomplete_habit: ["habits"],
  delete_habit: ["habits"],
  create_obligation: ["obligations", "liabilities"],
  pay_obligation: ["obligations", "liabilities", "expenses"],
  add_liability_payment: ["liabilities", "obligations", "expenses"],
  journal_entry: ["journal"],
  create_artifact: ["artifacts"],
  // Notes have their own table and their own surfaces — nothing about an
  // artifact changes when one is written.
  create_note: ["notes"],
  save_memory: ["memories"],
  set_budget: ["budgets"],
  manage_document: ["documents"],
};

/** Action types that only READ — they must never trigger an invalidation. */
export const READ_ONLY_ACTION_TYPES = new Set(["retrieve", "navigate", "set_dashboard_scope", "recall_memory", "unknown"]);

/**
 * Domains for a list of ParsedAction types. Returns ["everything"] when any
 * writing action has no mapping, so an unrecognized write degrades to the
 * blanket refresh instead of quietly refreshing nothing.
 */
export function domainsForActionTypes(types: Array<string | undefined | null>): Domain[] {
  const out = new Set<Domain>();
  for (const t of types) {
    if (!t || READ_ONLY_ACTION_TYPES.has(t)) continue;
    const domains = ACTION_TYPE_DOMAINS[t];
    if (!domains) return ["everything"];
    for (const d of domains) out.add(d);
  }
  return [...out];
}
