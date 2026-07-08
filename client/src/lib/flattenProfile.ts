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
export function flattenProfile<T extends { fields?: any; childProfiles?: any[] } | null | undefined>(p: T): T {
  if (!p) return p;
  const flat: any = { ...p, fields: flattenProfileFields((p as any).fields) };
  if (Array.isArray((p as any).childProfiles)) {
    flat.childProfiles = (p as any).childProfiles.map((c: any) =>
      c ? { ...c, fields: flattenProfileFields(c.fields) } : c,
    );
  }
  return flat as T;
}
