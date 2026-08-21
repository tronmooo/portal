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
    ["/api/tasks"],
    // tasks affect KPI tile + dashboard widget + activity feed
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/activity"],
    ["/api/calendar/timeline"],
    ["/api/date-rules"],  // a due date is a deadline rule
    ["/api/insights"],
    ["/api/ai-digest"],
    // ...and the notification feed, which derives "due today" / "overdue"
    // straight from open tasks. Omitting it left a "X is due today" alert in
    // the bell after X had been ticked off (QA 2026-07-29 CRUD-T1-003) — the
    // server already excludes done tasks, the client just never re-asked.
    ["/api/notifications"],
  ],
  habits: [
    ["/api/habits"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/activity"],
    ["/api/insights"],
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
    ["/api/trackers"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/insights"],
    ["/api/ai-digest"],
    ["/api/activity"],
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
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/activity"],
    ["/api/insights"],
    ["/api/ai-digest"],
    // A profile OWNS dates — a date of birth, an anniversary, a licence or
    // passport expiration. Changing July 10 to July 11 has to move the yearly
    // birthday everywhere at once, which it cannot do while the calendar and
    // the rules list keep serving the pre-edit answer.
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/notifications"],
    // nested keys handled via predicate below
  ],
  assets: [
    ["/api/profiles"], // assets are profiles
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/rel-assets"],
    ["/api/cashflow"],
  ],
  liabilities: [
    ["/api/profiles"], // liabilities are profiles
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
  ],
  people: [
    ["/api/profiles"],
    ["/api/rel-people"],
    ["/api/dashboard-enhanced"],
  ],
  documents: [
    ["/api/documents"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/activity"],
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
    ["/api/expenses"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/budgets"],
    ["/api/budgets/summary"],
    ["/api/cashflow"],
    ["/api/activity"],
    ["/api/insights"],
    ["/api/ai-digest"],
  ],
  incomes: [
    ["/api/incomes"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/paychecks"],
    ["/api/cashflow"],
    // Recurring income is a calendar series now (a paycheck lands on a date).
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/insights"],
    ["/api/ai-digest"],
  ],
  obligations: [
    ["/api/obligations"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
    ["/api/loans/schedule"],
    ["/api/cashflow"],
    ["/api/insights"],
    ["/api/ai-digest"],
    ["/api/calendar/timeline"], // bills and loan payments are calendar items
    ["/api/date-rules"],        // …and each one is a payment rule
    ["/api/notifications"],     // "bill due" alerts derive from obligations
  ],
  budgets: [
    ["/api/budgets"],
    ["/api/budgets/summary"],
    ["/api/dashboard-enhanced"],
  ],
  goals: [
    ["/api/goals"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
  ],
  events: [
    ["/api/events"],
    ["/api/calendar/timeline"],
    ["/api/date-rules"],
    ["/api/dashboard-enhanced"],
    ["/api/activity"],
  ],
  journal: [
    ["/api/journal"],
    ["/api/journal-entries"],
    ["/api/dashboard-enhanced"],
    ["/api/stats"],
  ],
  artifacts: [
    ["/api/artifacts"],
    ["/api/chat-artifacts"],
    ["/api/dashboard-enhanced"],
    ["/api/activity"],
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
          k0.startsWith("/api/assets/") ||
          k0.startsWith("/api/liabilities/") ||
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
      // remote=true so the replay doesn't re-broadcast (no infinite ping-pong).
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
  try { channel()?.postMessage({ domains }); } catch {}
  return invalidateDomainsInternal(domains, true);
}

function invalidateDomainsInternal(domains: Domain[], _remote: boolean): Promise<void> {
  const seen = new Set<string>();
  const promises: Promise<unknown>[] = [];

  for (const d of domains) {
    // 1. Explicit top-level keys
    for (const key of DOMAIN_KEYS[d] || []) {
      const tag = JSON.stringify(key);
      if (seen.has(tag)) continue;
      seen.add(tag);
      promises.push(
        queryClient.invalidateQueries({ queryKey: key, refetchType: "active" })
      );
    }
    // 2. Predicate match for nested keys
    const pred = predicateForDomain(d);
    if (pred) {
      promises.push(
        queryClient.invalidateQueries({ predicate: pred, refetchType: "active" })
      );
    }
  }

  return Promise.allSettled(promises).then(() => undefined);
}

// Single-domain convenience
export function invalidateDomain(domain: Domain): Promise<void> {
  return invalidateDomains(domain);
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
