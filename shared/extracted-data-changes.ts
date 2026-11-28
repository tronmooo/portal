// A document's fields are changed KEY BY KEY on the stored row (Rule 6).
//
// The document page used to send its whole `extractedData` back for every
// edit — the copy it had loaded, with one key changed. A page loaded before an
// extraction finished, or open on a second device, wrote its old copy over
// every field it did not touch (integrity findings, 2026-11-28). The page now
// sends only what it changes, and the server applies it to the row it reads.
import { normalizeFieldKey } from "./date-rules";

export interface ExtractedDataChanges {
  /** Keys to write, with their new values. */
  set?: Record<string, unknown>;
  /** Keys to remove. */
  remove?: string[];
  /** Values to take out of a list-valued key (compared by field path). */
  unlist?: { key: string; values: string[] };
}

/** "Policy.Expiration Date" and "policy.expirationDate" name the same field. */
export const fieldPathNorm = (v: unknown): string =>
  String(v ?? "").split(".").map(normalizeFieldKey).filter(Boolean).join(".");

export function isExtractedDataChanges(v: unknown): v is ExtractedDataChanges {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as any;
  if (c.set !== undefined && (typeof c.set !== "object" || c.set === null || Array.isArray(c.set))) return false;
  if (c.remove !== undefined && (!Array.isArray(c.remove) || c.remove.some((k: unknown) => typeof k !== "string"))) return false;
  if (c.unlist !== undefined && (typeof c.unlist?.key !== "string" || !Array.isArray(c.unlist?.values))) return false;
  return c.set !== undefined || c.remove !== undefined || c.unlist !== undefined;
}

/** The stored fields with the changes applied; the stored object is not modified. */
export function applyExtractedDataChanges(stored: Record<string, unknown> | null | undefined, changes: ExtractedDataChanges): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(stored || {}) };
  for (const k of changes.remove || []) delete out[k];
  for (const [k, v] of Object.entries(changes.set || {})) out[k] = v;
  if (changes.unlist) {
    const drop = new Set(changes.unlist.values.map(fieldPathNorm));
    const cur = out[changes.unlist.key];
    out[changes.unlist.key] = (Array.isArray(cur) ? cur : []).filter((v) => !drop.has(fieldPathNorm(v)));
  }
  return out;
}
