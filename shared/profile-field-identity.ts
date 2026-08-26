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
 * The value a field currently holds, matched by IDENTITY the way deletion is —
 * top level first, then every nested group. Used to snapshot what a delete is
 * about to remove so it can be put back.
 *
 * Returns undefined when the profile has no such field under any spelling.
 */
export function readProfileFieldValue(
  fields: Record<string, any> | null | undefined,
  uiKey: unknown,
): any {
  if (!fields || typeof fields !== "object") return undefined;
  const target = fieldIdentity(uiKey);
  if (!target) return undefined;
  const groups: Array<Record<string, any>> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("_")) continue;
    const isGroup =
      (PROFILE_FIELD_GROUPS as readonly string[]).includes(key) &&
      value && typeof value === "object" && !Array.isArray(value);
    if (isGroup) { groups.push(value as Record<string, any>); continue; }
    if (fieldIdentity(key) === target) return value;
  }
  for (const group of groups) {
    for (const [key, value] of Object.entries(group)) {
      if (fieldIdentity(key) === target) return value;
    }
  }
  return undefined;
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

// ─── Confirming an extraction onto a profile ─────────────────────────────────
//
// User report 2026-08-20 (driver-license review card): ticking every field and
// pressing Confirm returned
//   "Saved with warnings — Some pieces didn't save: fields did not persist to
//    Jane Doe: address, issuing State"
// while the server log showed the write succeeding and the profile really did
// end up holding the address and the state.
//
// WHY. The confirm route wrote the payload, then swept alias TWINS of each
// written key to null so a confirmed value replaces every other spelling of
// itself. That sweep ran against the whole merged object — including keys
// written moments earlier BY THE SAME PAYLOAD. A license card sends two
// spellings of one field:
//     address / streetAddress   → both fieldIdentity "address"
//     issuing State / State     → both fieldIdentity "licenseState"
// Writing `streetAddress` nulled the `address` written one loop iteration
// earlier; the post-write verification then compared afterFields["address"]
// (null) against the confirmed value and reported it as unsaved. The data was
// never lost — it sat under the sibling spelling — but the user was told their
// save had failed, every single time a document names one field twice.
//
// The fix is two rules, both lived out here rather than inline in the route:
//   1. Fold twins WITHIN the payload before merging, so one logical field is
//      written once. Only agreeing values are folded — two different values
//      are genuinely different data and both keys survive.
//   2. Never null a key this payload is itself writing.
// And verification asks "did this VALUE land under this IDENTITY anywhere?"
// instead of "is this exact key still spelled the same way?".
//
// Pinned by tests/profile-field-write-identity.test.ts.

import { looselyEqual } from "./profile-field-canon";

const isBlank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

export interface FoldedIncoming {
  /** One entry per logical field (unless two spellings disagreed). */
  fields: Record<string, any>;
  /** Spellings folded away: `{ from: "address", into: "streetAddress" }`. */
  collapsed: Array<{ from: string; into: string }>;
}

/**
 * Collapse alias spellings inside ONE confirmed payload.
 *
 * Preference order for the surviving key: the spelling the profile already
 * uses, then the spelling that matches the canonical identity, then the first
 * key in payload order. A non-empty value always beats an empty one, and two
 * non-empty values that disagree keep both keys — losing one would be losing
 * data the user explicitly ticked.
 */
export function foldIncomingTwins(
  incoming: Record<string, any> | null | undefined,
  existing?: Record<string, any> | null,
): FoldedIncoming {
  const collapsed: Array<{ from: string; into: string }> = [];
  if (!incoming || typeof incoming !== "object") return { fields: {}, collapsed };

  const existingByIdentity = new Map<string, string>();
  for (const k of Object.keys(existing || {})) {
    if (k.startsWith("_")) continue;
    const id = fieldIdentity(k);
    if (!existingByIdentity.has(id)) existingByIdentity.set(id, k);
  }

  const out: Record<string, any> = {};
  // identity → the key in `out` currently carrying that field
  const holder = new Map<string, string>();

  const preferred = (identity: string, a: string, b: string): string => {
    const onProfile = existingByIdentity.get(identity);
    if (onProfile) {
      if (normalizeKey(a) === normalizeKey(onProfile)) return a;
      if (normalizeKey(b) === normalizeKey(onProfile)) return b;
    }
    if (normalizeKey(a) === normalizeKey(identity)) return a;
    if (normalizeKey(b) === normalizeKey(identity)) return b;
    return a; // payload order
  };

  for (const [key, value] of Object.entries(incoming)) {
    if (key.startsWith("_")) { out[key] = value; continue; }
    const identity = fieldIdentity(key);
    const held = holder.get(identity);
    if (held === undefined) {
      out[key] = value;
      holder.set(identity, key);
      continue;
    }
    // Two spellings of one field in the same payload.
    if (isBlank(value)) { collapsed.push({ from: key, into: held }); continue; }
    if (isBlank(out[held])) {
      delete out[held];
      out[key] = value;
      holder.set(identity, key);
      collapsed.push({ from: held, into: key });
      continue;
    }
    if (!looselyEqual(out[held], value)) {
      // Genuinely different values — keep both, lose nothing.
      out[key] = value;
      continue;
    }
    const winner = preferred(identity, held, key);
    if (winner === held) {
      collapsed.push({ from: key, into: held });
    } else {
      delete out[held];
      out[winner] = value;
      holder.set(identity, winner);
      collapsed.push({ from: held, into: winner });
    }
  }
  return { fields: out, collapsed };
}

export interface FieldWriteResult {
  /** The fields object to store (null marks a twin for deletion). */
  fields: Record<string, any>;
  /** What this payload actually writes, after folding. Verify against THIS. */
  written: Record<string, any>;
  collapsed: Array<{ from: string; into: string }>;
  /** Keys nulled because this write superseded them. Safe to drop entirely. */
  superseded: string[];
  /** Odometer readings displaced by a newer one, for `_mileageHistory`. */
  replacedMileage: Array<{ from: string; value: any }>;
}

/**
 * Merge an authoritative field write into a profile's stored fields.
 *
 * "Authoritative" means the write says what the field IS now — a confirmed
 * extraction, an inline edit, an AI `update_profile` call. Every such write
 * goes through here (storage.updateProfile calls it), so a fix landed once
 * covers every door into a profile instead of the one that happened to break.
 *
 * The written value REPLACES every other spelling of the same field — the
 * top-level twin is set to null (the storage merge layer reads null as a
 * deletion intent) and a twin inside a nested group is dropped — so the Info
 * tab can't end up showing "Mileage 80000" and "Current Mileage 69063" as two
 * separate rows. Keys this same payload is writing are never swept: that is
 * the bug documented above.
 *
 * Pure: returns new objects, never mutates the inputs.
 */
export function mergeFieldWrite(
  existing: Record<string, any> | null | undefined,
  incoming: Record<string, any> | null | undefined,
): FieldWriteResult {
  const existingFields = (existing && typeof existing === "object") ? existing : {};
  const { fields: written, collapsed } = foldIncomingTwins(incoming, existingFields);
  const merged: Record<string, any> = { ...existingFields };
  const replacedMileage: Array<{ from: string; value: any }> = [];
  const superseded: string[] = [];
  // Every key this payload writes — off-limits to the twin sweep.
  const writing = new Set(Object.keys(written).map((k) => normalizeKey(k)));

  for (const [key, value] of Object.entries(written)) {
    if (key.startsWith("_")) { merged[key] = value; continue; }
    const identity = fieldIdentity(key);

    for (const existingKey of Object.keys(merged)) {
      if (existingKey === key || existingKey.startsWith("_")) continue;
      if ((PROFILE_FIELD_GROUPS as readonly string[]).includes(existingKey)) continue;
      if (fieldIdentity(existingKey) !== identity) continue;
      // A sibling spelling this payload is also writing is not a stale twin.
      if (writing.has(normalizeKey(existingKey))) continue;
      if (identity === "mileage" && merged[existingKey] != null && !looselyEqual(merged[existingKey], value)) {
        replacedMileage.push({ from: existingKey, value: merged[existingKey] });
      }
      merged[existingKey] = null;
      superseded.push(existingKey);
    }

    for (const group of PROFILE_FIELD_GROUPS) {
      const nested = merged[group];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      const twins = Object.keys(nested).filter((nk) => fieldIdentity(nk) === identity);
      if (twins.length === 0) continue;
      const cleaned: Record<string, any> = { ...nested };
      for (const nk of twins) {
        if (identity === "mileage" && cleaned[nk] != null && !looselyEqual(cleaned[nk], value)) {
          replacedMileage.push({ from: `${group}.${nk}`, value: cleaned[nk] });
        }
        delete cleaned[nk];
      }
      merged[group] = cleaned;
    }

    if (identity === "mileage" && merged[key] != null && !looselyEqual(merged[key], value)) {
      replacedMileage.push({ from: key, value: merged[key] });
    }
    merged[key] = value;
  }

  return { fields: merged, written, collapsed, superseded, replacedMileage };
}

/**
 * Did this confirmed value actually reach the profile?
 *
 * Answers on IDENTITY, not on the literal key: a value written as
 * `streetAddress` counts as saved when the profile holds it under `address`,
 * or inside `personal.address`. Comparing exact keys is what made a successful
 * save report itself as a failure.
 */
export function fieldValuePersisted(
  fields: Record<string, any> | null | undefined,
  key: string,
  value: any,
): boolean {
  if (!fields || typeof fields !== "object") return isBlank(value);
  const identity = fieldIdentity(key);

  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith("_")) continue;
    const isGroup =
      (PROFILE_FIELD_GROUPS as readonly string[]).includes(k) &&
      v && typeof v === "object" && !Array.isArray(v);
    if (isGroup) {
      for (const [nk, nv] of Object.entries(v as Record<string, any>)) {
        if (fieldIdentity(nk) === identity && !isBlank(nv) && looselyEqual(nv, value)) return true;
      }
      continue;
    }
    if (fieldIdentity(k) !== identity) continue;
    if (isBlank(v)) continue;
    if (looselyEqual(v, value)) return true;
  }
  return isBlank(value);
}

/**
 * Remove the fields a deleted document contributed to a profile.
 *
 * `recorded` is the provenance blob confirm-extraction wrote
 * (`fields._docFields[documentId] = { key: savedValue }`). A field is removed
 * only while it still holds what the document saved — anything the user edited
 * since is theirs and stays.
 *
 * Matching is by identity, top level and nested groups alike: the value saved
 * as `streetAddress` may now be stored as `address`, or inside
 * `personal.address`, because a later write supersedes twins. An exact-key
 * cascade walked past both and left the deleted document's data behind.
 *
 * Pure: returns new objects, never mutates the input.
 */
export function removeDocumentContributedFields(
  fields: Record<string, any> | null | undefined,
  recorded: Record<string, any> | null | undefined,
): FieldDeletionResult {
  const removed: string[] = [];
  if (!fields || typeof fields !== "object") return { fields: {}, removed };
  const out: Record<string, any> = { ...fields };
  if (!recorded || typeof recorded !== "object") return { fields: out, removed };

  for (const [key, savedValue] of Object.entries(recorded)) {
    if (key.startsWith("_")) continue;
    const identity = fieldIdentity(key);
    for (const storedKey of Object.keys(out)) {
      if (storedKey.startsWith("_")) continue;
      const storedValue = out[storedKey];
      const isGroup =
        (PROFILE_FIELD_GROUPS as readonly string[]).includes(storedKey) &&
        storedValue && typeof storedValue === "object" && !Array.isArray(storedValue);
      if (isGroup) {
        const nested = storedValue as Record<string, any>;
        const doomed = Object.keys(nested).filter(
          (nk) => fieldIdentity(nk) === identity && looselyEqual(nested[nk], savedValue),
        );
        if (doomed.length === 0) continue;
        const cleaned = { ...nested };
        for (const nk of doomed) { delete cleaned[nk]; removed.push(`${storedKey}.${nk}`); }
        out[storedKey] = cleaned;
        continue;
      }
      if (fieldIdentity(storedKey) !== identity) continue;
      if (!looselyEqual(storedValue, savedValue)) continue;
      delete out[storedKey];
      removed.push(storedKey);
    }
  }
  return { fields: out, removed };
}

/**
 * Split the fields a document contributed to a profile into the ones it is the
 * SOLE source of and the ones another document also vouches for.
 *
 * `fields._docFields[documentId] = { key: savedValue }` is the provenance blob
 * confirm-extraction writes. Two documents routinely record the same fact — an
 * insurance declaration and a title deed both carry the property address — and
 * before this split a delete took the value away on the strength of one of
 * them. The rule the user asked for is narrower and correct: deleting a
 * document removes only its OWN provenance link when the value has another
 * live source; the value itself goes only when this document was the last one
 * holding it up.
 *
 * "Another source" is matched the way the rest of this module matches fields —
 * by identity, not by the literal key — and requires the same value, so a
 * second document recording a DIFFERENT expiration does not keep this one's
 * alive.
 *
 * Pure: reads `fields`, returns new objects.
 */
export function splitDocumentContributedFields(
  fields: Record<string, any> | null | undefined,
  documentId: string,
): { exclusive: Record<string, any>; shared: Record<string, any> } {
  const exclusive: Record<string, any> = {};
  const shared: Record<string, any> = {};
  const sources = (fields as any)?._docFields;
  const recorded = sources && typeof sources === "object" ? sources[documentId] : undefined;
  if (!recorded || typeof recorded !== "object") return { exclusive, shared };

  for (const [key, savedValue] of Object.entries(recorded as Record<string, any>)) {
    if (key.startsWith("_")) continue;
    const identity = fieldIdentity(key);
    let alsoElsewhere = false;
    for (const [otherDocId, otherRecorded] of Object.entries(sources as Record<string, any>)) {
      if (otherDocId === documentId) continue;
      if (!otherRecorded || typeof otherRecorded !== "object") continue;
      for (const [otherKey, otherValue] of Object.entries(otherRecorded as Record<string, any>)) {
        if (otherKey.startsWith("_")) continue;
        if (fieldIdentity(otherKey) !== identity) continue;
        if (!looselyEqual(otherValue, savedValue)) continue;
        alsoElsewhere = true;
        break;
      }
      if (alsoElsewhere) break;
    }
    if (alsoElsewhere) shared[key] = savedValue;
    else exclusive[key] = savedValue;
  }
  return { exclusive, shared };
}
