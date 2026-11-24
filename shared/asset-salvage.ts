// ─── Salvage value: estimated by the AI, overridden only by the user ─────────
//
// Owner, 2026-11-24: "Salvage value should be determined by AI for the
// assets." The value-tracking run (server/valuation/service.ts) asks the model
// for what the thing would still fetch at the end of its useful life (scrap,
// parts, resale as-is) and stores it on the profile beside its provenance —
// the same pattern as `currentValue` / `currentValueSource`:
//
//   salvageValue        the figure every screen reads (SALVAGE_KEY)
//   salvageValueSource  "estimate" (the AI wrote it) | "user" (typed)
//   salvageValueBasis   one sentence: why that figure
//   salvageValueAsOf    when it was estimated
//   salvageValueFor     the facts it was estimated from (salvageInputsKey)
//
// A figure the user typed is theirs and is never overwritten; removing it
// hands the field back to the AI on the next run. These keys are OUTPUTS of
// the valuation, never inputs (shared/valuation/context.ts PRIOR_VALUATION_KEYS):
// writing one must not make the next open think the asset changed.

import { MS_PER_DAY } from "./obligation-windows";

export const SALVAGE_KEY = "salvageValue";
export const SALVAGE_SOURCE_KEY = "salvageValueSource";
export const SALVAGE_BASIS_KEY = "salvageValueBasis";
export const SALVAGE_AS_OF_KEY = "salvageValueAsOf";
export const SALVAGE_FOR_KEY = "salvageValueFor";

/** Every key this module owns. A delete of the figure removes all of them. */
export const SALVAGE_KEYS = [SALVAGE_KEY, SALVAGE_SOURCE_KEY, SALVAGE_BASIS_KEY, SALVAGE_AS_OF_KEY, SALVAGE_FOR_KEY] as const;
/** The bookkeeping keys — never shown as facts about the asset. */
export const SALVAGE_BOOKKEEPING_KEYS = [SALVAGE_SOURCE_KEY, SALVAGE_BASIS_KEY, SALVAGE_AS_OF_KEY, SALVAGE_FOR_KEY] as const;

/** An AI estimate is re-asked at most this often when nothing it used changed. */
export const SALVAGE_MAX_AGE_MS = 180 * MS_PER_DAY;

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") { const n = Number(v.replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/**
 * Who owns the stored figure. A figure with no source stamp was typed before
 * the AI estimated salvage values, so it is the user's.
 */
export function salvageSource(fields: Record<string, any> | null | undefined): "estimate" | "user" | null {
  const f = fields || {};
  const raw = f[SALVAGE_KEY];
  const has = raw !== undefined && raw !== null && String(raw).trim() !== "";
  if (!has) return null;
  return f[SALVAGE_SOURCE_KEY] === "estimate" ? "estimate" : "user";
}

/** The facts a salvage estimate depends on. A change in any re-asks the AI. */
export function salvageInputsKey(input: { name?: string | null; kind?: string | null; purchasePrice?: number | null; purchaseDate?: string | null; condition?: string | null }): string {
  return [
    String(input.name || "").trim().toLowerCase(),
    String(input.kind || "").trim().toLowerCase(),
    Math.round(num(input.purchasePrice)),
    String(input.purchaseDate || "").slice(0, 10),
    String(input.condition || "").trim().toLowerCase(),
  ].join("|");
}

/** Should the next valuation run ask the AI for a salvage value? */
export function salvageNeedsEstimate(fields: Record<string, any> | null | undefined, inputsKey: string, now: Date): boolean {
  const f = fields || {};
  const source = salvageSource(f);
  if (source === "user") return false;
  if (source === null) return true;
  if (String(f[SALVAGE_FOR_KEY] || "") !== inputsKey) return true;
  const at = Date.parse(String(f[SALVAGE_AS_OF_KEY] || ""));
  return !Number.isFinite(at) || now.getTime() - at >= SALVAGE_MAX_AGE_MS;
}

export interface SalvageEstimate { value: number; basis: string }

/**
 * The model's answer, checked. A salvage value is never negative and never
 * above what the thing cost or is worth now (whichever is larger) — a figure
 * outside that is not a salvage value, so it is refused, not clamped.
 * `null` from the model (an appreciating asset: a house, art, gold) is null.
 */
export function normalizeSalvageEstimate(
  raw: unknown,
  bounds: { purchasePrice?: number | null; currentValue?: number | null },
): SalvageEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.salvageValue === null || r.salvageValue === undefined) return null;
  const value = num(r.salvageValue);
  if (!(value >= 0)) return null;
  const ceiling = Math.max(num(bounds.purchasePrice), num(bounds.currentValue));
  if (ceiling > 0 && value > ceiling) return null;
  const basis = typeof r.basis === "string" ? r.basis.trim().replace(/\s+/g, " ").slice(0, 240) : "";
  return { value: Math.round(value), basis };
}

/** The profile-field patch that stores an AI estimate. */
export function salvageEstimatePatch(est: SalvageEstimate, inputsKey: string, now: Date): Record<string, unknown> {
  return {
    [SALVAGE_KEY]: est.value,
    [SALVAGE_SOURCE_KEY]: "estimate",
    [SALVAGE_BASIS_KEY]: est.basis || null,
    [SALVAGE_AS_OF_KEY]: now.toISOString(),
    [SALVAGE_FOR_KEY]: inputsKey,
  };
}

/**
 * A profile PATCH from a person (the page, the chat's update_profile): a
 * salvage figure they send is theirs; removing it removes its provenance too,
 * so the AI estimates it again. Mutates and returns `body`.
 */
export function stampSalvageProvenance<T extends { fields?: any; fieldsToDelete?: any }>(body: T): T {
  const f = body.fields && typeof body.fields === "object" ? body.fields as Record<string, any> : null;
  if (f && SALVAGE_KEY in f && f[SALVAGE_SOURCE_KEY] === undefined) {
    const typed = f[SALVAGE_KEY];
    if (typed !== null && String(typed).trim() !== "") {
      f[SALVAGE_SOURCE_KEY] = "user";
      f[SALVAGE_BASIS_KEY] = null;
      f[SALVAGE_AS_OF_KEY] = new Date().toISOString();
      f[SALVAGE_FOR_KEY] = null;
    }
  }
  if (Array.isArray(body.fieldsToDelete) && body.fieldsToDelete.includes(SALVAGE_KEY)) {
    const set = new Set<string>(body.fieldsToDelete.map(String));
    for (const k of SALVAGE_KEYS) set.add(k);
    (body as any).fieldsToDelete = [...set];
  }
  return body;
}
