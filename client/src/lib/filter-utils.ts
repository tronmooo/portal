/**
 * Normalize a string for filter comparison.
 * Trims whitespace and lowercases — prevents "Food" !== "food" or "food " !== "food".
 */
export function normalizeFilter(value: string | undefined | null): string {
  return (value || "").trim().toLowerCase();
}

/**
 * Check if a value matches the active filter.
 * Returns true if filter is "all" or if the normalized values match.
 */
export function matchesFilter(value: string, filter: string): boolean {
  if (normalizeFilter(filter) === "all") return true;
  return normalizeFilter(value) === normalizeFilter(filter);
}

/**
 * Filter an array by a category/type field with normalization.
 * If filter is "all", returns the full array.
 */
export function filterByCategory<T>(
  items: T[],
  filter: string,
  getCategory: (item: T) => string
): T[] {
  if (normalizeFilter(filter) === "all") return items;
  const norm = normalizeFilter(filter);
  return items.filter(item => normalizeFilter(getCategory(item)) === norm);
}

/**
 * Profile filter helper: filter items by linked profile IDs.
 * Returns all items if mode is "everyone" or no IDs selected.
 */
export function filterByProfile<T>(
  items: T[],
  filterMode: string,
  filterIds: string[],
  getLinkedProfiles: (item: T) => string[] | undefined | null
): T[] {
  if (filterMode === "everyone" || filterIds.length === 0) return items;
  return items.filter(item => {
    const linked = getLinkedProfiles(item) || [];
    // Items with no linked profiles show when filtering (they're "unassigned")
    if (linked.length === 0) return false;
    return linked.some(id => filterIds.includes(id));
  });
}
