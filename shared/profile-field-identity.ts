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
  licensePlate: ["plate", "platenumber", "licenceplate", "tag", "tagnumber", "licenseplatenumber"],
  vin: ["vinnumber", "vehicleidentificationnumber", "vehiclevin"],
  mileage: ["currentmileage", "odometer", "currentodometer", "odometerreading", "mileagereading", "miles"],
  make: ["vehiclemake", "carmake"],
  model: ["vehiclemodel", "carmodel"],
  year: ["vehicleyear", "modelyear", "caryear"],
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
  /**
   * Paths to delete EXACTLY — no identity sweep, no other group.
   *
   * `uiKeys` is the profile UI's universal delete: "remove my licence number"
   * should take every spelling of it wherever it is stored. That is wrong for a
   * single date the calendar is removing, because two groups can legitimately
   * hold same-named dates — clearing a top-level `expirationDate` swept
   * `insurance.expirationDate` away with it. A top-level path is just the key.
   */
  exactPaths: readonly string[] | null | undefined = null,
): FieldDeletionResult {
  const removed: string[] = [];
  if (!fields || typeof fields !== "object") return { fields: {}, removed };
  // A DOTTED key targets exactly one field in one group. Everything else is an
  // identity sweep across the top level and every group, which is the app's
  // universal delete — right when the user says "remove my licence number"
  // however it is spelled, and wrong when they mean one of two same-named dates
  // in different groups: deleting `registration.expirationDate` from the
  // calendar would have taken `insurance.expirationDate` with it.
  const exact = new Set([
    ...(uiKeys || []).filter((k) => typeof k === "string" && k.includes(".")),
    ...(exactPaths || []).filter((k) => typeof k === "string" && k),
  ]);
  const targets = new Set(
    (uiKeys || [])
      .filter((k) => typeof k === "string" && k && !k.includes("."))
      .map(fieldIdentity),
  );
  if (targets.size === 0 && exact.size === 0) return { fields: { ...fields }, removed };

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    // Reserved metadata (_ownershipPercentage etc.) is never a user field.
    if (key.startsWith("_")) { out[key] = value; continue; }

    const isGroup =
      (PROFILE_FIELD_GROUPS as readonly string[]).includes(key) &&
      value && typeof value === "object" && !Array.isArray(value);

    if (!isGroup && exact.has(key)) { removed.push(key); continue; }

    // An exact path may point into ANY nested object, not just one of the
    // whitelisted groups — `registration.expirationDate` is a real shape the
    // scanner emits, and matching only the whitelist made "remove this date"
    // answer 200 and change nothing.
    if (!isGroup && value && typeof value === "object" && !Array.isArray(value)) {
      const inner = value as Record<string, any>;
      const hits = Object.keys(inner).filter((nk) => exact.has(`${key}.${nk}`));
      if (hits.length > 0) {
        const kept: Record<string, any> = {};
        for (const [nk, nv] of Object.entries(inner)) {
          if (hits.includes(nk)) removed.push(`${key}.${nk}`);
          else kept[nk] = nv;
        }
        if (Object.keys(kept).length > 0) out[key] = kept;
        continue;
      }
    }

    if (isGroup) {
      const kept: Record<string, any> = {};
      for (const [nk, nv] of Object.entries(value as Record<string, any>)) {
        if (targets.has(fieldIdentity(nk)) || exact.has(`${key}.${nk}`)) removed.push(`${key}.${nk}`);
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

// ─── Stored-field cleanup ────────────────────────────────────────────────────

export interface StoredFieldsCleanupResult {
  fields: Record<string, any>;
  /** Storage paths removed as redundant twins, e.g. "currentMileage", "vehicles.mileage". */
  removed: string[];
  changed: boolean;
}

/**
 * One-pass cleanup of a profile's STORED fields: collapse alias twins so each
 * logical field is stored exactly once.
 *
 * Years of extraction runs left profiles carrying `mileage` + `currentMileage`
 * + `vehicles.mileage`, `license` + `licenseNumber`, `value` + `currentValue`…
 * The display layer hides the twins, but the stored redundancy keeps leaking
 * (exports, AI context, any reader that doesn't flatten). This produces the
 * cleaned object storage should hold.
 *
 * Safety rule (same as everywhere in this module): a twin is only dropped when
 * its value AGREES with the survivor (loosely — "$26,000" == 26000) or is
 * empty. Differing values are never discarded.
 *
 * Pure: returns new objects, never mutates the input.
 */
export function cleanupStoredProfileFields(
  fields: Record<string, any> | null | undefined,
): StoredFieldsCleanupResult {
  if (!fields || typeof fields !== "object") return { fields: {}, removed: [], changed: false };
  const removed: string[] = [];
  const out: Record<string, any> = { ...fields };

  const isGroup = (k: string) =>
    (PROFILE_FIELD_GROUPS as readonly string[]).includes(k) &&
    out[k] && typeof out[k] === "object" && !Array.isArray(out[k]);

  // 1. Collapse top-level twins (same identity, agreeing values).
  const byIdentity = new Map<string, string[]>();
  for (const k of Object.keys(out)) {
    if (k.startsWith("_") || isGroup(k)) continue;
    const id = fieldIdentity(k);
    const list = byIdentity.get(id);
    if (list) list.push(k); else byIdentity.set(id, [k]);
  }
  for (const [identity, keys] of byIdentity) {
    if (keys.length < 2) continue;
    const winner = pickPreferredKey(keys, identity, out);
    for (const k of keys) {
      if (k === winner) continue;
      if (equivalentValue(out[k], out[winner])) {
        delete out[k];
        removed.push(k);
      }
    }
  }

  // 2. Sweep nested-group copies that duplicate a surviving top-level value.
  const topIdentity = new Map<string, string>();
  for (const k of Object.keys(out)) {
    if (k.startsWith("_") || isGroup(k)) continue;
    topIdentity.set(fieldIdentity(k), k);
  }
  for (const group of PROFILE_FIELD_GROUPS) {
    if (!isGroup(group)) continue;
    const nested = out[group] as Record<string, any>;
    let cleaned: Record<string, any> | null = null;
    for (const nk of Object.keys(nested)) {
      const topKey = topIdentity.get(fieldIdentity(nk));
      if (topKey === undefined) continue;
      // Never delete a nested VALUE in favor of an empty top-level twin —
      // equivalentValue treats empties as agreeing, which would lose data here.
      const topVal = out[topKey];
      if (topVal === undefined || topVal === null || String(topVal).trim() === "") continue;
      if (equivalentValue(nested[nk], out[topKey])) {
        if (!cleaned) cleaned = { ...nested };
        delete cleaned[nk];
        removed.push(`${group}.${nk}`);
      }
    }
    if (cleaned) {
      if (Object.keys(cleaned).length > 0) out[group] = cleaned;
      else { delete out[group]; }
    }
  }

  return { fields: out, removed, changed: removed.length > 0 };
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
  // Receipt residue. A scanned receipt names the SHOP, not the person holding
  // it, so `vendorPhone: (619) 625-5263` on Robert's Info tab was the store's
  // number filed as if it were his. These belong on the document, never on a
  // human being. ("customerName" is deliberately absent — it folds to `name`,
  // which genuinely is the person's.)
  receipt: new Set([
    "vendorPhone", "vendorName", "vendorAddress", "merchant", "merchantName",
    "storeNumber", "registerNumber", "cashier", "transactionId", "receiptNumber",
    "subtotal", "taxAmount", "tipAmount", "paymentMethod",
  ]),
};

const PERSON_TYPES = new Set(["person", "self", "pet"]);

// Compare on NORMALIZED identity, not on the literal strings above. Written as
// `vendorPhone`, the entry would never match `fieldIdentity("vendorPhone")` —
// "vendorphone" — and the whole receipt bucket would silently do nothing. That
// is the same exact-string mistake this module exists to end, so the sets are
// normalized once here rather than trusted to be spelled right.
const TYPE_ONLY_IDENTITIES: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(TYPE_ONLY_FIELDS).map(([owner, keys]) => [
    owner,
    new Set([...keys].map((k) => normalizeKey(fieldIdentity(k)))),
  ]),
);

/**
 * Should this field appear on a profile of this type?
 *
 * Returns false for vehicle-only fields on a person. Everything unknown is
 * allowed — this filters obvious mis-filings, it does not police the schema.
 */
export function fieldBelongsOnProfileType(key: unknown, profileType: unknown): boolean {
  const type = String(profileType ?? "").toLowerCase();
  if (!PERSON_TYPES.has(type)) return true;
  const id = normalizeKey(fieldIdentity(key));
  for (const [owner, keys] of Object.entries(TYPE_ONLY_IDENTITIES)) {
    if (owner === type) continue;
    if (keys.has(id)) return false;
  }
  return true;
}
