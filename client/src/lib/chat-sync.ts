// ─── AI write → UI synchronization ──────────────────────────────────────────
//
// The problem this solves: a chat turn wrote a row to the database, the AI
// confirmed it, and the page that lists that row still showed the old data
// until the user hit refresh.
//
// The old path (chat.tsx `invalidateAll`) did two things wrong. It never used
// the row the server had already returned, so the UI could only show the new
// item once a REFETCH came back — and it fired that refetch immediately, into a
// window where the server's version-stamped response cache could still serve
// pre-write data, which React Query then stored as fresh for a full staleTime.
// Hence "not there → refresh → there".
//
// The path here:
//   1. Record the server's post-write data version, so every request this
//      function triggers is a read-your-writes read (see queryClient.ts).
//   2. Patch the returned rows straight into every cached list that shows them,
//      synchronously. The UI is correct before any network call.
//   3. Invalidate the affected DOMAINS through the cache bus — which also
//      broadcasts to other tabs and covers nested keys — as the background
//      reconcile. The server stays the source of truth; it just no longer gates
//      what the user sees.
//
// Anything the server couldn't describe precisely arrives as the "everything"
// domain, which degrades to exactly the blanket invalidation this replaces.
import type { ChatMutation } from "@shared/schema";
import type { Domain } from "@shared/entity-domains";
import { noteDataVersion } from "./queryClient";
import { invalidateDomains } from "./cache-bus";
import { perfMark, perfMeasure } from "./perf-marks";
import { applyRowPatches, toDomains, scopeIdsFromKey } from "./cache-patch";

export { applyRowPatches, scopeIdsFromKey };

/**
 * Entry point: apply a chat turn's change manifest.
 *
 * `mutations` absent (an older server, or a turn we couldn't describe) falls
 * back to the blanket invalidation this replaced, so a write is never missed.
 */
export async function applyChatMutations(
  mutations: ChatMutation[] | undefined | null,
  dataVersion?: unknown,
): Promise<void> {
  noteDataVersion(dataVersion);
  perfMark("chat:mutations-start");

  if (!Array.isArray(mutations) || mutations.length === 0) {
    await invalidateDomains("everything");
    perfMeasure("chat:sync(fallback)", "chat:mutations-start");
    return;
  }

  // 1. Optimistic patch — synchronous, so the next render already has the row.
  applyRowPatches(mutations);
  perfMark("chat:cache-applied");
  perfMeasure("chat:cache-patch", "chat:mutations-start");

  // 2. Background reconcile over every affected domain (cross-tab included).
  //    "dashboard" is always included: every write moves a KPI tile, the
  //    activity feed, or the bootstrap payload that seeds the next launch, and
  //    those aggregates can't be patched from a single row.
  const domains = new Set<Domain>(["dashboard"]);
  for (const m of mutations) for (const d of toDomains(m.domains)) domains.add(d);
  await invalidateDomains(...domains);
  perfMeasure("chat:sync", "chat:mutations-start");
}

