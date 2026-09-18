// ── Profiles, grouped for a "link to" picker ─────────────────────────────────
// Pure, no I/O.
//
// The New Event dialog offered sixteen unsorted, unlabelled chips mixing
// people with bills, vehicles, an address and a mistyped tyre purchase (QA
// 2026-09-18 F-31). One rule for the picker: group by what the profile IS,
// label the group, sort inside it, and keep only real people — self, person,
// pet — under "People", which is also the set a record can be FOR.

import { isOfferablePerson } from "./entity-classify";

export interface LinkableProfile {
  id: string;
  name: string;
  type?: string | null;
}

export interface ProfileLinkGroup<T extends LinkableProfile = LinkableProfile> {
  id: string;
  label: string;
  items: T[];
}

/** The profile types that can own a task or event: real people and pets. */
export const PEOPLE_TYPES: ReadonlySet<string> = new Set(["self", "person", "pet"]);

const GROUPS: Array<{ id: string; label: string; types: readonly string[] }> = [
  { id: "people", label: "People", types: ["self", "person", "pet"] },
  { id: "vehicles", label: "Vehicles", types: ["vehicle"] },
  { id: "places", label: "Places", types: ["property"] },
  { id: "bills", label: "Bills & accounts", types: ["liability", "loan", "subscription", "account"] },
  { id: "assets", label: "Assets", types: ["asset", "investment"] },
  { id: "medical", label: "Medical", types: ["medical"] },
];

const byName = <T extends LinkableProfile>(a: T, b: T) =>
  String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
const selfFirst = <T extends LinkableProfile>(a: T, b: T) =>
  Number(b.type === "self") - Number(a.type === "self") || byName(a, b);

/** A real person: a people type AND not a possession mistyped as one
 *  ("tires for my Dodge ram" — QA 2026-09-18 F-04). */
export function isPersonLikeProfile(p: { type?: string | null; name?: string | null } | null | undefined): boolean {
  return PEOPLE_TYPES.has(String(p?.type || "")) && isOfferablePerson(p);
}

/** Only the profiles a record can be FOR — self first, then people and pets by name. */
export function ownerCandidates<T extends LinkableProfile>(profiles: readonly T[] | null | undefined): T[] {
  return (profiles || []).filter(isPersonLikeProfile).slice().sort(selfFirst);
}

/**
 * Every profile, in labelled groups (empty groups dropped, unknown types
 * under "Other"). Within a group the self profile leads and the rest sort by
 * name, so the list reads the same every time it opens.
 */
export function groupProfilesForLinking<T extends LinkableProfile>(profiles: readonly T[] | null | undefined): ProfileLinkGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const other: T[] = [];
  for (const p of profiles || []) {
    const t = String(p?.type || "");
    // A mistyped possession never sits under People — it lands with the things.
    const g = PEOPLE_TYPES.has(t) && !isOfferablePerson(p) ? undefined : GROUPS.find((x) => x.types.includes(t));
    if (!g) { other.push(p); continue; }
    const list = buckets.get(g.id) || [];
    list.push(p);
    buckets.set(g.id, list);
  }
  const out: ProfileLinkGroup<T>[] = [];
  for (const g of GROUPS) {
    const items = buckets.get(g.id);
    if (!items || items.length === 0) continue;
    items.sort(selfFirst);
    out.push({ id: g.id, label: g.label, items });
  }
  if (other.length > 0) out.push({ id: "other", label: "Other", items: other.sort(byName) });
  return out;
}
