// ─────────────────────────────────────────────────────────────────────────────
// OWNERSHIP MODEL — single source of truth for fractional ownership.
//
// Pure, dependency-free, and DOM/DB-free so BOTH the server (net-worth and
// dashboard math) and the client (the ownership editor + badges) import the
// exact same rules, and so it is unit-testable in plain node.
//
// Product rules (decided 2026-06):
//   1. Ownership is EXPLICIT fractional shares per party (asset_party_links /
//      liability_profile_links), each 0–100, and — when any owner is assigned —
//      they MUST total exactly 100%. There is no silent auto-equalization; the
//      old "split to 50/50" DB trigger is replaced by strict validation.
//   2. If NO explicit owners are assigned, ownership defaults to the SELF
//      ("Me") profile at 100%. New assets auto-assign 100% to Self.
//   3. NESTING (parentProfileId / containment) is purely organizational
//      ("contained in / location"). It does NOT attribute net worth. Net worth
//      is driven solely by ownership shares from this module.
// ─────────────────────────────────────────────────────────────────────────────

/** A single explicit ownership share, mirroring an asset_party_links /
 *  liability_profile_links row (only the fields ownership math needs). */
export interface OwnershipLink {
  partyProfileId: string;
  ownershipPercentage: number; // 0–100
  role?: string;
}

/** A resolved owner of an asset/liability after applying the default rules. */
export interface OwnerShare {
  ownerId: string;
  pct: number; // 0–100
  /** True when this share comes from the Self-100% default (no explicit links),
   *  false when the user explicitly assigned it. Lets the UI badge "Ownership
   *  not set — defaults to you" vs a real assignment. */
  implicit: boolean;
}

/** Float tolerance for percentage sums (avoids 33.33×3 ≠ 100 rejections). */
export const OWNERSHIP_EPSILON = 0.05;

/** Only "owner-like" roles convey net-worth ownership. Co-signers / guarantors /
 *  authorized users are relationships, NOT ownership, so they're excluded from
 *  share math. */
const OWNER_ROLES = new Set(["owner", "co_owner", "co-owner", ""]);

function isOwnerRole(role?: string): boolean {
  return OWNER_ROLES.has((role || "owner").toLowerCase());
}

/**
 * Resolve the effective owners of one asset/liability.
 *
 * - Explicit owner links (owner-role, pct > 0) win and are returned as-is.
 * - Otherwise the Self profile owns 100% (implicit). If there is no Self
 *   profile, returns [] (nothing can be attributed).
 *
 * Nesting/parent chain is intentionally NOT consulted here.
 */
export function resolveOwners(
  links: OwnershipLink[] | undefined | null,
  selfProfileId: string | null | undefined,
): OwnerShare[] {
  const explicit = (links || []).filter(
    (l) => l && l.partyProfileId && isOwnerRole(l.role) && Number(l.ownershipPercentage) > 0,
  );

  if (explicit.length > 0) {
    // Merge duplicate parties (same person listed twice) by summing.
    const byParty = new Map<string, number>();
    for (const l of explicit) {
      byParty.set(l.partyProfileId, (byParty.get(l.partyProfileId) || 0) + Number(l.ownershipPercentage));
    }
    return [...byParty.entries()].map(([ownerId, pct]) => ({
      ownerId,
      pct: Math.min(pct, 100),
      implicit: false,
    }));
  }

  if (selfProfileId) return [{ ownerId: selfProfileId, pct: 100, implicit: true }];
  return [];
}

/**
 * The ownership percentage a given party holds in an asset/liability (0–100).
 * Returns 0 when the party is not an owner.
 */
export function shareForParty(
  partyId: string,
  links: OwnershipLink[] | undefined | null,
  selfProfileId: string | null | undefined,
): number {
  let pct = 0;
  for (const o of resolveOwners(links, selfProfileId)) {
    if (o.ownerId === partyId) pct += o.pct;
  }
  return Math.min(pct, 100);
}

/**
 * The percentage of an asset/liability that is in scope for a SET of selected
 * parties (e.g. the dashboard profile filter). Shares for distinct selected
 * owners are summed (Joe 50% + Me 50%, both selected ⇒ 100%), capped at 100%.
 * If the selection is empty (no filter / "everyone"), the whole value is in
 * scope (100%).
 */
export function shareForParties(
  partyIds: string[] | undefined | null,
  links: OwnershipLink[] | undefined | null,
  selfProfileId: string | null | undefined,
): number {
  if (!partyIds || partyIds.length === 0) return 100;
  const selected = new Set(partyIds);
  let pct = 0;
  for (const o of resolveOwners(links, selfProfileId)) {
    if (selected.has(o.ownerId)) pct += o.pct;
  }
  return Math.min(pct, 100);
}

export interface OwnershipValidation {
  total: number;
  /** No errors — safe to save. */
  valid: boolean;
  /** Has at least one explicit owner (vs. relying on the Self default). */
  configured: boolean;
  errors: string[];
}

/**
 * Validate an explicit ownership configuration. Used live by the editor (every
 * keystroke / slider drag) and by the server before persisting.
 *
 * Rules: each share 0–100, no duplicate parties, and — when any owner is
 * present — the total must equal exactly 100% (± epsilon). Zero owners is
 * valid (means "unconfigured → Self owns 100%").
 */
export function validateOwnership(links: OwnershipLink[] | undefined | null): OwnershipValidation {
  const active = (links || []).filter((l) => l && l.partyProfileId && isOwnerRole(l.role));
  const total = active.reduce((s, l) => s + (Number(l.ownershipPercentage) || 0), 0);
  const errors: string[] = [];

  for (const l of active) {
    const p = Number(l.ownershipPercentage);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      errors.push(`Each owner's share must be between 0 and 100% (got ${l.ownershipPercentage}).`);
      break;
    }
  }

  const seen = new Set<string>();
  for (const l of active) {
    if (seen.has(l.partyProfileId)) {
      errors.push("The same person is listed as an owner more than once.");
      break;
    }
    seen.add(l.partyProfileId);
  }

  const configured = active.length > 0;
  if (configured && Math.abs(total - 100) > OWNERSHIP_EPSILON) {
    errors.push(`Ownership must total exactly 100% (currently ${roundPct(total)}%).`);
  }

  return { total: roundPct(total), valid: errors.length === 0, configured, errors };
}

/**
 * Suggest evenly-split percentages for N owners (e.g. when the user clicks
 * "Split evenly" in the editor). NON-destructive — the caller decides whether
 * to apply it; nothing is ever auto-applied. The remainder from rounding is put
 * on the first owner so the total is exactly 100.
 */
export function distributeEvenly(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor((100 / count) * 100) / 100; // 2 d.p.
  const out = new Array(count).fill(base);
  const remainder = roundPct(100 - base * count);
  out[0] = roundPct(out[0] + remainder);
  return out;
}

/** Round to 2 decimal places to keep percentage math clean. */
export function roundPct(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIBILITY — ownership drives which assets/liabilities appear under a person.
//
// Rule (product decision 2026-06): if a party owns ANY percentage > 0 of an
// asset/liability, that item must surface under their profile and pass a filter
// selecting them — everywhere (Linked page, cards, dashboard, search, AI,
// reports). Visibility is NOT limited to the creator / primary owner / nesting
// parent. These helpers are the shared primitive every surface uses.
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized ownership record (asset_party_links OR liability_profile_links). */
export interface OwnershipRecord {
  /** The asset/liability profile id being owned. */
  itemId: string;
  /** The owning party profile id. */
  partyId: string;
  ownershipPercentage: number;
  role?: string;
}

/**
 * Build an index `itemId -> Set<ownerPartyId>` of every party that owns a
 * positive share (owner-role only) of each asset/liability. Use it to answer
 * "is this item owned by any selected person?" in O(1).
 */
export function buildOwnerIndex(records: OwnershipRecord[] | undefined | null): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const r of records || []) {
    if (!r || !r.itemId || !r.partyId) continue;
    if (!isOwnerRole(r.role)) continue;
    if (!(Number(r.ownershipPercentage) > 0)) continue;
    if (!index.has(r.itemId)) index.set(r.itemId, new Set());
    index.get(r.itemId)!.add(r.partyId);
  }
  return index;
}

/** The set of item ids owned (>0%) by ANY of the given parties. */
export function ownedItemIds(index: Map<string, Set<string>>, partyIds: string[] | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!partyIds || partyIds.length === 0) return out;
  const sel = new Set(partyIds);
  for (const [itemId, owners] of index) {
    for (const o of owners) {
      if (sel.has(o)) { out.add(itemId); break; }
    }
  }
  return out;
}

/**
 * Should an asset/liability item be VISIBLE for the active profile selection?
 * True when:
 *   • no filter is active (everyone), OR
 *   • the item itself is selected, OR
 *   • any selected party owns a positive share of it, OR
 *   • the item has NO explicit owners and a Self profile is selected (the
 *     Self-100% default — an unowned asset belongs to "me").
 */
export function itemVisibleForSelection(
  itemId: string,
  selectedIds: string[] | undefined | null,
  ownerIndex: Map<string, Set<string>>,
  selfIds: Set<string> | string[] | undefined | null,
): boolean {
  if (!selectedIds || selectedIds.length === 0) return true;
  const sel = new Set(selectedIds);
  if (sel.has(itemId)) return true;
  const owners = ownerIndex.get(itemId);
  if (owners && owners.size > 0) {
    for (const o of owners) if (sel.has(o)) return true;
    return false; // has explicit owners, none selected
  }
  // No explicit owners → belongs to Self.
  const selfSet = selfIds instanceof Set ? selfIds : new Set(selfIds || []);
  for (const s of sel) if (selfSet.has(s)) return true;
  return false;
}

/**
 * Scale a set of surviving shares so they total exactly 100, pro rata.
 *
 * Used when an owner leaves an asset or loan — by deletion of the person
 * (D139) or by removing their link (D224): the share they held returns to the
 * remaining owners in proportion, never to nobody. Empty, all-zero, or
 * already-complete inputs come back unchanged (`null` means nothing to do).
 */
export function scaleSharesTo100<T extends { ownershipPercentage: number }>(shares: readonly T[]): T[] | null {
  const live = shares.filter((o) => Number(o.ownershipPercentage) > 0);
  if (live.length === 0) return null;
  const total = live.reduce((n, o) => n + Number(o.ownershipPercentage), 0);
  if (total <= 0 || total >= 99.995) return null;
  const scaled = live.map((o) => ({ ...o, ownershipPercentage: Math.round((Number(o.ownershipPercentage) / total) * 10000) / 100 }));
  const drift = Math.round((100 - scaled.reduce((n, o) => n + o.ownershipPercentage, 0)) * 100) / 100;
  if (drift !== 0) {
    const biggest = scaled.reduce((a, b) => (b.ownershipPercentage > a.ownershipPercentage ? b : a));
    biggest.ownershipPercentage = Math.round((biggest.ownershipPercentage + drift) * 100) / 100;
  }
  return scaled;
}
