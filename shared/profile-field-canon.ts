// ── Profile field canonicalization (2026-07-20) ───────────────────────────────
// Pure, no I/O. Kills the redundant-field sprawl on asset / liability /
// profile records (user report: "a lot of data fields that are redundant").
//
// The AI writes whatever key the model felt like that day — "value",
// "marketValue", "estimated_value", "currentvalue" — so one asset ends up
// carrying four spellings of the same number, and readers (shared/asset-value)
// have to probe every alias. This module maps alias keys to ONE canonical
// camelCase key at write time, merges case/format duplicates, and sweeps
// stale alias copies that shadow an existing canonical value.
//
// Safety rule: NEVER lose a differing value. An alias is only dropped when the
// canonical key holds a loosely-equal value (numbers compared numerically,
// "$26,000" == 26000) or the alias is empty. Differing values keep both keys.
//
// Pinned by tests/profile-field-canon.test.ts.

/** canonical key → alias spellings (compared via normalized lowercase). */
const CANONICAL_ALIASES: Record<string, string[]> = {
  currentValue: ["value", "worth", "marketvalue", "estimatedvalue", "currentworth", "assetvalue", "presentvalue"],
  purchasePrice: ["pricepaid", "boughtfor", "purchaseamount", "originalprice", "purchasecost"],
  balance: ["amountowed", "remainingbalance", "loanbalance", "balanceowed", "outstandingbalance", "currentbalance", "balanceremaining"],
  interestRate: ["apr"],
  monthlyPayment: ["paymentamount", "monthlycost", "monthlyamount"],
  purchaseDate: ["datepurchased", "boughton", "acquisitiondate", "dateacquired"],
  accountNumber: ["accountno", "acctnumber", "acctno"],
  licensePlate: ["plate", "platenumber", "licenceplate"],
  mileage: ["currentmileage", "odometer", "currentodometer", "odometerreading", "mileagereading", "miles"],
};

/** Lowercase + strip separators so camelCase / snake_case / spaced variants of
 * the same key collide: "current_value" ≡ "currentValue" ≡ "Current Value". */
export function normalizeFieldKey(key: string): string {
  return String(key || "").toLowerCase().replace(/[\s_-]+/g, "");
}

// normalized alias (and normalized canonical itself) → canonical camelCase key
const ALIAS_LOOKUP: Record<string, string> = {};
for (const [canonical, aliases] of Object.entries(CANONICAL_ALIASES)) {
  ALIAS_LOOKUP[normalizeFieldKey(canonical)] = canonical;
  for (const a of aliases) ALIAS_LOOKUP[normalizeFieldKey(a)] = canonical;
}

/** Resolve a raw field key to its canonical spelling (or itself if unknown). */
export function canonicalFieldKey(key: string): string {
  return ALIAS_LOOKUP[normalizeFieldKey(key)] || key;
}

const isEmpty = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

/** Loose equality: numeric strings/currency compare as numbers, else trimmed
 * case-insensitive string equality. */
export function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isEmpty(a) && isEmpty(b)) return true;
  const na = Number(String(a).replace(/[$,\s]/g, ""));
  const nb = Number(String(b).replace(/[$,\s]/g, ""));
  if (isFinite(na) && isFinite(nb) && String(a).match(/\d/) && String(b).match(/\d/)) return na === nb;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export interface CanonFieldsResult {
  fields: Record<string, any>;
  /** incoming key → canonical key it was folded into */
  renamed: Record<string, string>;
  /** keys dropped as redundant duplicates (value preserved under canonical) */
  dropped: string[];
}

/**
 * Canonicalize an incoming AI-written fields object.
 *
 * - Alias keys are renamed to their canonical camelCase form.
 * - When `existing` fields are provided, an incoming key that normalizes to an
 *   EXISTING key's spelling adopts the existing spelling (no case-variant dupes).
 * - Two incoming keys that collapse to one canonical: first non-empty wins; a
 *   conflicting different value keeps its original key (never lose data).
 */
export function canonicalizeProfileFields(
  incoming: Record<string, any> | undefined | null,
  existing?: Record<string, any> | null,
): CanonFieldsResult {
  const out: Record<string, any> = {};
  const renamed: Record<string, string> = {};
  const dropped: string[] = [];
  if (!incoming || typeof incoming !== "object") return { fields: out, renamed, dropped };

  // Existing-key spellings by normalized form, so updates target the key the
  // profile already uses instead of adding a differently-cased twin.
  const existingByNorm: Record<string, string> = {};
  for (const k of Object.keys(existing || {})) existingByNorm[normalizeFieldKey(k)] = k;

  for (const [rawKey, value] of Object.entries(incoming)) {
    if (rawKey.startsWith("_")) { out[rawKey] = value; continue; } // reserved metadata
    let target = canonicalFieldKey(rawKey);
    // Prefer the spelling already on the record for non-aliased keys
    // ("zip_code" incoming when profile has "zipCode" → write "zipCode").
    if (target === rawKey) {
      const existingSpelling = existingByNorm[normalizeFieldKey(rawKey)];
      if (existingSpelling) target = existingSpelling;
    }
    if (!(target in out)) {
      out[target] = value;
      if (target !== rawKey) renamed[rawKey] = target;
      continue;
    }
    // Collision within this same payload.
    if (isEmpty(value) || looselyEqual(out[target], value)) {
      dropped.push(rawKey);
    } else if (isEmpty(out[target])) {
      out[target] = value;
      dropped.push(rawKey);
    } else {
      // Conflicting values — keep the alias under its original key, untouched.
      out[rawKey] = value;
    }
  }
  return { fields: out, renamed, dropped };
}

/**
 * Sweep a MERGED fields object (existing + incoming) for stale alias copies:
 * when both the canonical key and an alias exist and their values are loosely
 * equal (or the alias is empty), the alias is deleted. Differing values are
 * left alone — the alias might be intentional.
 */
export function sweepRedundantAliases(fields: Record<string, any>): { fields: Record<string, any>; removed: string[] } {
  const removed: string[] = [];
  const out = { ...fields };
  const byNorm: Record<string, string[]> = {};
  for (const k of Object.keys(out)) {
    const canon = canonicalFieldKey(k);
    (byNorm[canon] ||= []).push(k);
  }
  for (const [canon, keys] of Object.entries(byNorm)) {
    if (keys.length < 2 && keys[0] === canon) continue;
    const canonicalPresent = keys.includes(canon) ? canon : null;
    if (!canonicalPresent) continue;
    for (const k of keys) {
      if (k === canon) continue;
      if (isEmpty(out[k]) || looselyEqual(out[k], out[canon])) {
        delete out[k];
        removed.push(k);
      }
    }
  }
  return { fields: out, removed };
}
