// System (internal) field keys — the ONE definition of "this key is the app's
// own bookkeeping, not a fact the user typed" (Rule 25).
//
// Profile `fields`, tracker entry `values` and document extractions all carry
// metadata beside user data: which document contributed a value
// (`_docFields`), the estimation engine's provenance blob (`_enrichment`),
// the marker a document write leaves so a re-run recognises its own work
// (`_extractionActions`), cache versions, source hashes, embeddings, the chat
// turn that produced a write (`_turnId`). None of that is a field a person
// should read in an Info tab, edit in a form, or delete with an X — and the
// screen that rendered `_extractionActions` as a section titled "_extraction
// Actions" (with a delete X that could not work) is why this module exists.
//
// Two rules follow, and every renderer has to agree with them:
//
//   · a normal screen never lists a system field, and never offers to edit
//     one — `visibleFields()` is the gate an edit form reads through;
//   · Developer Mode (client/src/lib/dev-affordances.ts `devToolsEnabled()`)
//     may REVEAL them, read-only, with a "system" badge. Revealing is not
//     editing: the edit dialog still filters through `isSystemFieldKey`.
//
// The convention is the underscore prefix. `SYSTEM_FIELD_KEYS` lists the keys
// the code actually writes so a grep finds them, and `isSystemFieldKey` is
// true for those AND for any `_`-prefixed key, so a new internal key is hidden
// by default without anyone remembering to register it.
//
// Pure + dependency-free: imported by shared/, server/ and client/.

/**
 * Internal metadata keys the app writes into user-facing records. All are
 * `_`-prefixed. The tracker entry's `computed` column (and its `enrichment`
 * member) hold the same provenance blob, but those are column names on the
 * entry object, never keys inside `values` or `fields` — so they are not
 * listed here, and a user-named field "computed" is not swallowed.
 */
export const SYSTEM_FIELD_KEYS: ReadonlySet<string> = new Set([
  // Estimation engine provenance (shared/estimation-engine): per-value
  // source/confidence/method + the assumptions registry. Written into
  // values._enrichment by the AI lane, moved to entry.computed.enrichment by
  // the storage layer.
  "_enrichment",
  // Document extraction bookkeeping (server/document-provenance).
  "_docFields",
  "_extractionActions",
  "_provenance",
  // Calendar / date-rule bookkeeping.
  "_calendarOptOut",
  // Ownership share stored beside a profile's fields (shared/net-worth).
  "_ownershipPercentage",
  "_mileageHistory",
  // Chat / write attribution.
  "_turnId",
  "_sourceMessageId",
  "_requestId",
  "_operationId",
  "_entityId",
  // Search / dedupe / cache internals.
  "_embedding",
  "_embeddings",
  "_sourceHash",
  "_contentHash",
  "_cacheVersion",
  "_version",
  // Free-text / unit side-channels on tracker entries (never a metric).
  "_notes",
  "_unit",
]);

/**
 * Is this key internal bookkeeping rather than a fact the user typed?
 *
 * True for every key in SYSTEM_FIELD_KEYS AND for any `_`-prefixed key — the
 * prefix is the convention, the set is the inventory. Safe on non-strings
 * (false).
 */
export function isSystemFieldKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return key.startsWith("_") || SYSTEM_FIELD_KEYS.has(key);
}

export interface VisibleFieldsOptions {
  /**
   * When true, system fields are KEPT so a developer surface can show them
   * (read-only). Default false: strip them. Wire it from `devToolsEnabled()`
   * on the client; the server has no developer mode and never passes it.
   */
  developerMode?: boolean;
}

/**
 * The entries of `obj` an ordinary screen may render: system fields removed
 * unless `developerMode` is on. Pure — returns a new object; never mutates.
 * Only the top level is filtered: nested groups (`identity`, `finance`) are
 * user data whose own `_` keys callers handle when they walk them.
 */
export function visibleFields<T extends Record<string, any>>(
  obj: T | null | undefined,
  opts: VisibleFieldsOptions = {},
): Record<string, any> {
  if (!obj || typeof obj !== "object") return {};
  if (opts.developerMode) return { ...obj };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSystemFieldKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The system-field entries of `obj` — what a Developer Mode surface lists
 * under a "system" badge. Values are returned as stored (objects included);
 * callers stringify for display and never offer an edit control.
 */
export function systemFieldEntries(
  obj: Record<string, any> | null | undefined,
): Array<[string, unknown]> {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).filter(([k]) => isSystemFieldKey(k));
}
