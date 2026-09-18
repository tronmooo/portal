// shared/memory-visibility.ts — which memory rows are the USER's facts, and
// which are the app's own bookkeeping.
//
// QA 2026-09-18 BUG-19: a profile's Info tab listed "Facts from chat:
// TRACKER-CATEGORY:VIDEO GAMES". That row is a learned classification
// (server/ai-engine rememberCategoryMapping stores "tracker-category:<name>" →
// category under `category: "system"`) — a routing token the app wrote for
// itself, not something the user said. The memories store is the right place
// for it, but the user-facing listing is not. One predicate, so the API and
// any renderer agree on what is internal. Pinned by
// tests/chat-engine-qa-2026-09-18.test.ts.

/** Categories the app writes for its own use; never a user-stated fact. */
const INTERNAL_MEMORY_CATEGORIES: ReadonlySet<string> = new Set(["system", "internal"]);

/** Key prefixes that are machine tokens rather than facts. */
const INTERNAL_KEY_PREFIXES = ["tracker-category:", "__", "sys:", "internal:"];

export function isInternalMemory(m: { key?: unknown; category?: unknown } | null | undefined): boolean {
  if (!m) return false;
  const category = String(m.category ?? "").toLowerCase().trim();
  if (INTERNAL_MEMORY_CATEGORIES.has(category)) return true;
  const key = String(m.key ?? "").toLowerCase().trim();
  return INTERNAL_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/** The memories a person should see as "facts from chat". */
export function userVisibleMemories<T extends { key?: unknown; category?: unknown }>(rows: readonly T[]): T[] {
  return rows.filter((m) => !isInternalMemory(m));
}
