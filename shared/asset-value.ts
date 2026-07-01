// shared/asset-value.ts — Canonical asset and liability value resolvers.
//
// CRITICAL: This is the single source of truth for resolving the monetary
// value of a profile's `fields` object. Every site that needs an asset's
// value or a liability's balance MUST import from here. Inline reducers
// like `c.fields?.currentValue || c.fields?.value || ...` are bugs.
//
// History: this logic was previously duplicated in:
//   - server/supabase-storage.ts (resolveAssetValue, resolveLiabilityValue)
//   - client/src/pages/dashboard.tsx (resolveAssetValue, resolveLiabilityBalance)
//   - client/src/pages/finance.tsx (readVal)
//   - client/src/pages/profile-detail.tsx (inline IIFE with truncated keys)
// The divergences caused user-visible net-worth drift.
//
// This module is pure (no I/O, no React, no DB) so it works in both
// browser and Node contexts without bundler dance.

// liability-types is pure + dependency-free (no import back into this module),
// so there is no cycle. Used by isNetWorthLiabilityProfile below to exclude
// recurring service bills from balance-sheet debt.
import { isRecurringBill } from "./liability-types";

// ---------- parseMoney ----------
// Mirrors client/src/lib/utils.ts parseMoney and the inline server copy.
// Handles strings like "$25,000", "40k", "1.2m", numbers, null/undefined.
export function parseMoney(input: any): number {
  if (input == null) return 0;
  if (typeof input === "number") return Number.isFinite(input) ? input : 0;
  const s = String(input).trim();
  if (!s) return 0;
  const cleaned = s.replace(/[^0-9.\-kKmMbB]/g, "").trim();
  if (!cleaned) return 0;
  const m = cleaned.match(/^(-?\d*\.?\d+)([kKmMbB])?$/);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return 0;
  const suffix = (m[2] || "").toLowerCase();
  const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return base * mult;
}

// ---------- Asset value resolver ----------
// Walks every known nested + snake_case storage path that historical writers
// used (form save, AI extraction, find-value, legacy migrations) and returns
// the first positive number. The list MUST stay in sync across all callers.
//
// Accepts EITHER a Profile (object with .fields) or a bare fields object.
// This dual signature replaces the server `resolveAssetValue(fields)` and the
// client `resolveAssetValue(profile)` patterns without breaking either.
export function resolveAssetValue(input: any): number {
  if (!input) return 0;
  // Dual signature: profile (has .fields) or bare fields object.
  const fields = (input && typeof input === "object" && "fields" in input && input.fields)
    ? input.fields
    : input;
  if (!fields || typeof fields !== "object") return 0;

  const housing = fields.housing || {};
  const other = fields.other || {};
  const finance = fields.finance || {};
  const vehicle = fields.vehicle || {};
  const vehicles = fields.vehicles || {};
  const investment = fields.investment || {};

  const candidates: any[] = [
    fields.currentValue, fields.current_value, housing.currentValue, housing.current_value, other.currentValue, other.current_value,
    fields.marketValue, fields.market_value, housing.marketValue, housing.market_value, other.marketValue, other.market_value,
    fields.estimatedValue, fields.estimated_value,
    fields.value, other.value,
    fields.purchasePrice, fields.purchase_price, other.purchasePrice, other.purchase_price, housing.purchasePrice, housing.purchase_price,
    fields.cost, other.cost,
    fields.amount, other.amount,
    fields.price, other.price,
    fields.balance, finance.balance, finance.currentValue, finance.current_value, finance.value, finance.marketValue, finance.market_value,
    fields.accountBalance, finance.accountBalance, finance.account_balance,
    vehicle.purchasePrice, vehicle.purchase_price, vehicle.currentValue, vehicle.current_value, vehicle.value,
    vehicles.purchasePrice, vehicles.purchase_price, vehicles.currentValue, vehicles.current_value, vehicles.value,
    investment.balance, investment.value, investment.currentValue, investment.current_value,
  ];
  for (const c of candidates) {
    const n = parseMoney(c);
    if (n > 0) return n;
  }
  return 0;
}

// ---------- Liability balance resolver ----------
// Returns any outstanding loan/debt balance. Includes nested finance.loans[]
// entries that AI extraction creates. Dual signature like resolveAssetValue.
export function resolveLiabilityBalance(input: any): number {
  if (!input) return 0;
  const fields = (input && typeof input === "object" && "fields" in input && input.fields)
    ? input.fields
    : input;
  if (!fields || typeof fields !== "object") return 0;

  const finance = fields.finance || {};
  const loan = fields.loan || {};
  const other = fields.other || {};

  const candidates: any[] = [
    // Phase 2 canonical liability field (writes from LiabilityProfilePage)
    fields.currentBalance, fields.current_balance,
    finance.currentBalance, finance.current_balance,
    loan.currentBalance, loan.current_balance,
    // Registry snake_case shape (CreateProfileDialog with auto_loan/mortgage/etc.)
    fields.balance,
    fields.remainingBalance, fields.remaining_balance,
    fields.loanBalance, fields.loan_balance,
    fields.outstandingBalance, fields.outstanding_balance,
    finance.remainingBalance, finance.remaining_balance,
    finance.loanBalance, finance.loan_balance,
    finance.outstandingBalance, finance.outstanding_balance, finance.balance,
    loan.remainingBalance, loan.remaining_balance,
    loan.balance, loan.outstandingBalance, loan.outstanding_balance,
    other.remainingBalance, other.remaining_balance, other.balance,
  ];
  for (const c of candidates) {
    const n = parseMoney(c);
    if (n > 0) return n;
  }
  // Sum nested loans[] balances if present
  const loans = Array.isArray(finance.loans) ? finance.loans : Array.isArray(fields.loans) ? fields.loans : [];
  if (loans.length > 0) {
    const sum = loans.reduce(
      (s: number, l: any) => s + parseMoney(l?.balance || l?.remainingBalance || l?.remaining_balance),
      0,
    );
    if (sum > 0) return sum;
  }
  return 0;
}

// ---------- Liability resolver alias (server compatibility) ----------
// The server module historically exported `resolveLiabilityValue`. Keep an
// alias so existing imports continue to work.
export const resolveLiabilityValue = resolveLiabilityBalance;

// ---------- Asset / liability type sets ----------
// Profile.type values that count as assets for net-worth math.
export const ASSET_PROFILE_TYPES = new Set([
  "vehicle",
  "asset",
  "investment",
  "property",
  "loan",
  "account",
]);

// Profile.type values that count as liabilities. Note: "loan", "vehicle",
// "property", "asset", "account", "investment" can hold a liability balance
// (e.g. a mortgaged house) so they appear in both sets.
export const LIABILITY_PROFILE_TYPES = new Set([
  "liability",
  "loan",
  "vehicle",
  "property",
  "asset",
  "account",
  "investment",
]);

export function isAssetProfile(p: any): boolean {
  return !!p && ASSET_PROFILE_TYPES.has(String(p.type));
}

export function isLiabilityProfile(p: any): boolean {
  return !!p && LIABILITY_PROFILE_TYPES.has(String(p.type));
}

// ---------- Net-worth liability filter ----------
// A recurring service bill (utility, phone plan, streaming, etc.) is tracked as a
// liability profile but is NOT balance-sheet debt — it has no permanent balance,
// only a monthly amount. Those must be excluded from the Net Worth debt total
// (user decision: "only real debt counts"). We check the fine-grained `type_key`
// via the behavioral family so a `type: "liability", type_key: "utility"` profile
// is shown in Bills/Cash Flow but never subtracted from net worth.
//
/**
 * True when a liability profile's balance should count toward the Net Worth
 * debt total. Excludes recurring service bills. Anything the coarse-type check
 * already rejects is rejected here too.
 */
export function isNetWorthLiabilityProfile(p: any): boolean {
  if (!isLiabilityProfile(p)) return false;
  if (isRecurringBill(p?.type_key ?? p?.typeKey)) return false;
  return true;
}
