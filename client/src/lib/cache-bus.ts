// ─── Central cache invalidation bus ─────────────────────────────────
// Every screen in this app reads from React Query. When data changes
// (mutation, AI chat action, document extraction) we MUST invalidate
// every query that reads the affected data. Otherwise the user sees
// stale numbers: KPI tile says "1 open task" while the popup says "0",
// the habits ring stays at 0% after marking everything done, etc.
//
// This module is the ONLY place that knows which cache keys depend on
// which domains. When a mutation finishes, callers just say
// `invalidateDomain("tasks")` — the bus figures out the full ripple.
//
// Why this exists (history):
//  - queryClient.ts had a global mutations.onSuccess listing 25 keys
//  - chat.tsx had its own invalidateAll() listing 17 keys
//  - neither list covered nested keys like
//    ["/api/profiles", id, "detail"], ["/api/rel-assets", ...], or
//    ["/api/assets", id, "liabilities"]
//  - so changes from the AI chat would never refresh the profile detail page,
//    and link/unlink mutations left the relationship graph showing stale
//    counts
// One bus, with `predicate`-based matching, fixes all of this.

import { queryClient } from "./queryClient";
import type { Domain } from "@shared/entity-domains";

// ─── Domains ────────────────────────────────────────────────────────
// A "domain" is a logical category of data. Mutations declare what
// domain(s) they touch; the bus expands each to the full set of cache
// keys that depend on it.
//
// The Domain union itself lives in shared/entity-domains.ts so the SERVER can
// name domains too — the AI chat response now carries a manifest of the
// domains its turn touched (see shared/entity-domains.ts and lib/chat-sync.ts).
// This file remains the single owner of what each domain EXPANDS to.
export type { Domain } from "@shared/entity-domains";

// ─── Domain → keys map ───────────────────────────────────────────────
// Top-level keys for each domain. The bus also runs nested-key
// predicate matches below (for "/api/profiles/:id/detail" style keys).
const DOMAIN_KEYS: Record<Domain, string[][]> = {
  // P4.4: /api/insights + /api/ai-digest are derived analytics over the data
  // domains below (expenses, incomes, tasks, habits, trackers, obligations,
  // profiles). They were previously only invalidated via the "dashboard"
  // domain, which no data mutation ever fired — so insights stayed stale
  // after writes. Each feeding domain now busts them too.
  tasks: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/tasks"],
    // tasks affect KPI tile + dashboard widget + activity feed
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/calendar/timeline"],
    ["/api/date-rules"],  // a due date is a deadline rule
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    // ...and the notification feed, which derives "due today" / "overdue"
    // straight from open tasks. Omitting it left a "X is due today" alert in
    // the bell after X had been ticked off (QA 2026-07-29 CRUD-T1-003) — the
    // server already excludes done tasks, the client just never re-asked.
    ["/api/notifications"],
  ],
  habits: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/habits"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    // Completing a habit writes its linked tracker's record too (one
    // completion, one pipeline — server/habit-completion.ts), so the Trackers
    // page and every tracker-fed chart are stale the moment a habit is
    // checked off. The reverse edge is in the trackers domain below; both
    // directions are needed because either side can be the one that moves.
    ["/api/trackers"],
    // A profile's detail payload embeds its habits (relatedHabits) and its
    // activity timeline, so a check-in made anywhere else leaves the person's
    // page showing the pre-check-in count until something unrelated refetches.
    ["/api/profiles"],
  ],
  trackers: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/trackers"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    ["/api/goals"], // goals can auto-update from tracker entries
    // Habit ↔ tracker link (2026-08-20): logging an entry to a tracker
    // advances any habit linked to it (server/habit-completion.ts), so a
    // manual log on the Trackers page must refresh the Habits ring too —
    // otherwise the habit shows pre-log progress until an unrelated refetch.
    ["/api/habits"],
  ],
  profiles: [
    ["/api/profiles"],
    ["/api/accounts"], // accounts ARE profiles (type: "account")
    // Ownership link tables. An asset's owners and a liability's borrowers are
    // what the net-worth share math reads (shared/net-worth.ts, seeded from the
    // bootstrap under these bare keys). No domain listed them, so an ownership
    // change made through chat — "make the car 50/50 with Jane" — left every
    // share on the dashboard at its pre-change split until a hard reload.
    ["/api/asset-party-links"],
    ["/api/liability-profile-links"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    // A profile OWNS dates — a date of birth, an anniversary, a licence or
    // passport expiration. Changing July 10 to July 11 has to move the yearly
    // birthday everywhere at once, which it cannot do while the calendar and
    // the rules list keep serving the pre-edit answer.
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/notifications"],
    // A profile's notes live under their own endpoint, keyed by profile id.
    // No domain listed them, so a note written anywhere but the notes panel
    // itself (chat, a document extraction) never appeared on the profile.
    ["/api/notes"],
    // nested keys handled via predicate below
  ],
  assets: [
    ["/api/profiles"], // assets are profiles
    ["/api/asset-party-links"],      // ownership shares — see the profiles domain
    ["/api/liability-profile-links"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/rel-assets"],
    ["/api/cashflow"],
    // An asset's value is an input to every one of these, and none of them
    // was listed: the bootstrap payload SEEDS ~24 list caches on next launch
    // and is persisted to localStorage, so omitting it meant a revalued car
    // came back at its old value after a reload.
    ["/api/dashboard-bootstrap"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    ["/api/net-worth/history"],
  ],
  liabilities: [
    ["/api/profiles"], // liabilities are profiles
    ["/api/asset-party-links"],      // ownership shares — see the profiles domain
    ["/api/liability-profile-links"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/rel-liabilities"],
    ["/api/obligations"],
    ["/api/loans/schedule"],
    ["/api/cashflow"],
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    // Paying a bill from an account moves that account's balance, so the
    // Accounts list is stale the moment a liability write lands.
    ["/api/accounts"],
    // A payment is money spent: it lands in the spend totals and the month's
    // budget just like any other outflow, and it moves net worth. None of
    // these were listed, so "record a payment" left the budget summary and the
    // net-worth trend showing the pre-payment picture.
    ["/api/expenses"],
    ["/api/budgets"],
    ["/api/budgets/summary"],
    ["/api/net-worth/history"],
    // Per-occurrence bill state — see the obligations domain.
    ["/api/obligation-occurrences"],
    ["/api/dashboard-bootstrap"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
  ],
  people: [
    ["/api/profiles"],
    ["/api/rel-people"],
    ["/api/dashboard-enhanced"],
  ],
  documents: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/documents"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    // User report 2026-08-20 (screenshot): a deleted document vanished from
    // the Documents tab instantly and stayed on the Info tab. The Info tab
    // reads the profile-detail EMBED (`relatedDocuments`) and the activity
    // timeline, neither of which lives under "/api/documents" — so a
    // documents-only invalidation left both showing a document that no longer
    // existed until the detail query happened to refetch. Hence "it took some
    // time for it to delete".
    ["/api/profiles"],
    // A document carries dates (an expiration IS a calendar item — see
    // shared/date-rules), so saving, editing or deleting one changes the
    // calendar, the upcoming feed and the important-date list too.
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/notifications"],
  ],
  expenses: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/expenses"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/budgets"],
    ["/api/budgets/summary"],
    ["/api/cashflow"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
  ],
  incomes: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/incomes"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/paychecks"],
    ["/api/cashflow"],
    // Recurring income is a calendar series now (a paycheck lands on a date).
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
  ],
  obligations: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/obligations"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/loans/schedule"],
    ["/api/cashflow"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    ["/api/calendar/timeline"], // bills and loan payments are calendar items
    ["/api/date-rules"],        // …and each one is a payment rule
    ["/api/notifications"],     // "bill due" alerts derive from obligations
    // Paying a bill IS money leaving an account: the server records it in the
    // expense ledger (routes.ts busts `expenses:` on /obligations/:id/pay) and
    // moves the paying account's balance. None of that was listed here, so
    // "Mark paid" left the month's spend total, the budget bars, the account
    // balance and the net-worth trend showing the pre-payment picture until a
    // reload. The liabilities domain already carried these; obligations, the
    // domain every bill surface actually fires, did not.
    ["/api/expenses"],
    ["/api/budgets"],
    ["/api/budgets/summary"],
    ["/api/accounts"],
    ["/api/net-worth/history"],
    // Per-occurrence bill state (paid / skipped for one due date) lives under
    // its own endpoint. Nothing listed it, so skipping an occurrence from a
    // popup left the calendar showing it as still scheduled.
    ["/api/obligation-occurrences"],
  ],
  budgets: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/budgets"],
    ["/api/budgets/summary"],
    ["/api/dashboard-enhanced"],
  ],
  goals: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/goals"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
  ],
  events: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/events"],
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/dashboard-enhanced"],
  ],
  journal: [
    ["/api/dashboard-bootstrap"], // seeds this list on launch (persisted) — see assets
    ["/api/journal"],
    ["/api/journal-entries"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
  ],
  artifacts: [
    ["/api/artifacts"],
    ["/api/chat-artifacts"],
    ["/api/dashboard-enhanced"],
  ],
  memories: [
    ["/api/memories"],
  ],
  notifications: [
    ["/api/notifications"],
  ],
  preferences: [
    ["/api/preferences"],
  ],
  dashboard: [
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/insights"],
    ["/api/anomalies"],
    ["/api/ai-digest"],
    // The bootstrap payload is the dashboard's first paint AND the seed for
    // ~24 dependent list caches (bootstrap-seed-keys.ts), and it is persisted
    // to localStorage. It belonged in this list all along: no domain named it,
    // so it only ever went stale via a blanket invalidate-everything. Targeted
    // invalidation would otherwise leave the next launch seeding pre-write rows.
    ["/api/dashboard-bootstrap"],
  ],
  // "everything" handled via predicate below — invalidates every
  // /api/* key the app knows about
  everything: [],
};

// ─── Nested key predicates ──────────────────────────────────────────
// Some queries use composite keys like ["/api/profiles", id, "detail"]
// or ["/api/assets", profileId, "liabilities"]. Top-level invalidation
// of ["/api/profiles"] does NOT touch ["/api/profiles", id, "detail"]
// because React Query's hierarchical matching only goes one direction
// (a longer key inherits from a shorter prefix, BUT only when you
// invalidate the shorter prefix without `exact: true`). So
// invalidateQueries({queryKey:["/api/profiles"]}) actually DOES catch
// ["/api/profiles", id, "detail"] — UNLESS the matching is broken by
// arg shape. We add explicit predicates to be safe.
function predicateForDomain(domain: Domain): ((query: any) => boolean) | null {
  switch (domain) {
    case "profiles":
    case "assets":
    case "liabilities":
    case "people":
      return (q) => {
        const k0 = String(q.queryKey?.[0] || "");
        return (
          k0.startsWith("/api/profiles") ||
          k0.startsWith("/api/rel-") ||
          // NO trailing slash. The keys these are meant to catch put the id in
          // the SECOND segment — ["/api/assets", id, "parties"],
          // ["/api/liabilities", id, "schedule"] — so their k0 is exactly
          // "/api/assets" / "/api/liabilities". Matching "/api/assets/" caught
          // none of them, and the ownership panels, the collateral list and a
          // loan's payment schedule went stale after any change made anywhere
          // else (chat, another tab, another page).
          k0.startsWith("/api/assets") ||
          k0.startsWith("/api/liabilities") ||
          k0.startsWith("/api/liability-") ||
          k0.startsWith("/api/asset-") ||
          k0.startsWith("/api/parties") ||
          k0.startsWith("/api/relationships/") ||
          k0.startsWith("/api/ownership-history")
        );
      };
    case "trackers":
      return (q) => {
        const k0 = String(q.queryKey?.[0] || "");
        return k0.startsWith("/api/trackers");
      };
    case "documents":
      return (q) => {
        const k0 = String(q.queryKey?.[0] || "");
        // ["/api/profiles", id, "detail"] carries the `relatedDocuments` embed
        // and the activity timeline the Info tab renders. Without it a deleted
        // document kept its card and its count on that tab.
        return k0.startsWith("/api/documents") || k0.startsWith("/api/profiles");
      };
    case "tasks":
      return (q) => String(q.queryKey?.[0] || "").startsWith("/api/tasks");
    // Connected-bank panels. Their keys — ["/api/finance/summary", from, to,
    // accounts], ["/api/finance/spending", params] and six more — were in no
    // domain at all, and every one of them sets refetchOnWindowFocus:false, so
    // once painted they never refreshed. A bank sync journals as a
    // FinanceImport write (expenses + incomes), which is what carries the
    // ripple back to these panels.
    case "expenses":
    case "incomes":
      return (q) => String(q.queryKey?.[0] || "").startsWith("/api/finance/");
    case "habits":
      // Nested keys too: a habit check-in mirrors into its linked tracker (the
      // Trackers page reads ["/api/trackers", id]) and shows up on the owner's
      // profile detail (["/api/profiles", id, "detail"]).
      return (q) => {
        const k0 = String(q.queryKey?.[0] || "");
        return k0.startsWith("/api/habits") || k0.startsWith("/api/trackers") || k0.startsWith("/api/profiles");
      };
    case "artifacts":
      return (q) => String(q.queryKey?.[0] || "").startsWith("/api/artifacts");
    case "everything":
      // Invalidate every /api/* query the app has — used by AI chat
      // because Claude can mutate literally any domain in one turn.
      return (q) => String(q.queryKey?.[0] || "").startsWith("/api/");
    default:
      return null;
  }
}

// ─── Cross-tab propagation ──────────────────────────────────────────
// React Query caches are per-tab: a write in tab A invalidated tab A's
// queries only, so tab B kept rendering the pre-write data until a hard
// refresh (2026-07-29 tester report). Every invalidateDomains() call now
// also posts its domain list on a BroadcastChannel; sibling tabs replay
// the same invalidation against their own cache. Their queries with
// active observers refetch immediately, everything else is marked stale
// for its next mount — exactly the local semantics, one tab over.
const CHANNEL_NAME = "portol-cache-bus";
let _channel: BroadcastChannel | null = null;
function channel(): BroadcastChannel | null {
  if (_channel) return _channel;
  try {
    if (typeof BroadcastChannel === "undefined") return null; // old Safari / tests
    _channel = new BroadcastChannel(CHANNEL_NAME);
    _channel.onmessage = (e: MessageEvent) => {
      const domains = Array.isArray(e.data?.domains) ? (e.data.domains as Domain[]) : [];
      if (domains.length === 0) return;
      // remote=true: don't re-broadcast (no infinite ping-pong), and don't
      // have every background tab race to recompute the same aggregates.
      void invalidateDomainsInternal(domains, true);
    };
  } catch { return null; }
  return _channel;
}
// Open the channel at module load so a tab that never mutates anything
// still LISTENS for other tabs' writes.
try { channel(); } catch {}

// ─── Public API ─────────────────────────────────────────────────────

// Invalidate one or more domains. Use `refetchType:"active"` so we only
// refetch queries that have active observers (visible on screen). Stale
// background data still gets marked stale and will refetch next mount.
//
// Returns the (async) settled promise so callers can await if they
// want to defer UI feedback until refresh — but most won't, because
// optimistic updates already showed the change instantly.
export function invalidateDomains(...domains: Domain[]): Promise<void> {
  const pending = domains.filter((d) => !coveredByManifest(d));
  if (pending.length === 0) return Promise.resolve();
  try { channel()?.postMessage({ domains: pending }); } catch {}
  return invalidateDomainsInternal(pending, false);
}

// ─── One invalidation per write ─────────────────────────────────────
// A mutating response carries a manifest of the domains it touched, and
// apiRequest applies it (write-sync.ts) before the mutation's own
// onSuccess/onSettled runs — which then calls invalidateDomain() for the very
// same domains a few milliseconds later. React Query answers the second
// invalidation by cancelling the refetch the first one started and starting
// another, so every write cost two network requests for every active query it
// touched (tasks: 4 GETs + 2 notification GETs per create; tracker log: 16
// requests). The manifest path records what it just invalidated; an explicit
// invalidation arriving inside MANIFEST_COVER_MS for a domain that is already
// refetching is a duplicate of the same write and is dropped. The window is
// deliberately short: a different write's manifest a moment later invalidates
// again on its own (the manifest path is never skipped), so nothing a later
// write changes can be missed.
const MANIFEST_COVER_MS = 150;
const manifestInvalidatedAt = new Map<Domain, number>();
function coveredByManifest(domain: Domain): boolean {
  const at = manifestInvalidatedAt.get(domain);
  return at !== undefined && Date.now() - at < MANIFEST_COVER_MS;
}
/** The write manifest's invalidation: always applied, and remembered so the
 *  mutation's own follow-up invalidation of the same domains is a no-op. */
export function invalidateDomainsFromManifest(domains: Domain[]): Promise<void> {
  const now = Date.now();
  for (const d of domains) manifestInvalidatedAt.set(d, now);
  try { channel()?.postMessage({ domains }); } catch {}
  return invalidateDomainsInternal(domains, false);
}
/** Test hook: forget recent manifest invalidations. */
export function __resetManifestCoverage(): void { manifestInvalidatedAt.clear(); }

/**
 * The aggregate payloads. They are the most expensive thing the server
 * computes (~15 queries) and nothing can patch them, so their refetch policy
 * is worth being deliberate about: the tab that made the write refetches them
 * immediately (they are what net worth and the KPI tiles render), while tabs
 * merely replaying the broadcast only mark them stale — otherwise five open
 * tabs answer one write with five identical cold recomputes.
 */
const AGGREGATE_KEYS = new Set([
  "/api/stats",
  "/api/dashboard-enhanced",
  "/api/dashboard-bootstrap",
  "/api/insights",
  "/api/ai-digest",
]);

function invalidateDomainsInternal(domains: Domain[], remote: boolean): Promise<void> {
  // Collect every top-level key prefix and nested predicate the domains name,
  // then invalidate ONCE with a single combined predicate. Issuing one
  // invalidateQueries per key and another per predicate made React Query
  // cancel and restart the refetch of any query both matched — the "tasks"
  // domain names ["/api/tasks"] and a predicate for "/api/tasks*", so every
  // task write refetched the task list twice (and the notification feed
  // twice, via the "tasks" key list plus the same list again from
  // "notifications"). One pass, one refetch per active query.
  const prefixes: string[][] = [];
  const seen = new Set<string>();
  const predicates: Array<(q: any) => boolean> = [];
  for (const d of domains) {
    for (const key of DOMAIN_KEYS[d] || []) {
      const tag = JSON.stringify(key);
      if (seen.has(tag)) continue;
      seen.add(tag);
      prefixes.push(key);
    }
    const pred = predicateForDomain(d);
    if (pred) predicates.push(pred);
  }
  if (prefixes.length === 0 && predicates.length === 0) return Promise.resolve();
  // Tell the non-React-Query caches too (see bumpDataGeneration). Fires for a
  // sibling tab's broadcast as well — its write is just as real as ours.
  bumpDataGeneration();

  // React Query's own prefix rule for a non-exact queryKey filter: the query's
  // key starts with every segment of the filter key. All DOMAIN_KEYS entries
  // are string segments, so element equality is the whole comparison.
  const matchesPrefix = (queryKey: readonly unknown[]): boolean =>
    prefixes.some((k) => k.length <= queryKey.length && k.every((seg, i) => queryKey[i] === seg));
  const matches = (q: any): boolean => {
    const key = Array.isArray(q?.queryKey) ? q.queryKey : [];
    return matchesPrefix(key) || predicates.some((p) => p(q));
  };

  if (!remote) {
    return Promise.resolve(queryClient.invalidateQueries({ predicate: matches, refetchType: "active" })).then(() => undefined);
  }
  // A sibling tab's write: refetch what is on screen, but only MARK the
  // aggregate payloads stale (see AGGREGATE_KEYS).
  const isAggregate = (q: any) => AGGREGATE_KEYS.has(String(q?.queryKey?.[0]));
  return Promise.allSettled([
    queryClient.invalidateQueries({ predicate: (q) => matches(q) && !isAggregate(q), refetchType: "active" }),
    queryClient.invalidateQueries({ predicate: (q) => matches(q) && isAggregate(q), refetchType: "none" }),
  ]).then(() => undefined);
}

// Single-domain convenience
export function invalidateDomain(domain: Domain): Promise<void> {
  return invalidateDomains(domain);
}

/* ─── "Something changed" ticker ───────────────────────────────────────────
   React Query is not the only cache in the app. ⌘K search keeps its own
   60-second result cache, and nothing ever busted it: create a task and search
   a term you had searched a minute earlier and it was not there; delete
   something and it was still listed, and opening it landed on a record that no
   longer existed.

   Any cache outside React Query can subscribe here and drop what it holds when
   a write lands. Deliberately a counter rather than a domain list: a consumer
   at this level doesn't model domains, it just needs to know its snapshot is
   no longer current. */
let dataGeneration = 0;
const generationListeners = new Set<() => void>();

export function getDataGeneration(): number {
  return dataGeneration;
}

export function subscribeDataChange(fn: () => void): () => void {
  generationListeners.add(fn);
  return () => { generationListeners.delete(fn); };
}

function bumpDataGeneration(): void {
  dataGeneration++;
  for (const fn of generationListeners) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

// ─── Optimistic helpers ─────────────────────────────────────────────
// Reusable building blocks for the hot-path mutations (task toggle,
// habit toggle, delete). Keeps the boilerplate consistent and ensures
// rollback always happens.

export interface OptimisticListMutationOptions<TItem, TVars> {
  queryKey: unknown[];
  mutate: (vars: TVars) => Promise<any>;
  apply: (items: TItem[], vars: TVars) => TItem[];
  invalidate: Domain[];
}

export function buildOptimisticListMutation<TItem, TVars>(
  opts: OptimisticListMutationOptions<TItem, TVars>
) {
  return {
    mutationFn: opts.mutate,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: opts.queryKey });
      const previous = queryClient.getQueryData<TItem[]>(opts.queryKey);
      queryClient.setQueryData<TItem[]>(opts.queryKey, (old) =>
        opts.apply(old || [], vars)
      );
      return { previous };
    },
    onError: (_err: unknown, _vars: TVars, ctx: any) => {
      if (ctx?.previous) {
        queryClient.setQueryData(opts.queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      invalidateDomains(...opts.invalidate);
    },
  };
}

// ─── patchQueries ───────────────────────────────────────────────────
// Optimistic patch of EVERY cached query under a key prefix, with a restore
// function for rollback.
//
// Why a prefix and not an exact key: the live list keys carry the profile
// scope — ["/api/budgets", month, filterMode, ...filterIds],
// ["/api/trackers", filterMode, ...filterIds] — so an exact-key
// getQueryData(["/api/budgets", month]) hits an empty slot: the optimistic
// removal shows nothing and the "rollback" restores nothing (audit
// 2026-09-02, dashboard BudgetManager and trackers deleteTrackerMut). The
// setQueriesData prefix predicate reaches every variant, and the returned
// restore() puts back exactly the slots that were touched.
//
// Usage inside a mutation:
//   onMutate: async (id) => {
//     await queryClient.cancelQueries({ queryKey: ["/api/budgets", month] });
//     const restore = patchQueries(["/api/budgets", month], (old) => ...);
//     return { restore };
//   },
//   onError: (_e, _v, ctx) => ctx?.restore?.(),
//
// The updater may return undefined to leave a slot untouched (e.g. a shape it
// doesn't understand). Slots holding `undefined` are skipped entirely.
export function patchQueries(
  queryKey: readonly unknown[],
  updater: (old: any, key: readonly unknown[]) => any,
): () => void {
  const snapshots = queryClient.getQueriesData<any>({ queryKey: queryKey as unknown[] });
  for (const [key, old] of snapshots) {
    if (old === undefined) continue;
    const next = updater(old, key);
    if (next !== undefined && next !== old) queryClient.setQueryData(key, next);
  }
  return () => {
    for (const [key, old] of snapshots) queryClient.setQueryData(key, old);
  };
}

/** Compose several restore functions into one (runs in reverse order). */
export function composeRestores(...restores: Array<(() => void) | undefined>): () => void {
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]?.();
  };
}

// ─── Profile detail embeds ──────────────────────────────────────────
// ["/api/profiles", id, "detail"] is a ProfileDetail (shared/schema.ts): the
// profile row plus its embedded lists — relatedTasks, relatedTrackers,
// relatedHabits, relatedExpenses, ... The profile page renders those embeds,
// so an optimistic patch has to write THOSE fields. Several mutations wrote
// `tasks` / `trackers` instead (fields that don't exist on the payload), so
// the optimistic update never showed and the rollback restored an unchanged
// object (audit 2026-09-02 item 1). One helper, one field name.
export type ProfileDetailListField =
  | "relatedTasks" | "relatedTrackers" | "relatedHabits" | "relatedExpenses"
  | "relatedEvents" | "relatedDocuments" | "relatedObligations" | "childProfiles";

export function profileDetailKey(profileId: string): unknown[] {
  return ["/api/profiles", profileId, "detail"];
}

/**
 * Patch one embedded list on the cached ProfileDetail. Returns a restore
 * function; a no-op when nothing is cached or the embed is missing.
 */
export function patchProfileDetailList<TItem = any>(
  profileId: string,
  field: ProfileDetailListField,
  updater: (items: TItem[]) => TItem[],
): () => void {
  return patchQueries(profileDetailKey(profileId), (old: any) => {
    if (!old || !Array.isArray(old[field])) return undefined;
    const next = updater(old[field] as TItem[]);
    return next === old[field] ? undefined : { ...old, [field]: next };
  });
}

// ─── Dashboard upcoming bills ───────────────────────────────────────
// The dashboard's Bills section and the Now queue both render
// enhanced.financeSnapshot.upcomingBills (every scoped variant of
// ["/api/dashboard-enhanced", ...]). "Mark paid" must drop the row THERE —
// the /api/obligations entity lists still hold the obligation (it is live; it
// just advanced to its next due date), so removing it from those is wrong for
// every other consumer. Returns a restore function for rollback.
export function dropUpcomingBillFromDashboard(billId: string): () => void {
  return patchQueries(["/api/dashboard-enhanced"], (old: any) => {
    const bills = old?.financeSnapshot?.upcomingBills;
    if (!Array.isArray(bills)) return undefined;
    const next = bills.filter((b: any) => b?.id !== billId);
    if (next.length === bills.length) return undefined;
    return { ...old, financeSnapshot: { ...old.financeSnapshot, upcomingBills: next } };
  });
}

// ─── optimisticBust ─────────────────────────────────────────────────
// For AI chat (and any other write that can’t predict the new server
// state up front but still wants the UI to feel instant). Caller passes
// the domains the action touched and a `mutator` describing how each
// affected list should look after the change. The bus:
//   1. Cancels in-flight refetches so they don’t clobber our optimistic
//      state mid-flight.
//   2. Runs the mutator against current cached lists via setQueryData
//      — the UI updates synchronously without waiting for the network.
//   3. Kicks off the normal invalidateDomains() refetch in the
//      background so the optimistic state is replaced by the truth
//      from the server as soon as it arrives.
// If the network write is already in flight when this is called, the
// caller just needs to make sure the server result is applied via the
// usual mutation onSuccess path — or rely on the invalidation refetch.
export interface OptimisticBustEntry {
  // Query key (or prefix) to update. We match by JSON-equal on the
  // first element so ["/api/tasks"] hits every nested tasks query.
  queryKey: unknown[];
  // Receives the current cached value and returns the new value.
  // Return undefined to leave the cache untouched for that key.
  updater: (old: any) => any;
}

export async function optimisticBust(
  domains: Domain[],
  entries: OptimisticBustEntry[] = []
): Promise<void> {
  // Cancel anything in-flight that could overwrite our optimistic state.
  await Promise.allSettled(
    entries.map((e) => queryClient.cancelQueries({ queryKey: e.queryKey }))
  );

  // Apply optimistic updates. We use predicate matching so nested keys
  // (e.g. ["/api/tasks", profileId]) all receive the same updater.
  for (const entry of entries) {
    const head = entry.queryKey[0];
    queryClient.setQueriesData(
      {
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey[0] === head,
      },
      (old: any) => {
        const next = entry.updater(old);
        return next === undefined ? old : next;
      }
    );
  }

  // Background refetch — server is the source of truth.
  await invalidateDomains(...domains);
}
