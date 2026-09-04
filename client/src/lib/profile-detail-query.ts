// client/src/lib/profile-detail-query.ts — the ONE fetch+seed path for a
// profile's detail payload.
//
// PERF (2026-09-04, "the asset profile takes long to load"): opening a profile
// used to be a cold serverless round-trip the user watched as a full-page
// skeleton. `warmProfileDetail` (scope-prefetch.ts) already fired the same
// bootstrap on hover/touch, but deliberately wrote NOTHING to the client cache
// — so the warmup only heated the SERVER's 30s response cache and the page
// still paid a second network round-trip after navigation.
//
// Hoisting the queryFn here lets the warmup and the page share one query
// identity: the warm prefetch writes ["/api/profiles", id, "detail"], and the
// page's useQuery for that key either reads it straight from cache (instant) or
// attaches to the in-flight prefetch (React Query dedupes) instead of firing a
// second request. Shape risk — the reason the warmup wrote nothing before — is
// gone because there is now exactly one function producing that shape.
import { apiRequest, queryClient } from "./queryClient";
import { flattenProfile } from "./flattenProfile";

/** The cache key profile-detail.tsx and liability-detail.tsx both read. */
export const profileDetailKey = (id: string) => ["/api/profiles", id, "detail"] as const;

/**
 * ONE round-trip. /api/profile-bootstrap/:id returns detail + tree +
 * allProfiles + assetPartyLinks + liabilityProfileLinks in a single response.
 * Previously the page fired the bootstrap AND /detail AND /api/profiles AND
 * /tree in parallel on every open — the heavy getProfileDetail aggregation ran
 * TWICE server-side and the profiles table was scanned three more times.
 *
 * Seeding the sibling cache keys here lets the page's dependent queries (and
 * every child component reading the same keys) resolve from cache with no
 * extra network calls.
 */
export async function fetchProfileDetail(id: string): Promise<any> {
  try {
    const res = await apiRequest("GET", `/api/profile-bootstrap/${id}`);
    const b = await res.json();
    if (b && typeof b === "object" && b.detail) {
      if (b.tree) queryClient.setQueryData(["/api/profiles", id, "tree"], b.tree);
      if (b.profiles) queryClient.setQueryData(["/api/profiles"], b.profiles);
      if (b.assetPartyLinks) queryClient.setQueryData(["/api/asset-party-links"], b.assetPartyLinks);
      if (b.liabilityProfileLinks) queryClient.setQueryData(["/api/liability-profile-links"], b.liabilityProfileLinks);
      // Type-specific extras (PERF 2026-07-08): pre-seed the queries the
      // asset/liability pages fire right after the detail resolves, so opening
      // those profiles costs ONE round-trip instead of 5-6. Key shapes must
      // match the consumers exactly — liability-detail.tsx uses both the array
      // form ["/api/liabilities", id, "parties"] and the template-string form
      // [`/api/liabilities/${id}/parties`] for parties, so both slots are seeded.
      if (b.assetParties) queryClient.setQueryData(["/api/assets", id, "parties"], b.assetParties);
      if (b.liabilityExtras && typeof b.liabilityExtras === "object") {
        const ex = b.liabilityExtras;
        if (ex.payments) queryClient.setQueryData([`/api/liabilities/${id}/payments`], ex.payments);
        if (ex.schedule) queryClient.setQueryData(["/api/liabilities", id, "schedule"], ex.schedule);
        if (ex.parties) {
          queryClient.setQueryData(["/api/liabilities", id, "parties"], ex.parties);
          queryClient.setQueryData([`/api/liabilities/${id}/parties`], ex.parties);
        }
        if (ex.assets) queryClient.setQueryData([`/api/liabilities/${id}/assets`], ex.assets);
      }
      // Flatten nested storage paths (fields.vehicles.*, fields.insurance.*,
      // fields.housing.*, fields.other.*, fields.finance.*) up to top level so
      // every reader (`f.licensePlate`, `f.currentValue`, `f.year`, etc.) works
      // regardless of how the value was originally written.
      return flattenProfile(b.detail);
    }
  } catch (err: any) {
    // 404 = the profile genuinely doesn't exist — surface the error state.
    if (String(err?.message || "").startsWith("404")) throw err;
    // Any other failure (transient network, older server build) falls through
    // to the legacy per-endpoint fetch below.
  }
  const res = await apiRequest("GET", `/api/profiles/${id}/detail`);
  return flattenProfile(await res.json());
}

/**
 * Instant-paint placeholder built from the profiles list already in cache.
 *
 * Every screen that links to a profile (dashboard Assets grid, trackers, search)
 * has already loaded /api/profiles, which carries the profile's identity and its
 * whole `fields` map — everything the hero, the value and the detail rows read.
 * Handing that to the detail query as placeholder data paints the real page
 * immediately instead of a full-page skeleton, and the linked-data tabs fill in
 * when the bootstrap lands a moment later.
 *
 * Returns undefined when the list isn't cached (a cold deep-link), so the page
 * falls back to its skeleton exactly as before.
 */
export function profileDetailPlaceholder(id: string | undefined): any {
  if (!id) return undefined;
  const list = queryClient.getQueryData<any[]>(["/api/profiles"]);
  if (!Array.isArray(list)) return undefined;
  const row = list.find((p) => p && p.id === id);
  if (!row) return undefined;
  return flattenProfile({
    ...row,
    // The related* arrays are the part the bootstrap still has to fetch. Empty
    // (not missing) so every `profile.relatedX.map(...)` reader is safe; each
    // section renders its own empty state for the moment before real data lands.
    relatedTrackers: [],
    relatedExpenses: [],
    relatedTasks: [],
    relatedEvents: [],
    relatedDocuments: [],
    relatedObligations: [],
    relatedHabits: [],
    relatedJournal: [],
    childProfiles: (list as any[]).filter((p) => p && p.parentProfileId === id),
    timeline: [],
  });
}
