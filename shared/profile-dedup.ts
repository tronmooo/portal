// shared/profile-dedup.ts
//
// Profile duplicate-detection policy (product decision 2026-06):
//   - Duplicates are ALLOWED for every profile type EXCEPT people. You can own
//     two "Samsung TV"s, nest a "Tv" under a laptop, have two "Chase" accounts.
//   - Only PEOPLE (person / self) must be unique, and ONLY on an EXACT full-name
//     match (first + last, case/whitespace-insensitive). No fuzzy/AI matching —
//     that produced false positives like "Tv" ≈ "Samsung TV" that blocked valid
//     creates.
//
// This lives in /shared and is the SINGLE source of truth used by the create
// route, so the policy is unit-tested and can't silently regress.

export const PERSON_PROFILE_TYPES = new Set(["person", "self"]);

/** Normalize a person name for exact-match comparison. */
export function normalizePersonName(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface DedupCandidate { name?: string | null; type?: string | null; }
export interface DedupExisting { id?: string; name?: string | null; type?: string | null; deletedAt?: unknown; }

/**
 * Returns the existing profile that should BLOCK creation of `candidate`, or
 * null when creation is allowed. Pure — no I/O — so it's testable and identical
 * on client and server.
 */
export function findBlockingDuplicateProfile<T extends DedupExisting>(
  candidate: DedupCandidate,
  existing: ReadonlyArray<T>,
): T | null {
  if (!candidate || !PERSON_PROFILE_TYPES.has(String(candidate.type))) return null;
  const target = normalizePersonName(candidate.name);
  if (!target) return null;
  for (const p of existing) {
    if (!PERSON_PROFILE_TYPES.has(String(p.type))) continue;
    if (p.deletedAt) continue;
    if (normalizePersonName(p.name) === target) return p;
  }
  return null;
}
