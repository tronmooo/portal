/**
 * What a Smart Fill output document holds, read for display.
 *
 * `POST /api/smart-fill/render` saves the filled copy as a new document whose
 * `extractedData` is ONE object, `smartFill`: where it came from, when, how
 * many fields, and the fields themselves (`{ pdfLabel, value }`). The document
 * page reads it through here so it shows every filled field as label → value
 * instead of a single "Smart Fill" row summarising the metadata, and so the
 * Overview never says "Nothing has been extracted" beside data it holds
 * (QA 2026-11-24, #17).
 *
 * A copy saved before the fields were stored for PDFs carries only the count;
 * `rows` is then empty and `fieldCount` still says how many were filled.
 */

export const SMART_FILL_KEY = "smartFill";

export interface SmartFillFieldRow {
  label: string;
  value: string;
}

export interface SmartFillRecord {
  originalName: string | null;
  filledAt: string | null;
  /** How many fields were filled (stored count, else the rows). */
  fieldCount: number;
  /** Every filled field with a value, in the order it was filled. */
  rows: SmartFillFieldRow[];
  /** Names of the records the values were drawn from. */
  sources: string[];
}

const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

/** The Smart Fill record a document's extractedData carries, or null. */
export function readSmartFill(extractedData: unknown): SmartFillRecord | null {
  if (!extractedData || typeof extractedData !== "object") return null;
  const raw = (extractedData as Record<string, unknown>)[SMART_FILL_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sf = raw as Record<string, unknown>;
  const rows: SmartFillFieldRow[] = [];
  for (const f of Array.isArray(sf.fields) ? sf.fields : []) {
    if (!f || typeof f !== "object") continue;
    const label = str((f as any).pdfLabel) || str((f as any).label);
    const value = str((f as any).value);
    if (!label || !value) continue;
    rows.push({ label, value });
  }
  const stored = Number(sf.fieldCount);
  const sources = (Array.isArray(sf.sources) ? sf.sources : [])
    .map((s: any) => str(s?.name))
    .filter(Boolean);
  return {
    originalName: str(sf.originalName) || null,
    filledAt: str(sf.filledAt) || null,
    fieldCount: Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : rows.length,
    rows,
    sources,
  };
}
