// ─── Storage method → cache domains ─────────────────────────────────────────
//
// The server knows what it WROTE only in one place: the storage layer. Every
// write in the app — REST route, AI tool, background job — goes through the
// `storage` proxy in server/storage.ts, so classifying storage METHODS is the
// one classification that cannot be forgotten. Contrast the thing this
// replaces: a map keyed by AI action name or by route, which silently
// invalidated nothing whenever a write's action type wasn't listed.
//
// Classification is by NOUN, not by verb prefix. That matters more than it
// looks: a naive "anything starting with create/update/set is a write" rule
// would classify `bumpDataVersion` and `setResponseCache` — which run on
// literally every request — as unknown writes, and unknown writes degrade to
// the "everything" domain. Every write would then invalidate the whole app,
// which is the exact bug this file exists to end.
//
// Adding `createWidget`/`updateWidget`/`deleteWidget` needs one NOUN entry, not
// three. A noun nobody has mapped degrades to "everything" (correct but slow)
// and fails tests/storage-domain-coverage.test.ts, so it can't stay unmapped.
import type { Domain } from "./entity-domains";

export interface StorageTarget {
  domains: Domain[];
  /** Static list endpoint whose cached rows can be patched with the returned row. */
  endpoint?: string | null;
  /** Endpoint derived from the row, for rows that live under a parent's URL. */
  endpointFrom?: (row: Record<string, any> | undefined) => string | null;
}

export interface StorageWriteTarget extends StorageTarget {
  op: "create" | "update" | "delete";
  noun: string;
}

/** Verbs that mean "this call wrote something", mapped to the patch op. */
const VERB_OPS: Record<string, "create" | "update" | "delete"> = {
  create: "create", add: "create", log: "create", save: "create", record: "create", take: "create",
  delete: "delete", unlink: "delete", remove: "delete",
  update: "update", set: "update", upsert: "update", mark: "update", toggle: "update",
  link: "update", checkin: "update", confirm: "update", pay: "update", restore: "update",
  ensure: "update", copy: "update", migrate: "update", propagate: "update", repair: "update",
  skip: "update", adjust: "update", pause: "update", resume: "update", reschedule: "update",
  merge: "update", unmerge: "update",
  // mutateProfileFields — a profile update whose patch is planned on the fresh row.
  mutate: "update",
};

/**
 * METHOD-level overrides — consulted before the noun map.
 *
 * The noun rule is right for a method that writes one kind of row. It is
 * wrong for a method whose ONE row-write cascades across every table:
 * deleteProfile runs delete_profile_cascade(), which soft-deletes (or unlinks)
 * expenses, tasks, habits, trackers, events, documents, goals, incomes,
 * journal entries and artifacts — yet "Profile" classified it as a profile
 * write, so every version-stamped shared response cache built from those
 * tables (expenses:, trackers:, obligations:, incomes:, caltimeline:, stats:,
 * enhanced:) kept serving the pre-delete lists. Anything that fans out across
 * tables belongs here, mapped to "everything".
 */
export const STORAGE_METHOD_TARGETS: Record<string, StorageTarget> = {
  // Cascades through the RPC into every owned table.
  deleteProfile: { domains: ["everything"], endpoint: "/api/profiles" },
  // A bill IS a liability profile row: deleteObligation delegates to deleteProfile.
  deleteObligation: { domains: ["everything"], endpoint: "/api/obligations" },
  // server/merge-profiles.ts re-points every record's owners, moves child
  // profiles, and archives the source — reported to the journal under these
  // names since its writes go straight to supabase-js.
  mergeProfiles: { domains: ["everything"], endpoint: null },
  unmergeProfiles: { domains: ["everything"], endpoint: null },
};

/**
 * Methods on the storage interface that write only to infrastructure — caches,
 * memos, the data-version counter — or that read despite a write-shaped name.
 * These MUST record nothing: several of them run on every request, and treating
 * them as writes would make every request look like a mutation of everything.
 */
export const STORAGE_INFRA_METHODS: ReadonlySet<string> = new Set([
  "bumpDataVersion",
  "getDataVersion",
  "setResponseCache",
  "getResponseCache",
  "cleanupResponseCache",
  "enableRequestMemo",
  "disableRequestMemo",
  "clearRequestMemo",
  "snapshotRequestMemo",
  "primeRequestMemo",
  "setUserId",
  // Write-shaped names that only READ:
  "recallMemory",      // retrieves a memory, does not save one
  "wouldCreateCycle",  // a predicate on the ownership graph
]);

/** `"createLiabilityPayment"` → `{ verb: "create", noun: "LiabilityPayment" }`. */
export function parseStorageMethod(name: string): { verb: string; noun: string } | null {
  const m = /^([a-z]+)([A-Z].*)$/.exec(name);
  if (!m) return null;
  const verb = m[1];
  if (!(verb in VERB_OPS)) return null;
  return { verb, noun: m[2] };
}

const PROFILE_DOMAINS: Domain[] = ["profiles", "assets", "liabilities", "people"];

/**
 * Noun → the domains a write to it ripples into, and the list endpoint whose
 * cached rows can be patched with the returned row.
 *
 * `endpoint: null` means "no patchable list" — the change still invalidates its
 * domains, it just can't be applied before the refetch. Nested rows (a tracker
 * entry inside its tracker, a habit check-in inside its habit) are that case.
 */
export const STORAGE_NOUN_TARGETS: Record<string, StorageTarget> = {
  // Profiles are the polymorphic table: people, accounts, ASSETS and
  // LIABILITIES are all profile rows discriminated by `type`. A write to any of
  // them has to ripple into all four domains or "changed a car's value, the
  // assets list didn't move" comes straight back.
  Profile: { domains: PROFILE_DOMAINS, endpoint: "/api/profiles" },
  // mutateProfileFields (balance moves, payment splits) — the same profile row.
  ProfileFields: { domains: PROFILE_DOMAINS, endpoint: "/api/profiles" },
  ProfileTo: { domains: PROFILE_DOMAINS, endpoint: null },     // linkProfileTo
  ProfileFrom: { domains: PROFILE_DOMAINS, endpoint: null },   // unlinkProfileFrom

  Task: { domains: ["tasks"], endpoint: "/api/tasks" },
  Expense: { domains: ["expenses"], endpoint: "/api/expenses" },
  Income: { domains: ["incomes"], endpoint: "/api/incomes" },
  Paycheck: { domains: ["incomes"], endpoint: "/api/paychecks" },
  Event: { domains: ["events"], endpoint: "/api/events" },
  Goal: { domains: ["goals"], endpoint: "/api/goals" },
  Document: { domains: ["documents"], endpoint: "/api/documents" },
  JournalEntry: { domains: ["journal"], endpoint: "/api/journal" },
  Memory: { domains: ["memories"], endpoint: "/api/memories" },
  Artifact: { domains: ["artifacts"], endpoint: "/api/artifacts" },
  ArtifactShareToken: { domains: ["artifacts"], endpoint: null },
  Preference: { domains: ["preferences"], endpoint: null },
  Capture: { domains: ["journal"], endpoint: null },

  // Habit ↔ tracker: one completion writes both sides (server/habit-completion),
  // so either side's write must refresh the other or the ring and the chart
  // disagree. Entries and check-ins also drive derive-on-read GOAL progress
  // (habit_streak / tracker_target / fitness_* goals), so those writes must
  // refresh goals too — the client bus already did; the server side didn't.
  Habit: { domains: ["habits", "trackers", "goals"], endpoint: "/api/habits" },
  HabitCheckin: { domains: ["habits", "trackers", "goals"], endpoint: null },
  Tracker: { domains: ["trackers", "habits", "goals"], endpoint: "/api/trackers" },
  TrackerEntry: { domains: ["trackers", "habits", "goals"], endpoint: null },
  Entry: { domains: ["trackers", "habits", "goals"], endpoint: null },   // logEntry

  Obligation: { domains: ["obligations", "liabilities", "expenses"], endpoint: "/api/obligations" },
  Budget: { domains: ["budgets", "expenses"], endpoint: null },
  Budgets: { domains: ["budgets", "expenses"], endpoint: null },
  BudgetsToMonth: { domains: ["budgets", "expenses"], endpoint: null },
  Cashflow: { domains: ["expenses", "incomes"], endpoint: null },

  // Paying a liability moves the payment list, the liability's balance (a
  // profile row), the bill schedule and the money that left an account.
  LiabilityPayment: {
    domains: ["liabilities", "obligations", "expenses", "profiles"],
    endpointFrom: (row) => {
      const parent = row?.liabilityProfileId ?? row?.liability_profile_id;
      return typeof parent === "string" && parent ? `/api/liabilities/${parent}/payments` : null;
    },
  },
  LoanPayment: { domains: ["liabilities", "obligations"], endpoint: null },
  LoanSchedule: { domains: ["liabilities", "obligations"], endpoint: null },

  // Per-occurrence bill state lives ON the liability profile row
  // (fields.occurrences), so a write ripples wherever a liability-profile
  // write does, plus the bill surfaces. These were unmapped — every
  // occurrence write (paying a bill!) degraded to "everything" and nuked all
  // 21 client domains plus the version epoch.
  Occurrence: { domains: ["liabilities", "obligations", "expenses", "profiles"], endpoint: null },
  OccurrenceOverride: { domains: ["liabilities", "obligations", "expenses", "profiles"], endpoint: null },
  OccurrenceFields: { domains: ["liabilities", "obligations", "profiles"], endpoint: null },
  OccurrenceEstimate: { domains: ["liabilities", "obligations", "profiles"], endpoint: null },
  OccurrenceActual: { domains: ["liabilities", "obligations", "profiles"], endpoint: null },
  OccurrenceCharge: { domains: ["liabilities", "obligations", "profiles"], endpoint: null },
  // pauseLiability / resumeLiability
  Liability: { domains: ["liabilities", "obligations", "profiles"], endpoint: null },
  // adjustAccountBalance — an account IS a profile row; money moving also
  // touches the finance surfaces. create/updateAccount are profile writes in
  // account clothing and ripple the same way.
  AccountBalance: { domains: [...PROFILE_DOMAINS, "expenses"], endpoint: null },
  Account: { domains: [...PROFILE_DOMAINS, "expenses"], endpoint: null },
  // Financial-asset data inside an account profile (shared/financial-assets):
  // a value observation, a holding, an activity row, a transfer between two
  // accounts, the source connection. All are profile writes; a snapshot,
  // an activity row and a transfer also move money the finance surfaces show.
  AccountSnapshot: { domains: [...PROFILE_DOMAINS, "dashboard"], endpoint: null },
  AccountHolding: { domains: PROFILE_DOMAINS, endpoint: null },
  AccountActivity: { domains: [...PROFILE_DOMAINS, "expenses", "dashboard"], endpoint: null },
  AccountTransfer: { domains: [...PROFILE_DOMAINS, "expenses", "dashboard"], endpoint: null },
  AccountConnection: { domains: PROFILE_DOMAINS, endpoint: null },
  // ensureAutoOwnerLink — background ownership self-heal on profile writes.
  AutoOwnerLink: { domains: PROFILE_DOMAINS, endpoint: null },
  // logActivity — the activity feed the dashboard renders.
  Activity: { domains: ["dashboard"], endpoint: null },
  LiabilityAssetLink: { domains: PROFILE_DOMAINS, endpoint: null },
  // Co-ownership (party / owner links) changes WHICH rows every scoped list
  // holds — a person's tasks, bills, documents, trackers, budgets and the
  // dashboard seeds all widen with the assets and loans they co-own
  // (shared/profile-filter.effectiveSelection). A profile-only ripple left
  // every one of those lists stale until its own staleTime.
  LiabilityProfileLink: { domains: ["everything"], endpoint: null },
  LiabilityOwnerLink: { domains: ["everything"], endpoint: null },
  LiabilityOwners: { domains: ["everything"], endpoint: null },
  AssetPartyLink: { domains: ["everything"], endpoint: null },
  AssetOwners: { domains: ["everything"], endpoint: null },
  OwnershipHistory: { domains: PROFILE_DOMAINS, endpoint: null },
  OwnershipHistoryEntry: { domains: PROFILE_DOMAINS, endpoint: null },
  OwnershipConsistency: { domains: PROFILE_DOMAINS, endpoint: null },
  NetWorthSnapshot: { domains: ["dashboard"], endpoint: null },

  EntityLink: { domains: PROFILE_DOMAINS, endpoint: null },
  Domain: { domains: ["profiles"], endpoint: null },
  DomainEntry: { domains: ["profiles"], endpoint: null },
  UserNotification: { domains: ["notifications"], endpoint: "/api/notifications" },
  UserNotifications: { domains: ["notifications"], endpoint: null },
  ChecklistItem: { domains: ["artifacts", "tasks"], endpoint: null },

  FinanceImport: { domains: ["expenses", "incomes"], endpoint: null },
  FinanceImportStatus: { domains: ["expenses", "incomes"], endpoint: null },

  // AI bookkeeping: the action log IS the activity feed's source.
  AiActionLog: { domains: ["dashboard"], endpoint: null },
  AiBulkPlan: { domains: ["dashboard"], endpoint: null },
  AiBulkPlanStatus: { domains: ["dashboard"], endpoint: null },
  ActionUndone: { domains: ["everything"], endpoint: null },   // markActionUndone reverses an arbitrary write

  // Genuinely unbounded writes — they legitimately mean "everything".
  AllUserData: { domains: ["everything"], endpoint: null },
  Entity: { domains: ["everything"], endpoint: null },             // restoreEntity
  EntityToAncestors: { domains: ["everything"], endpoint: null },  // propagateEntityToAncestors
  DocumentToAncestors: { domains: ["documents", "profiles"], endpoint: null },
  DocumentsToStorage: { domains: ["documents"], endpoint: null },
  UnlinkedTrackersToSelf: { domains: ["trackers", "profiles"], endpoint: null },
};

/**
 * Resolve a storage method name to what its call changed.
 *
 * Returns null for reads and infrastructure. An unrecognized NOUN on a
 * write-shaped verb resolves to the "everything" domain — a write can be slow
 * to classify, but it can never fail to invalidate.
 */
export function targetForStorageMethod(name: string): StorageWriteTarget | null {
  if (STORAGE_INFRA_METHODS.has(name)) return null;
  const parsed = parseStorageMethod(name);
  if (!parsed) return null;
  const op = VERB_OPS[parsed.verb];
  const override = STORAGE_METHOD_TARGETS[name];
  if (override) return { op, noun: parsed.noun, ...override };
  const target = STORAGE_NOUN_TARGETS[parsed.noun];
  if (!target) {
    return { op, noun: parsed.noun, domains: ["everything"], endpoint: null };
  }
  return { op, noun: parsed.noun, ...target };
}

/** Is this a storage method the write journal should record? */
export function isJournaledStorageMethod(name: string): boolean {
  return targetForStorageMethod(name) !== null;
}
