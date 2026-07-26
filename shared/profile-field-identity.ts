// shared/profile-field-identity.ts — ONE answer to "are these the same field?"
//
// User report 2026-07-25 (Info tab screenshot):
//   "It's not allowing me to delete anything here and what's all this data
//    doing here none of it makes sense… There's a bunch of duplicates."
//
// The tab showed the same value twice under different labels —
//   LICENSE NUMBER: S226-116-24-800-0   /  LICENSE: S226-116-24-800-0
//   DONOR INDICATOR: DONOR              /  DONOR: true
//   STATUS: SAFE DRIVER                 /  SAFE DRIVER: SAFE DRIVER
//   RESTRICTIONS (twice), ENDORSEMENTS (twice)
// — and deleting one did nothing, because the twin re-promoted on the next read.
//
// WHY THIS KEPT COMING BACK. Three layers each matched field keys by EXACT
// STRING, each with its own alias table:
//
//   client/src/lib/flattenProfile.ts   KEY_ALIASES + NESTED_GROUPS   (display)
//   server/supabase-storage.ts         PROFILE_KEY_ALIAS_REVERSE     (delete)
//   shared/profile-field-canon.ts      CANONICAL_ALIASES             (write)
//
// A key spelled `license_number` matched none of them, so it survived every
// delete and rendered as a second card. Fixing one table never fixed the
// others, and each new document type added fresh spellings. This module is the
// single identity function all three now call: normalize case and separators,
// fold known aliases, and compare on THAT — never on the raw string.
//
// Pure, dependency-free. Pinned by tests/profile-field-identity.test.ts.

/**
 * Nested objects inside `profile.fields` whose keys are promoted to the top
 * level for display. A field can live at the top level, inside any of these,
 * or in several at once — which is why deletion has to sweep all of them.
 */
export const PROFILE_FIELD_GROUPS = [
  // financial / asset groups
  "vehicles", "vehicle", "insurance", "housing", "other", "finance",
  "subscriptions", "utilities", "loan",
  // person / self groups
  "personal", "identity", "health", "contact", "contacts", "emergency",
  // pet groups
  "pets", "pet",
] as const;

/**
 * canonical identity → every spelling that means the same field.
 *
 * Entries are compared after `normalizeKey`, so only genuinely different WORDS
 * need listing — case, spaces, underscores and hyphens are already handled.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  // ── identity documents (the fields in the report) ────────────────────────
  license: ["licensenumber", "licenseno", "dlnumber", "driverslicensenumber", "driverlicensenumber", "idnumber"],
  licenseClass: ["class", "licenceclass"],
  licenseType: ["documenttype", "credentialtype"],
  licenseState: ["issuingauthority", "issuingstate", "state", "jurisdiction"],
  licenseExpiration: ["expirationdate", "expires", "expiry", "expirydate", "validuntil"],
  licenseIssued: ["issuedate", "issued", "dateissued"],
  endorsements: ["endorsement"],
  restrictions: ["restriction", "restrictioncodes"],
  organDonor: ["donor", "donorindicator", "organdonorindicator"],
  safeDriver: ["safedriverindicator"],
  birthday: ["dateofbirth", "dob", "birthdate"],
  name: ["patientname", "customername", "fullname", "holdername"],
  // ── contact ──────────────────────────────────────────────────────────────
  phone: ["primaryphone", "homephone", "cellphone", "mobilephone", "telephone"],
  address: ["homeaddress", "serviceaddress", "mailingaddress", "streetaddress"],
  // ── vehicle ──────────────────────────────────────────────────────────────
  licensePlate: ["plate", "platenumber", "licenceplate", "tag", "tagnumber"],
  vin: ["vinnumber", "vehicleidentificationnumber"],
  // ── money (kept in step with shared/profile-field-canon) ─────────────────
  currentValue: ["value", "worth", "marketvalue", "estimatedvalue", "currentworth", "assetvalue", "presentvalue"],
  purchasePrice: ["pricepaid", "boughtfor", "purchaseamount", "originalprice", "purchasecost"],
  balance: ["amountowed", "remainingbalance", "loanbalance", "balanceowed", "outstandingbalance", "currentbalance", "balanceremaining"],
  interestRate: ["apr"],
  monthlyPayment: ["paymentamount", "monthlycost", "monthlyamount"],
  purchaseDate: ["datepurchased", "boughton", "acquisitiondate", "dateacquired"],
  accountNumber: ["accountno", "acctnumber", "acctno"],
};

/** Lowercase and strip every separator, so all spellings of one word collide. */
export function normalizeKey(key: unknown): string {
  return String(key ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const IDENTITY_LOOKUP: Record<string, string> = {};
for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
  IDENTITY_LOOKUP[normalizeKey(canonical)] = canonical;
  for (const a of aliases) IDENTITY_LOOKUP[normalizeKey(a)] = canonical;
}

/**
 * The canonical identity of a field key.
 *
 * `licenseNumber`, `license_number`, `LICENSE NUMBER` and `licenseNo` all
 * return `"license"`. An unknown key returns its own normalized form, which
 * still collapses pure formatting differences.
 */
export function fieldIdentity(key: unknown): string {
  const norm = normalizeKey(key);
  return IDENTITY_LOOKUP[norm] || norm;
}

/** Do two field keys refer to the same underlying field? */
export function sameField(a: unknown, b: unknown): boolean {
  const ia = fieldIdentity(a);
  const ib = fieldIdentity(b);
  return !!ia && ia === ib;
}

// ─── Deletion ────────────────────────────────────────────────────────────────

export interface FieldDeletionResult {
  fields: Record<string, any>;
  /** Full storage paths removed, e.g. "licenseNumber", "identity.license". */
  removed: string[];
}

/**
 * Remove EVERY storage key matching the given UI keys — at the top level and
 * inside every nested group — comparing on identity rather than exact string.
 *
 * This is what makes a delete stick. Deleting "License" previously removed the
 * top-level `license` key only, leaving `identity.licenseNumber` to be promoted
 * straight back on the next read, so the field appeared undeletable.
 *
 * Pure: returns new objects, never mutates the input. Empty nested groups are
 * dropped so the UI doesn't render a hollow section.
 */
export function deleteProfileFields(
  fields: Record<string, any> | null | undefined,
  uiKeys: readonly string[] | null | undefined,
): FieldDeletionResult {
  const removed: string[] = [];
  if (!fields || typeof fields !== "object") return { fields: {}, removed };
  const targets = new Set(
    (uiKeys || []).filter((k) => typeof k === "string" && k).map(fieldIdentity),
  );
  if (targets.size === 0) return { fields: { ...fields }, removed };

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    // Reserved metadata (_ownershipPercentage etc.) is never a user field.
    if (key.startsWith("_")) { out[key] = value; continue; }

    const isGroup =
      (PROFILE_FIELD_GROUPS as readonly string[]).includes(key) &&
      value && typeof value === "object" && !Array.isArray(value);

    if (isGroup) {
      const kept: Record<string, any> = {};
      for (const [nk, nv] of Object.entries(value as Record<string, any>)) {
        if (targets.has(fieldIdentity(nk))) removed.push(`${key}.${nk}`);
        else kept[nk] = nv;
      }
      // Drop a group that has been emptied out.
      if (Object.keys(kept).length > 0) out[key] = kept;
      else if (Object.keys(value as object).length === 0) out[key] = value;
      continue;
    }

    if (targets.has(fieldIdentity(key))) removed.push(key);
    else out[key] = value;
  }
  return { fields: out, removed };
}

// ─── Display de-duplication ──────────────────────────────────────────────────

export interface DedupedFieldsResult {
  fields: Record<string, any>;
  /** Keys hidden because another key already showed the same field. */
  hidden: string[];
}

/**
 * Collapse a FLATTENED fields object so one logical field renders once.
 *
 * Prefers the entry with a real value, then the canonical spelling, then the
 * shorter key — so "LICENSE" wins over "LICENSE NUMBER" and the user sees one
 * card instead of two identical ones.
 *
 * Only collapses when the values agree (loosely — "DONOR" vs "true" for a
 * boolean-ish field). Genuinely different values keep both keys, because
 * hiding a differing value would be losing information.
 */
export function dedupeDisplayFields(
  fields: Record<string, any> | null | undefined,
): DedupedFieldsResult {
  const hidden: string[] = [];
  if (!fields || typeof fields !== "object") return { fields: {}, hidden };

  const byIdentity = new Map<string, string[]>();
  for (const key of Object.keys(fields)) {
    if (key.startsWith("_")) continue;
    const id = fieldIdentity(key);
    const list = byIdentity.get(id);
    if (list) list.push(key);
    else byIdentity.set(id, [key]);
  }

  const out: Record<string, any> = {};
  for (const key of Object.keys(fields)) {
    if (key.startsWith("_")) { out[key] = fields[key]; continue; }
    out[key] = fields[key];
  }

  for (const [identity, keys] of byIdentity) {
    if (keys.length < 2) continue;
    const winner = pickPreferredKey(keys, identity, fields);
    for (const k of keys) {
      if (k === winner) continue;
      if (equivalentValue(fields[k], fields[winner])) {
        delete out[k];
        hidden.push(k);
      }
    }
  }
  return { fields: out, hidden };
}

function pickPreferredKey(
  keys: string[],
  identity: string,
  fields: Record<string, any>,
): string {
  const hasValue = (k: string) => {
    const v = fields[k];
    return v !== undefined && v !== null && String(v).trim() !== "";
  };
  const scored = keys.map((k) => ({
    k,
    score:
      (hasValue(k) ? 100 : 0) +
      (normalizeKey(k) === normalizeKey(identity) ? 10 : 0) +
      Math.max(0, 20 - k.length),
  }));
  scored.sort((a, b) => b.score - a.score || a.k.localeCompare(b.k));
  return scored[0].k;
}

/** Do two displayed values say the same thing? */
function equivalentValue(a: unknown, b: unknown): boolean {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (sa === "" || sb === "") return true; // an empty twin is always redundant
  if (sa.toLowerCase() === sb.toLowerCase()) return true;
  // Boolean-ish agreement: "DONOR" / "true" / "yes" all mean the same flag.
  const truthy = (s: string) => /^(true|yes|y|1|donor)$/i.test(s);
  if (truthy(sa) && truthy(sb)) return true;
  // Numeric agreement ignoring currency formatting.
  const na = Number(sa.replace(/[$,\s]/g, ""));
  const nb = Number(sb.replace(/[$,\s]/g, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && /\d/.test(sa) && /\d/.test(sb)) {
    return na === nb;
  }
  return false;
}

// ─── Field relevance ─────────────────────────────────────────────────────────

/**
 * Field identities that only make sense on particular profile types.
 *
 * The report showed a person's Info tab carrying MAKE / YEAR / LICENSEPLATE
 * and a VENDOR PHONE — vehicle and receipt data landed on a human being by
 * document extraction. Those belong on the vehicle profile.
 */
const TYPE_ONLY_FIELDS: Record<string, ReadonlySet<string>> = {
  vehicle: new Set(["make", "model", "year", "trim", "mileage", "vin", "licensePlate", "odometer"]),
};

const PERSON_TYPES = new Set(["person", "self", "pet"]);

/**
 * Should this field appear on a profile of this type?
 *
 * Returns false for vehicle-only fields on a person. Everything unknown is
 * allowed — this filters obvious mis-filings, it does not police the schema.
 */
export function fieldBelongsOnProfileType(key: unknown, profileType: unknown): boolean {
  const type = String(profileType ?? "").toLowerCase();
  if (!PERSON_TYPES.has(type)) return true;
  const id = fieldIdentity(key);
  for (const [owner, keys] of Object.entries(TYPE_ONLY_FIELDS)) {
    if (owner === type) continue;
    if (keys.has(id)) return false;
  }
  return true;
}
