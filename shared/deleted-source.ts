// What a deleted bill or debt leaves behind.
//
// Owner, 2026-11-27: "Deleting a bill should stop future obligations, not erase
// historical financial transactions. Preserve the original bill name and a
// historical reference so payments remain traceable. Provide a separate
// explicit option to delete historical payments."
//
// A payment's expense carries `liability:<id>` (server/liability-payments.ts).
// When the liability is deleted that id names nothing, so each surviving
// expense gains ONE tag holding the name it was paid to. The expense itself —
// amount, date, category, owner — is not touched.
// Guard: tests/deleted-bill-keeps-history.test.ts.
export const DELETED_SOURCE_TAG_PREFIX = "from-deleted:";
export const LIABILITY_TAG_PREFIX = "liability:";

/** The expenses recorded by payments of this liability. */
export function paymentExpensesOf<T extends { tags?: readonly string[] | null }>(expenses: readonly T[], liabilityId: string): T[] {
  const tag = `${LIABILITY_TAG_PREFIX}${liabilityId}`;
  return expenses.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
}

/** The tags with the deleted source's name recorded once. */
export function withDeletedSourceTag(tags: readonly string[] | null | undefined, name: string): string[] {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80) || "a deleted bill";
  return [...(tags || []).filter((t) => !String(t).startsWith(DELETED_SOURCE_TAG_PREFIX)), `${DELETED_SOURCE_TAG_PREFIX}${clean}`];
}

/** "Harbor Water" from a surviving expense's tags, or null. */
export function deletedSourceName(tags: readonly string[] | null | undefined): string | null {
  const t = (tags || []).find((x) => String(x).startsWith(DELETED_SOURCE_TAG_PREFIX));
  return t ? String(t).slice(DELETED_SOURCE_TAG_PREFIX.length) : null;
}
