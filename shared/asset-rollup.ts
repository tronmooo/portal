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
  /** Total monthly recurring expense across this node + all descendants —
   *  reads `monthlyCost`, `monthlyExpense`, `monthlyPayment`, etc. Normalised
   *  to monthly (yearly values divided by 12). Useful for "Home costs $X/mo
   *  total" rollups. */
  monthlyExpense: number;
  /** Total maintenance cost recorded across this node + all descendants —
   *  reads `maintenanceCost`, `maintenance_cost`, `serviceCost`. */
  maintenanceCost: number;
  /** Per-item breakdown — one row for self + every descendant. Used by the
   *  Financials tab to render "Mouse $80 / Keyboard $150 / Monitor $400". */
  breakdown: AssetRollupRow[];
}

export interface AssetRollupRow {
  id: string;
  name: string;
  type: string;
  depth: number;        // 0 = self, 1 = direct child, 2 = grandchild, ...
  baseValue: number;
  baseLoans: number;
  netValue: number;     // baseValue - baseLoans for this row alone
  isSelf: boolean;
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

/** Extract the recurring monthly expense from a single profile's fields,
 *  normalising yearly values to monthly. Returns 0 if no such cost exists. */
function extractMonthlyExpense(fields: Record<string, any>): number {
  if (!fields || typeof fields !== "object") return 0;
  const namespaces = ["", "finance", "subscription", "expense", "expenses", "maintenance"];
  const keys = ["monthlyCost", "monthly_cost", "monthlyExpense", "monthly_expense", "monthlyPayment", "monthly_payment"];
  const paths: string[] = [];
  for (const ns of namespaces) {
    for (const k of keys) paths.push(ns ? `${ns}.${k}` : k);
  }
  const monthly = firstPositive(fields, paths);
  if (monthly > 0) return monthly;
  // Also support generic `cost` + `frequency`: cost=120 frequency="yearly" => 10/mo.
  const cost = toNum((fields as any).cost ?? (fields as any).amount ?? (fields as any).price);
  const freq = String((fields as any).frequency || "").toLowerCase();
  if (cost > 0 && freq) {
    if (freq.startsWith("month")) return cost;
    if (freq.startsWith("year") || freq.startsWith("annual")) return cost / 12;
    if (freq.startsWith("week")) return cost * 4.345;
    if (freq.startsWith("day")) return cost * 30.44;
    if (freq.startsWith("quarter")) return cost / 3;
  }
  return 0;
}

/** Extract the maintenance cost from a single profile's fields. */
function extractMaintenanceCost(fields: Record<string, any>): number {
  if (!fields || typeof fields !== "object") return 0;
  const namespaces = ["", "maintenance", "service", "upkeep"];
  const keys = ["maintenanceCost", "maintenance_cost", "serviceCost", "service_cost", "upkeepCost", "upkeep_cost", "totalMaintenance"];
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

  const monthlyExpense = extractMonthlyExpense(profile.fields) + descendants.reduce(
    (sum, d) => sum + extractMonthlyExpense(d.fields),
    0,
  );

  const maintenanceCost = extractMaintenanceCost(profile.fields) + descendants.reduce(
    (sum, d) => sum + extractMaintenanceCost(d.fields),
    0,
  );

  const totalValue = baseValue + nestedValue;
  const totalLoans = baseLoans + nestedLoans;
  const netValue = totalValue - totalLoans;

  // Per-row breakdown — self first, then descendants ordered by depth then name.
  // Depth is computed by walking parent links within the descendants set.
  const depthMap = new Map<string, number>();
  depthMap.set(profile.id, 0);
  // Iterate up to descendantCount+1 times to handle arbitrary order.
  for (let i = 0; i <= descendantCount; i++) {
    let progressed = false;
    for (const d of descendants) {
      if (depthMap.has(d.id)) continue;
      const pid = (d as any).parentProfileId || (d.fields as any)?._parentProfileId;
      if (pid && depthMap.has(pid)) {
        depthMap.set(d.id, (depthMap.get(pid) as number) + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const selfRow: AssetRollupRow = {
    id: profile.id,
    name: (profile as any).name || "(self)",
    type: profile.type,
    depth: 0,
    baseValue,
    baseLoans,
    netValue: baseValue - baseLoans,
    isSelf: true,
  };
  const descRows: AssetRollupRow[] = descendants.map((d) => {
    const bv = extractBaseValue(d.fields);
    const bl = extractBaseLoans(d.fields);
    return {
      id: d.id,
      name: (d as any).name || "(unnamed)",
      type: d.type,
      depth: depthMap.get(d.id) ?? 1,
      baseValue: bv,
      baseLoans: bl,
      netValue: bv - bl,
      isSelf: false,
    };
  }).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  const breakdown: AssetRollupRow[] = [selfRow, ...descRows];

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
    monthlyExpense,
    maintenanceCost,
    breakdown,
  };
}
