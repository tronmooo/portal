// ── Profile tab deep-links (pure, no React) ──────────────────────────────────
// `/profiles/:id/<slug>` deep-links one tab of a profile page. Tab LABELS vary
// by profile type (a pet has no "Productivity" tab, a loan has no "Trackers"),
// so a slug resolves against whichever tab set that profile's type actually
// has, falling back to the first tab. These are the slugs the router treats as
// a tab segment rather than a 404 — anything else under /profiles/:id/ is not
// a tab. Unit-tested in tests/profile-tab-slugs.test.ts.

export const PROFILE_TAB_SLUGS = [
  "overview",
  "info",
  "finance",
  "trackers",
  "documents",
  "productivity",
  "history",
] as const;

export type ProfileTabSlug = (typeof PROFILE_TAB_SLUGS)[number];

export function isProfileTabSlug(value: string): boolean {
  return (PROFILE_TAB_SLUGS as readonly string[]).includes(value.toLowerCase());
}

/** "Productivity" → "productivity"; "Health & Vet" → "health-vet". */
export function tabSlugFromLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve a URL slug to a tab `value` for a specific profile's tab set.
 * Matches the tab's label-slug first ("overview" → the tab labelled
 * "Overview"), then its internal value ("person-trackers"), so both the
 * user-facing and internal forms deep-link. Unknown slug → first tab.
 */
export function resolveProfileTab(
  tabs: { value: string; label: string }[],
  slug: string | undefined,
): string {
  const fallback = tabs[0]?.value ?? "info";
  if (!slug) return fallback;
  const s = slug.toLowerCase();
  const hit = tabs.find(t => tabSlugFromLabel(t.label) === s)
    ?? tabs.find(t => t.value.toLowerCase() === s);
  return hit?.value ?? fallback;
}

/** Inverse of resolveProfileTab — the canonical URL slug for a tab value. */
export function slugForProfileTab(
  tabs: { value: string; label: string }[],
  value: string,
): string {
  const hit = tabs.find(t => t.value === value);
  return hit ? tabSlugFromLabel(hit.label) : value;
}
