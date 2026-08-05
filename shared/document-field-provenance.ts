// shared/document-field-provenance.ts — "what did THIS document put on my profile?"
//
// User, 2026-08-05: "When you delete a document, you should delete all the data
// that comes with it and it should ask before you delete a document. If there is
// data I've saved with the document there should be an option when you delete the
// document it should say are you sure? Do you want to remove all the data in the
// info?"
//
// Answering that needs one function, used by BOTH the preview the dialog shows
// and the deletion it performs. If the preview and the purge computed the set
// separately they would drift, and the dialog would promise to remove five
// fields while the delete removed three — the worst possible outcome for a
// confirm prompt, because the user's consent would be to something that didn't
// happen.
//
// TWO SOURCES OF EVIDENCE, in priority order:
//
//   1. RECORDED PROVENANCE — `fields._docFields[documentId] = { key: savedValue }`,
//      written by confirm-extraction when the user accepted the fields. This is
//      authoritative: it names the exact keys and the values as saved, so we can
//      also tell whether the user has edited one since.
//
//   2. EXTRACTION MATCH — the document's own `extractedData` keys, matched
//      against the profile by field IDENTITY. This is the fallback that makes
//      the feature actually work on real data: provenance only exists for fields
//      saved through confirm-extraction, and profiles are full of fields written
//      before that existed, or by chat's update_profile, or by an upload that
//      auto-linked. Those are just as much "the data that came with the
//      document", and a user deleting the document expects them gone.
//
// Matching is by IDENTITY (shared/profile-field-identity), never by exact string,
// and it descends into nested objects — the same rule the delete path uses. A
// document that saved `licenseNumber` matches a profile holding it as
// `identity.license`, which exact-string matching missed entirely.
import { fieldIdentity } from "./profile-field-identity";
import { looselyEqual } from "./profile-field-canon";

export interface DocumentDerivedField {
  /** Storage path on the profile, e.g. "licenseNumber" or "identity.license". */
  path: string;
  /** Leaf key — what to send in `fieldsToDelete` (the resolver matches by identity). */
  key: string;
  /** Human label for the dialog, e.g. "License". */
  label: string;
  /** The field's CURRENT value on the profile, as display text. */
  value: string;
  /**
   * True when the current value no longer matches what the document saved —
   * i.e. the user has edited it by hand since. Surfaced so the dialog can warn
   * that a purge discards their edit, not just the document's data.
   * Always false when we have no recorded value to compare against.
   */
  edited: boolean;
  /** Which evidence found this field. */
  via: "provenance" | "extraction";
}

/** Unwrap the `{ value, confidence }` envelope the extractor sometimes emits. */
function unwrap(v: any): any {
  return (v && typeof v === "object" && !Array.isArray(v) && "value" in v) ? v.value : v;
}

function labelFor(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function asText(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

const isEmpty = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

/**
 * Every field on `profileFields` that this document put there.
 *
 * `documentId` looks up recorded provenance; `extractedData` supplies the
 * fallback identity match. Either may be missing — with neither, the result is
 * empty, which is the honest answer for a document that saved nothing.
 *
 * Reserved metadata (`_docFields`, `_mileageHistory`, `_ownershipPercentage`…)
 * is never returned: it is bookkeeping, not the user's data, and the delete path
 * maintains it separately.
 *
 * Pure. Never mutates its inputs.
 */
export function documentDerivedFields(
  profileFields: Record<string, any> | null | undefined,
  documentId: string | null | undefined,
  extractedData: Record<string, any> | null | undefined,
): DocumentDerivedField[] {
  if (!profileFields || typeof profileFields !== "object") return [];

  // identity → the value the document recorded for it (undefined = "the document
  // mentioned this field but we don't know what it saved").
  const recorded = new Map<string, any>();
  const fromExtraction = new Set<string>();

  const sources = (profileFields as any)._docFields;
  const prov = (documentId && sources && typeof sources === "object") ? sources[documentId] : undefined;
  if (prov && typeof prov === "object") {
    for (const [k, v] of Object.entries(prov as Record<string, any>)) {
      if (k.startsWith("_")) continue;
      recorded.set(fieldIdentity(k), unwrap(v));
    }
  }
  if (extractedData && typeof extractedData === "object") {
    for (const [k, v] of Object.entries(extractedData)) {
      if (k.startsWith("_")) continue;
      const id = fieldIdentity(k);
      if (recorded.has(id)) continue;      // provenance already covers it, and knows more
      fromExtraction.add(id);
      // Remember the extracted value too — it's the best "as saved" reference we
      // have for a field that never went through confirm-extraction.
      if (!isEmpty(unwrap(v))) recorded.set(id, unwrap(v));
    }
  }
  if (recorded.size === 0 && fromExtraction.size === 0) return [];

  const out: DocumentDerivedField[] = [];
  const consider = (path: string, key: string, value: any) => {
    if (key.startsWith("_")) return;
    if (value === undefined || value === null || value === "") return;
    const id = fieldIdentity(key);
    const known = recorded.has(id);
    if (!known && !fromExtraction.has(id)) return;
    const savedVal = recorded.get(id);
    out.push({
      path,
      key,
      label: labelFor(key),
      value: asText(value),
      // No recorded value to compare against → we can't claim it was edited.
      edited: savedVal !== undefined && !looselyEqual(value, savedVal),
      via: fromExtraction.has(id) ? "extraction" : "provenance",
    });
  };

  for (const [k, v] of Object.entries(profileFields)) {
    if (k.startsWith("_")) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // Structural, like the delete path: any object holds fields. A whitelist
      // of group names is always one document type out of date.
      for (const [nk, nv] of Object.entries(v as Record<string, any>)) {
        if (nv && typeof nv === "object") continue; // don't dig past one level
        consider(`${k}.${nk}`, nk, nv);
      }
      continue;
    }
    consider(k, k, v);
  }

  // Provenance-backed first (we're surest about those), then alphabetical so the
  // dialog's list is stable between renders.
  out.sort((a, b) =>
    (a.via === b.via ? 0 : a.via === "provenance" ? -1 : 1) || a.path.localeCompare(b.path));
  return out;
}

/** The `fieldsToDelete` payload for a purge — leaf keys, deduped. */
export function derivedFieldKeys(fields: readonly DocumentDerivedField[]): string[] {
  return [...new Set(fields.map((f) => f.key))];
}
