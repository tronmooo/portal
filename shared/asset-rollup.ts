import { type Profile } from "./schema";

// ============================================================
// ASSET ROLLUP — pure function, no I/O, usable from client + server
// ============================================================

export interface AssetRollup {
  baseValue: number;       // profile.fields.currentValue || value || purchasePrice || balance || 0
  nestedValue: number;     // sum of descendants' base values (recursive)
  totalValue: number;      // baseValue + nestedValue
  baseLoans: number;       // profile loans: remainingBalance || loanBalance
  nestedLoans: number;     // sum of descendants' loans
  totalLoans: number;
  netValue: number;        // totalValue - totalLoans
  childCount: number;      // direct children only
  descendantCount: number; // all descendants
}

/** Extract the base asset value from a single profile's fields. */
function extractBaseValue(fields: Record<string, any>): number {
  if (!fields || typeof fields !== "object") return 0;
  const candidates = [
    fields.currentValue,
    fields.value,
    fields.purchasePrice,
    fields.balance,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = typeof c === "number" ? c : parseFloat(String(c).replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Extract the base loan balance from a single profile's fields. */
function extractBaseLoans(fields: Record<string, any>): number {
  if (!fields || typeof fields !== "object") return 0;
  const candidates = [fields.remainingBalance, fields.loanBalance];
  for (const c of candidates) {
    if (c == null) continue;
    const n = typeof c === "number" ? c : parseFloat(String(c).replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Compute rollup metrics for a profile given its full descendant list.
 *
 * @param profile   The root profile to compute the rollup for.
 * @param descendants All descendant profiles (any depth). They must all truly
 *                    be descendants of `profile` — the caller is responsible for
 *                    providing the correct set (e.g. from the /tree endpoint).
 */
export function computeAssetRollup(
  profile: Profile,
  descendants: Profile[],
): AssetRollup {
  const baseValue = extractBaseValue(profile.fields);
  const baseLoans = extractBaseLoans(profile.fields);

  // Direct children — profiles whose parentProfileId === profile.id
  const childCount = descendants.filter(
    (d) => d.parentProfileId === profile.id,
  ).length;

  const descendantCount = descendants.length;

  const nestedValue = descendants.reduce(
    (sum, d) => sum + extractBaseValue(d.fields),
    0,
  );

  const nestedLoans = descendants.reduce(
    (sum, d) => sum + extractBaseLoans(d.fields),
    0,
  );

  const totalValue = baseValue + nestedValue;
  const totalLoans = baseLoans + nestedLoans;
  const netValue = totalValue - totalLoans;

  return {
    baseValue,
    nestedValue,
    totalValue,
    baseLoans,
    nestedLoans,
    totalLoans,
    netValue,
    childCount,
    descendantCount,
  };
}
