// shared/domain/ownership.ts — record → canonical entity → canonical owner → visibility.
//
// `shared/scope.ts` answers "is this in scope?" and `shared/ownership.ts`
// owns the WRITE of ownership. Neither answers the question every surface was
// answering for itself — "WHO owns this, and may the current profile see it?"
// The chat engine had a fourth parent-chain walk (resolveEntityOwner), search
// had its own predicate, and the two disagreed about orphans and pets.
//
// This is the one resolver. It returns the canonical owner (the first PERSON
// up the nesting chain, or the linked people), never guesses from names, and
// never claims both "unassigned" and "belongs to X" at once.
//
// Pure. Pinned by tests/consistency-layer-ownership.test.ts.

import {
  isPersonType, isPersonLikeType, withAncestorOwnerIds, selfIdsFrom,
  ownerChainForProfile, isInScope,
} from "../scope";
import { passesProfileFilter, type ProfileFilterContext } from "../profile-filter";
import { nameLooselyMatches } from "../name-match";
import { canonicalEntityType, type CanonicalEntityType, type RecordSource } from "./entity-types";

export interface ProfileLike {
  id: string;
  name?: string | null;
  type?: string | null;
  parentProfileId?: string | null;
}

export interface OwnershipLinkLike {
  assetProfileId?: string | null;
  liabilityProfileId?: string | null;
  partyProfileId?: string | null;
}

export interface OwnershipContext {
  /** Every profile the user owns (unscoped). */
  profiles: ReadonlyArray<ProfileLike>;
  assetPartyLinks?: ReadonlyArray<OwnershipLinkLike> | null;
  liabilityProfileLinks?: ReadonlyArray<OwnershipLinkLike> | null;
}

/** How the user asked for data to be scoped. */
export type ScopeMode = "everyone" | "current" | "explicit";

export interface ResolvedScope {
  mode: ScopeMode;
  /** Profile ids in scope. Empty when `mode === "everyone"`. */
  profileIds: string[];
  /** "Everyone" | "Bob" | "Bob and Jane". */
  label: string;
  /** True when the user named another profile or asked for Everyone. */
  explicitlyRequested: boolean;
}

export type Visibility = "visible" | "hidden";

export interface ResolvedOwnership {
  entityType: CanonicalEntityType;
  entityId: string | null;
  /** Direct owner ids as stored on the record (linkedProfiles / profileId / parent). */
  linkedIds: string[];
  /** The people (person/self) who own the record, after walking nesting. */
  ownerIds: string[];
  ownerNames: string[];
  /** The one canonical owner: the first person found; null when unassigned. */
  canonicalOwnerId: string | null;
  canonicalOwnerName: string | null;
  /** True when no owner can be determined. Mutually exclusive with a canonical owner. */
  unassigned: boolean;
}

function byId(ctx: OwnershipContext): Map<string, ProfileLike> {
  return new Map(ctx.profiles.map((p) => [p.id, p]));
}

function linkedIdsOf(source: RecordSource | string, row: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v && !out.includes(v)) out.push(v); };
  if (Array.isArray(row?.linkedProfiles)) for (const id of row.linkedProfiles) push(id);
  if (Array.isArray(row?.ownerIds)) for (const id of row.ownerIds) push(id);
  push(row?.profileId);
  push(row?.ownerProfileId);
  if (source === "profile") {
    push(row?.parentProfileId);
  }
  return out;
}

/** People reachable from a set of ids by walking nesting upward. */
function peopleFrom(ids: readonly string[], ctx: OwnershipContext): string[] {
  const map = byId(ctx);
  const people: string[] = [];
  for (const id of withAncestorOwnerIds(ids, ctx.profiles)) {
    const p = map.get(id);
    if (p && isPersonType(p.type) && !people.includes(id)) people.push(id);
  }
  return people;
}

/**
 * Resolve who owns a record. Ownership is read ONLY from structured data:
 * linkedProfiles / profileId / parentProfileId / the link tables. Names are
 * never consulted.
 */
export function resolveOwnership(source: RecordSource | string, row: any, ctx: OwnershipContext): ResolvedOwnership {
  const entityType = canonicalEntityType(source, row);
  const entityId = typeof row?.id === "string" ? row.id : null;
  const map = byId(ctx);
  let linkedIds = linkedIdsOf(source, row);
  let ownerIds: string[];

  if (source === "profile" && entityId) {
    const self = map.get(entityId) ?? row;
    if (isPersonType(self?.type)) {
      // A person owns themself; nesting under another person conveys nothing.
      ownerIds = [entityId];
      linkedIds = [entityId];
    } else {
      const chain = ownerChainForProfile(self, ctx.profiles as any, ctx.assetPartyLinks as any, ctx.liabilityProfileLinks as any);
      ownerIds = peopleFrom(chain, ctx);
      // A pet is owned by a person; a thing nested under a pet is that person's.
      if (ownerIds.length === 0) {
        const petOwner = chain.map((id) => map.get(id)).find((p) => p && isPersonLikeType(p.type));
        if (petOwner) ownerIds = peopleFrom([petOwner.id], ctx);
      }
      linkedIds = chain;
    }
  } else {
    ownerIds = peopleFrom(linkedIds, ctx);
  }

  const ownerNames = ownerIds.map((id) => String(map.get(id)?.name ?? "")).filter(Boolean);
  const canonicalOwnerId = ownerIds[0] ?? null;
  return {
    entityType,
    entityId,
    linkedIds,
    ownerIds,
    ownerNames,
    canonicalOwnerId,
    canonicalOwnerName: canonicalOwnerId ? (map.get(canonicalOwnerId)?.name ?? null) : null,
    unassigned: canonicalOwnerId === null,
  };
}

/** "Bob's" / "Bob and Jane's" / "Unassigned" — never both at once. */
export function describeOwner(o: ResolvedOwnership): string {
  if (o.unassigned) return "Unassigned";
  if (o.ownerNames.length === 1) return `${o.ownerNames[0]}'s`;
  return `${o.ownerNames.slice(0, -1).join(", ")} and ${o.ownerNames[o.ownerNames.length - 1]}'s`;
}

/**
 * May a record be shown under `scope`? Delegates to the app-wide
 * `passesProfileFilter` rule for entities (orphans belong to Self) and to the
 * profile chain rule for profiles, so this cannot drift from the dashboard.
 */
export function visibilityFor(source: RecordSource | string, row: any, scope: ResolvedScope, ctx: OwnershipContext): Visibility {
  if (scope.mode === "everyone" || scope.profileIds.length === 0) return "visible";
  const filterCtx: ProfileFilterContext = {
    selectedIds: scope.profileIds,
    allProfiles: ctx.profiles as any,
    assetPartyLinks: ctx.assetPartyLinks as any,
    liabilityProfileLinks: ctx.liabilityProfileLinks as any,
  };
  if (source === "profile") {
    const id = typeof row?.id === "string" ? row.id : "";
    if (scope.profileIds.includes(id)) return "visible";
    const o = resolveOwnership(source, row, ctx);
    if (isPersonType(row?.type)) return "hidden";
    const candidates = [id, ...o.linkedIds, ...o.ownerIds];
    return isInScope(candidates, { selectedIds: scope.profileIds, selfIds: selfIdsFrom(ctx.profiles as any) }, "out_of_scope")
      ? "visible" : "hidden";
  }
  const linked = linkedIdsOf(source, row);
  return passesProfileFilter(linked, filterCtx) ? "visible" : "hidden";
}

/** The rows of `rows` the scope may see. */
export function filterVisible<T>(source: RecordSource | string, rows: readonly T[], scope: ResolvedScope, ctx: OwnershipContext): T[] {
  if (scope.mode === "everyone" || scope.profileIds.length === 0) return [...rows];
  return rows.filter((r) => visibilityFor(source, r, scope, ctx) === "visible");
}

// ─── Requested scope ────────────────────────────────────────────────────────

const EVERYONE_RE = /\b(everyone|everybody|all profiles|every profile|whole (family|household)|the family|across (all|everyone)|for all of us|all of us|each person|each profile|per person|by person|by profile)\b/i;
const CROSS_RE = /\b(compare|combined|total(?:s)? (?:for|across)|between)\b/i;
/** "Sarah and I", "with Jane", "both of us": the speaker is part of it too. */
const SELF_TOO_RE = /\b(i|me|my|mine|we|us|our|ours|with|both|together)\b/i;

export interface ScopeRequestInput {
  /** The user's message. */
  message: string;
  /** The profile the app is currently showing ("current profile"), if any. */
  currentProfileId?: string | null;
  /** The selection the user made in the profile switcher (empty = everyone). */
  selectedProfileIds?: readonly string[] | null;
  profiles: ReadonlyArray<ProfileLike>;
}

/**
 * Which profiles a question is about.
 *
 *   "what does Jane owe?"  (current: Bob) → explicit [Jane]
 *   "show everyone's tasks"                → everyone
 *   "what do I owe?"       (current: Bob)  → current [Bob]
 *
 * Names are matched only against PEOPLE and pets (a vehicle named "Ram" is
 * not a scope), with whole-word matching, so "Ann" does not select "Joanna".
 */
export function resolveRequestedScope(input: ScopeRequestInput): ResolvedScope {
  const msg = String(input.message || "");
  const people = input.profiles.filter((p) => isPersonLikeType(p.type) && p.name);
  const nameOf = (id: string) => input.profiles.find((p) => p.id === id)?.name ?? "";
  const labelFor = (ids: string[]) => {
    const names = ids.map(nameOf).filter(Boolean);
    if (names.length === 0) return "Current profile";
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  };

  if (EVERYONE_RE.test(msg)) {
    return { mode: "everyone", profileIds: [], label: "Everyone", explicitlyRequested: true };
  }
  const named = people.filter((p) => {
    const n = String(p.name).trim();
    if (!n) return false;
    // Whole-word (or possessive) mention of the person's first or full name.
    const first = n.split(/\s+/)[0];
    const re = new RegExp(`(^|[^\\p{L}])(${escapeRe(n)}|${escapeRe(first)})(?:'s|’s)?(?=$|[^\\p{L}])`, "iu");
    return re.test(msg);
  });
  const selected = (input.selectedProfileIds || []).filter((id) => typeof id === "string" && id);
  const current = selected.length > 0 ? selected : input.currentProfileId ? [input.currentProfileId] : [];
  if (named.length > 0) {
    // Naming a person only NARROWS an existing selection. With no current
    // profile the user restricted nothing, and "Sarah and I played soccer"
    // must still reach the speaker's own records.
    if (current.length === 0) return { mode: "everyone", profileIds: [], label: "Everyone", explicitlyRequested: true };
    const ids = [...named.map((p) => p.id)];
    if (SELF_TOO_RE.test(msg)) for (const id of current) if (!ids.includes(id)) ids.push(id);
    return { mode: "explicit", profileIds: ids, label: labelFor(ids), explicitlyRequested: true };
  }
  if (CROSS_RE.test(msg) && people.length > 1) {
    return { mode: "everyone", profileIds: [], label: "Everyone", explicitlyRequested: true };
  }
  if (selected.length > 0) {
    return { mode: "current", profileIds: [...selected], label: labelFor([...selected]), explicitlyRequested: false };
  }
  if (input.currentProfileId) {
    return { mode: "current", profileIds: [input.currentProfileId], label: labelFor([input.currentProfileId]), explicitlyRequested: false };
  }
  return { mode: "everyone", profileIds: [], label: "Everyone", explicitlyRequested: false };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `search` name this profile? Thin wrapper so callers never hand-roll it. */
export function profileNameMatches(profile: ProfileLike, search: string): boolean {
  return nameLooselyMatches(profile.name, search);
}

/**
 * The full pipeline for one record set: resolve ownership for each row and
 * keep only the rows the scope may see. Returns rows paired with their
 * ownership so a renderer can label "Bob's" without recomputing it.
 */
export function resolveVisibleRecords<T>(
  source: RecordSource | string,
  rows: readonly T[],
  scope: ResolvedScope,
  ctx: OwnershipContext,
): Array<{ record: T; ownership: ResolvedOwnership }> {
  const out: Array<{ record: T; ownership: ResolvedOwnership }> = [];
  for (const record of rows) {
    if (visibilityFor(source, record, scope, ctx) !== "visible") continue;
    out.push({ record, ownership: resolveOwnership(source, record, ctx) });
  }
  return out;
}
