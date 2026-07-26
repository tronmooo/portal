import {
  dedupeDisplayFields, fieldBelongsOnProfileType, PROFILE_FIELD_GROUPS,
} from "@shared/profile-field-identity";

/** Remove fields that belong to a different kind of record entirely. */
function dropMisfiledFields(fields: any, profileType: any): any {
  if (!fields || typeof fields !== "object") return fields;
  const out: any = {};
  for (const [k, v] of Object.entries(fields)) {
    // Never touch the preserved nested group objects or reserved metadata.
    if (k.startsWith("_") || (PROFILE_FIELD_GROUPS as readonly string[]).includes(k)) {
      out[k] = v;
      continue;
    }
    if (fieldBelongsOnProfileType(k, profileType)) out[k] = v;
  }
  return out;
}

// ── Field flattening (nested → top-level) ───────────────────────────────────
// Storage paths used by the app:
//   fields.vehicles.{licensePlate,vin,make,model,year,mileage,color,trim,registrationExpiration}
//   fields.insurance.{insurer,policyNumber,coverage,coverageType,monthlyPremium,deductible}
//   fields.housing.{currentValue,address,beds,baths,sqft}
//   fields.other.{purchasePrice,valuationDate,valuationMethod,valuationRange,valuationConfidence}
//   fields.finance.{balance,monthlyPayment,interestRate,loans:[{balance}]}
//   fields.subscriptions.{cost,frequency,monthlyCost,renewalDate,status}
// Older / manual edits write the same keys at the top level. We promote nested
// keys to the top level so every reader (`f.licensePlate`, `f.currentValue`,
// etc.) works, with top-level winning if both exist. Numeric strings like "699"
// are left as-is — Number(...) at the call site coerces them.
//
// Shared by profile-detail and liability-detail: both pages write the SAME
// react-query cache key ["/api/profiles", id, "detail"], so every queryFn that
// populates it must produce the same flattened shape.
export function flattenProfileFields(rawFields: any): any {
  if (!rawFields || typeof rawFields !== "object") return rawFields || {};
  const NESTED_GROUPS = [
    // financial / asset groups
    "vehicles", "insurance", "housing", "other", "finance", "subscriptions", "utilities",
    // person / self groups
    "personal", "identity", "health", "contact", "emergency",
    // pet groups
    "pets", "pet",
  ];
  // Aliases so UI keys match storage keys.
  // Storage key (left) → UI key (right). When we promote a nested key, also
  // mirror it under the UI alias if the alias slot is empty.
  const KEY_ALIASES: Record<string, string> = {
    dateOfBirth: "birthday",
    dob: "birthday",
    licenseNumber: "license",
    licenseClass: "licenseClass",
    issuingAuthority: "licenseState",
    expirationDate: "licenseExpiration",
    patientName: "name",
    primaryPhone: "phone",
    homePhone: "phone",
    cellPhone: "phone",
    homeAddress: "address",
    serviceAddress: "address",
  };
  const out: any = {};
  // Case-insensitive presence tracking so "Weight" and "weight" don't both end
  // up as separate rows. First write wins; matches storage's schema (lowercase).
  const seenLC: Record<string, string> = {}; // lowercased key -> canonical key already in out
  const setIfEmpty = (key: string, val: any) => {
    if (val === undefined || val === null || val === "") return;
    const lc = key.toLowerCase();
    const existingKey = seenLC[lc];
    if (existingKey !== undefined) {
      const cur = out[existingKey];
      if (cur === undefined || cur === null || cur === "") out[existingKey] = val;
      return;
    }
    out[key] = val;
    seenLC[lc] = key;
  };
  // First, copy nested-group keys up
  for (const group of NESTED_GROUPS) {
    const nested = rawFields[group];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested)) {
        if (v === undefined || v === null || v === "") continue;
        setIfEmpty(k, v);
        const alias = KEY_ALIASES[k];
        if (alias && alias !== k) setIfEmpty(alias, v);
      }
    }
  }
  // Then, top-level keys win
  for (const [k, v] of Object.entries(rawFields)) {
    if (NESTED_GROUPS.includes(k)) {
      // Preserve the original nested object too so existing code that reads
      // fields.vehicles.* / fields.personal.* etc. keeps working
      out[k] = v;
      continue;
    }
    if (v === undefined || v === null || v === "") continue;
    const lc = k.toLowerCase();
    const existingKey = seenLC[lc];
    if (existingKey !== undefined && existingKey !== k) {
      // Top-level wins over a nested-promoted duplicate — replace under the
      // top-level key and drop the previously-promoted alias row.
      delete out[existingKey];
      out[k] = v;
      seenLC[lc] = k;
    } else {
      out[k] = v;
      seenLC[lc] = k;
    }
  }
  // IDENTITY DE-DUPLICATION (2026-07-25). `seenLC` above only collapses keys
  // that differ by CASE, so `licenseNumber` and `license_number` both survived
  // and the Info tab rendered the same value twice —
  //   LICENSE NUMBER: S226-116-24-800-0  /  LICENSE: S226-116-24-800-0
  //   DONOR INDICATOR: DONOR             /  DONOR: true
  // `dedupeDisplayFields` compares canonical field IDENTITY (the same function
  // the delete path uses, so display and deletion can never disagree again) and
  // hides a twin only when the values actually agree.
  const deduped = dedupeDisplayFields(out);
  for (const k of deduped.hidden) delete out[k];

  // Liability fallback: if no top-level balance but finance.loans[] has one, sum them
  const finance = rawFields.finance;
  if (finance && Array.isArray(finance.loans) && finance.loans.length > 0) {
    const loanSum = finance.loans.reduce(
      (s: number, l: any) => s + (Number(l?.balance) || 0),
      0,
    );
    if (loanSum > 0 && (out.balance == null || out.balance === "")) {
      out.balance = loanSum;
    }
  }
  return out;
}

// Apply flattening to a profile and (recursively) its child profiles.
export function flattenProfile<T extends { fields?: any; childProfiles?: any[]; type?: any } | null | undefined>(p: T): T {
  if (!p) return p;
  const flat: any = {
    ...p,
    // Drop fields that cannot belong to this profile type. Document extraction
    // had put MAKE / YEAR / LICENSEPLATE and a VENDOR PHONE onto a PERSON —
    // vehicle and receipt data on a human being. Those live on the vehicle
    // profile; showing them here is what made the tab read as nonsense.
    fields: dropMisfiledFields(flattenProfileFields((p as any).fields), (p as any).type),
  };
  if (Array.isArray((p as any).childProfiles)) {
    flat.childProfiles = (p as any).childProfiles.map((c: any) =>
      c ? { ...c, fields: dropMisfiledFields(flattenProfileFields(c.fields), c.type) } : c,
    );
  }
  return flat as T;
}
