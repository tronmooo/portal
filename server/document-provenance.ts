// ─── A document's fields, after the document itself changes ─────────────────
//
// confirm-extraction copies a document's fields onto the profile the user
// picked (a licence's expiration onto the person who holds it) and records
// what it wrote in `fields._docFields[docId]`. Every reader of that copy
// treats the DOCUMENT as the record: the calendar suppresses the copy while
// the document still holds the same date, the bell warns from the document,
// and the delete cascade takes the copy back when the document goes.
//
// None of that held up when the document was EDITED. Correcting a
// mis-read expiration on the document (the viewer's field editor, the
// calendar's edit/clear of a document date, a re-upload of the same file)
// changed the document alone. The person's copy kept the old date, so the
// calendar showed two expirations for one licence, the bell kept warning
// about the wrong day, and a date the user cleared from the calendar came
// straight back from the copy.
//
// This module is the missing half of the provenance contract: when a
// document's extracted fields change, the copies it wrote follow — and only
// those. The same rule the delete cascade uses decides which copies are still
// the document's to move: the profile must still hold what the document
// wrote (an edit made since is the user's and stays), and the document must
// actually have carried that value before the change (a spelling the
// document never held is not proven to be its copy, so it is left alone).
import type { IStorage } from "./storage";
import { fieldPatchBetween } from "../shared/field-patch";
import {
  PROFILE_FIELD_GROUPS,
  fieldIdentity,
  readProfileFieldValue,
  removeDocumentContributedFields,
} from "@shared/profile-field-identity";
import { looselyEqual } from "@shared/profile-field-canon";

type Logger = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

export interface DocumentFieldPropagation {
  /** Profiles whose copy moved or was removed. */
  affectedProfileIds: string[];
  /** `profileId:key → value` writes, for logs and tests. */
  moved: string[];
  removed: string[];
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Set every stored spelling of `identity` (top level and nested groups) to
 * `value`. Returns the new field map and the keys written.
 */
function writeByIdentity(
  fields: Record<string, any>,
  identity: string,
  savedValue: unknown,
  value: unknown,
): { fields: Record<string, any>; written: string[] } {
  const out: Record<string, any> = { ...fields };
  const written: string[] = [];
  for (const [storedKey, storedValue] of Object.entries(fields)) {
    if (storedKey.startsWith("_")) continue;
    const isGroup =
      (PROFILE_FIELD_GROUPS as readonly string[]).includes(storedKey) &&
      storedValue && typeof storedValue === "object" && !Array.isArray(storedValue);
    if (isGroup) {
      const nested = storedValue as Record<string, any>;
      const hits = Object.keys(nested).filter((nk) => fieldIdentity(nk) === identity && looselyEqual(nested[nk], savedValue));
      if (hits.length === 0) continue;
      const next = { ...nested };
      for (const nk of hits) { next[nk] = value; written.push(`${storedKey}.${nk}`); }
      out[storedKey] = next;
      continue;
    }
    if (fieldIdentity(storedKey) !== identity) continue;
    if (!looselyEqual(storedValue, savedValue)) continue;
    out[storedKey] = value;
    written.push(storedKey);
  }
  return { fields: out, written };
}

/**
 * Move (or take back) the copies a document wrote onto profiles, after the
 * document's extracted fields changed from `before` to `after`.
 *
 * Pure decision, one write per affected profile — a minimal patch, so an
 * edit that landed on the profile meanwhile is not reverted.
 */
export async function propagateDocumentFieldChange(
  storage: IStorage,
  documentId: string,
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined,
  logger: Logger = console,
): Promise<DocumentFieldPropagation> {
  const result: DocumentFieldPropagation = { affectedProfileIds: [], moved: [], removed: [] };
  if (!documentId) return result;
  const prev = before && typeof before === "object" ? before : {};
  const next = after && typeof after === "object" ? after : {};

  let profiles: any[] = [];
  try { profiles = (await storage.getProfiles()) as any[]; }
  catch (err: any) { logger.error(`[doc-edit] could not load profiles for ${documentId}: ${err?.message || err}`); return result; }

  for (const p of profiles) {
    const sources = p?.fields?._docFields;
    const recorded = sources && typeof sources === "object" ? sources[documentId] : undefined;
    if (!recorded || typeof recorded !== "object") continue;

    let fields: Record<string, any> = { ...(p.fields as Record<string, any>) };
    const nextRecorded: Record<string, any> = { ...recorded };
    const movedHere: string[] = [];
    const removedHere: string[] = [];

    for (const [key, savedValue] of Object.entries(recorded as Record<string, any>)) {
      if (key.startsWith("_")) continue;
      const identity = fieldIdentity(key);
      const docBefore = readProfileFieldValue(prev, key);
      const docAfter = readProfileFieldValue(next, key);
      // The document must have carried this copy under a matching spelling;
      // otherwise nothing proves the change is about this field.
      if (isBlank(docBefore) || !looselyEqual(docBefore, savedValue)) continue;
      if (looselyEqual(docBefore, docAfter)) continue;

      if (isBlank(docAfter)) {
        const gone = removeDocumentContributedFields(fields, { [key]: savedValue });
        if (gone.removed.length === 0) continue; // the user's edit; theirs
        fields = gone.fields;
        removedHere.push(...gone.removed);
        delete nextRecorded[key];
        continue;
      }
      const set = writeByIdentity(fields, identity, savedValue, docAfter);
      if (set.written.length === 0) continue; // edited since — the user's
      fields = set.fields;
      movedHere.push(...set.written.map((k) => `${k}=${String(docAfter)}`));
      nextRecorded[key] = docAfter;
    }
    if (movedHere.length === 0 && removedHere.length === 0) continue;

    const patch: Record<string, any> = fieldPatchBetween(p.fields as Record<string, any>, fields);
    for (const k of removedHere.filter((path) => !path.includes("."))) patch[k] = null;
    const remainingSources: Record<string, any> = { ...sources };
    if (Object.keys(nextRecorded).length > 0) remainingSources[documentId] = nextRecorded;
    else delete remainingSources[documentId];
    patch._docFields = Object.keys(remainingSources).length > 0 ? remainingSources : null;

    try {
      await storage.updateProfile(p.id, { fields: patch } as any);
      result.affectedProfileIds.push(p.id);
      result.moved.push(...movedHere.map((m) => `${p.id}:${m}`));
      result.removed.push(...removedHere.map((k) => `${p.id}:${k}`));
      logger.info(`[doc-edit] ${documentId} → ${p.name}: moved ${movedHere.length}, removed ${removedHere.length} document-written field(s)`);
    } catch (err: any) {
      logger.error(`[doc-edit] could not update ${p.name} after ${documentId} changed: ${err?.message || err}`);
    }
  }
  return result;
}
