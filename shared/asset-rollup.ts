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

/** Coerce a stringy/numeric value to a positive number, or 0. */
function toNum(c: any): number {
  if (c == null || c === "") return 0;
  const n = typeof c === "number" ? c : parseFloat(String(c).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Walk a list of dotted-path strings against an object and return the first positive match. */
function firstPositive(root: Record<string, any>, paths: string[]): number {
  for (const path of paths) {
    let cur: any = root;
    let ok = true;
    for (const part of path.split(".")) {
      if (cur == null || typeof cur !== "object") { ok = false; break; }
      cur = cur[part];
    }
    if (!ok) continue;
    const n = toNum(cur);
    if (n > 0) return n;
  }
  return 0;
}

/** Extract the base asset value from a single profile's fields.
 *  Reads camelCase, snake_case, and nested namespaces because legacy AI
 *  extractions and manual entries store values under many different paths.
 */
function extractBaseValue(fields: Record<string, any>): number {
  if (!fields || typeof fields !== "object") return 0;
  const namespaces = ["", "finance", "other", "housing", "vehicle", "vehicles", "investment", "investments", "asset", "assets", "property", "properties", "account", "accounts"];
  const keys = ["currentValue", "current_value", "value", "purchasePrice", "purchase_price", "balance", "amount", "cost", "price"];
  const paths: string[] = [];
  for (const ns of namespaces) {
    for (const k of keys) paths.push(ns ? `${ns}.${k}` : k);
  }
  return firstPositive(fields, paths);
}

/** Extract the base loan balance from a single profile's fields. */
function extractBaseLoans(fields: Record<string, any>): number {
  if (!fields || typeof fields !== "object") return 0;
  const namespaces = ["", "finance", "loan", "loans"];
  const keys = ["remainingBalance", "remaining_balance", "loanBalance", "loan_balance", "balance"];
  const paths: string[] = [];
  for (const ns of namespaces) {
    for (const k of keys) paths.push(ns ? `${ns}.${k}` : k);
  }
  return firstPositive(fields, paths);
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
