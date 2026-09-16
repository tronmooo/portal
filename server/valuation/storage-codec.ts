// ─── Valuation storage codec ─────────────────────────────────────────────────
// Both storage backends keep valuations as JSON text in the user-scoped
// `preferences` table (MemStorage mirrors that shape). This module owns the
// key names and the (de)serialization so the two backends cannot drift.
import type { AssetUnderstanding, ValuationHistoryEntry, ValuationRecord } from "@shared/valuation/types";

export const VALUATION_HISTORY_LIMIT = 60;

export function valuationKey(profileId: string): string { return `valuation:${profileId}`; }
export function valuationHistoryKey(profileId: string): string { return `valuation-history:${profileId}`; }
export function understandingKey(profileId: string): string { return `valuation-understanding:${profileId}`; }

export function readUnderstanding(raw: string | null | undefined): AssetUnderstanding | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && typeof parsed.signature === "string" && typeof parsed.kind === "string"
      ? parsed as AssetUnderstanding : null;
  } catch { return null; }
}

export function readValuationRecord(raw: string | null | undefined): ValuationRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || typeof parsed.profileId !== "string") return null;
    return parsed as ValuationRecord;
  } catch { return null; }
}

export function readValuationHistory(raw: string | null | undefined): ValuationHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(e => e && typeof e.valuedAt === "string") : [];
  } catch { return []; }
}

export function toHistoryEntry(record: ValuationRecord): ValuationHistoryEntry {
  return {
    valuedAt: record.valuedAt,
    status: record.status,
    value: record.value,
    low: record.low,
    high: record.high,
    confidence: record.confidence,
    methodology: record.methodology,
    inputFingerprint: record.inputFingerprint,
    refreshReason: record.refreshReason,
  };
}

/** Append, dedupe by valuedAt, keep the newest LIMIT entries. */
export function appendValuationHistory(history: ValuationHistoryEntry[], record: ValuationRecord): ValuationHistoryEntry[] {
  const entry = toHistoryEntry(record);
  const kept = history.filter(h => h.valuedAt !== entry.valuedAt);
  kept.push(entry);
  kept.sort((a, b) => a.valuedAt.localeCompare(b.valuedAt));
  return kept.slice(-VALUATION_HISTORY_LIMIT);
}
