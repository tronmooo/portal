// ─── Valuation service ──────────────────────────────────────────────────────
//
//   getValuationSnapshot  — CACHE FIRST. One preference read + a fingerprint
//                           over the detail the caller already has. Never a
//                           provider, never a model. This is what rides in the
//                           profile bootstrap so the estimate appears WITH the
//                           asset data.
//   refreshValuation      — BACKGROUND REFRESH. Lock → resolve → context →
//                           plan → (semantic understanding if needed) →
//                           providers → engine → persist + history → mirror.
//                           Runs only when the snapshot said the record is
//                           stale, or the user asked.
//
// User-entered values are never overwritten: the estimate lives in its own
// record; `fields.currentValue` is mirrored only when it is empty or already
// estimator-owned (tracked by `currentValueSource`).

import type { IStorage } from "../storage";
import type { ProfileDetail } from "@shared/schema";
import { isAssetTabProfile } from "@shared/asset-value";
import { logger } from "../logger";
import {
  assessFreshness,
  buildValuationContext,
  computeValuation,
  deriveInternalEvidence,
  errorRecord,
  isEstimatorOwnedValue,
  planValuation,
  scheduleNextRefresh,
  VALUATION_MODEL_VERSION,
} from "@shared/valuation";
import type {
  AssetUnderstanding, RefreshReason, ValuationContext, ValuationPlan, ValuationRecord, ValuationSnapshot,
} from "@shared/valuation/types";
import { bundleFromDetail, resolveAssetBundle } from "./resolver";
import { runProviders } from "./providers/registry";
import { loadCachedUnderstanding, resolveUnderstanding } from "./understanding";
import { MS_PER_HOUR } from "@shared/valuation/planner";

export const VALUATION_LOCK_TTL_MS = 90_000;
export function valuationLockName(profileId: string): string { return `valuation:${profileId}`; }

/** Profiles the valuation system values: owned things (the Assets tab set). */
export function isValuableProfile(p: { type?: string | null; fields?: any } | null | undefined): boolean {
  return !!p && isAssetTabProfile(p);
}

export interface SnapshotOptions {
  detail?: ProfileDetail | null;
  /** A record the caller already read (the bootstrap reads it in its Promise.all). */
  record?: ValuationRecord | null;
  now?: Date;
}

export async function getValuationSnapshot(
  storage: IStorage,
  profileId: string,
  opts: SnapshotOptions = {},
): Promise<ValuationSnapshot | null> {
  const now = opts.now ?? new Date();
  const detail = opts.detail ?? (await storage.getProfileDetail(profileId));
  if (!detail) return null;
  const record = opts.record !== undefined ? opts.record : await storage.getAssetValuation(profileId).catch(() => null);
  if (!isValuableProfile(detail)) {
    return {
      record: null, supported: false, inputFingerprint: "",
      freshness: { fresh: true, reason: null, detail: "Not an owned asset" },
    };
  }
  const ctx = buildValuationContext(bundleFromDetail(detail), now);
  return {
    record,
    supported: true,
    inputFingerprint: ctx.inputFingerprint,
    freshness: assessFreshness(record, ctx.inputFingerprint, now, VALUATION_MODEL_VERSION),
  };
}

export interface RefreshOptions {
  reason: RefreshReason;
  /** Re-value even when the stored record is fresh. */
  force?: boolean;
  detail?: ProfileDetail | null;
  now?: Date;
  /** Wall-clock budget for the external providers, all together. */
  providerBudgetMs?: number;
  /** Allow the semantic-understanding model call (default true when a key is configured). */
  allowModel?: boolean;
}

export interface RefreshOutcome {
  snapshot: ValuationSnapshot | null;
  /** The pipeline ran (false when the record was fresh, unsupported, or locked). */
  ran: boolean;
  /** The estimate (value / range / status / confidence label) differs from before. */
  changed: boolean;
  /** A journaled write happened (record saved and/or profile mirrored). */
  wrote: boolean;
  locked: boolean;
  /** Specs the live search found and auto-filled into empty profile fields. */
  filledSpecs: Record<string, unknown>;
  /** The previous mirrored value, for callers that report a delta. */
  previousValue: number | null;
}

function sameEstimate(a: ValuationRecord | null, b: ValuationRecord): boolean {
  if (!a) return false;
  return a.status === b.status && a.value === b.value && a.low === b.low && a.high === b.high
    && a.confidenceLabel === b.confidenceLabel;
}

function evidenceSources(record: ValuationRecord): string[] {
  const urls: string[] = [];
  for (const e of record.evidence) {
    if (e.reference && /^https?:\/\//.test(e.reference)) urls.push(e.reference);
    const more = (e.raw as any)?.sources;
    if (Array.isArray(more)) for (const s of more) if (typeof s === "string" && /^https?:\/\//.test(s)) urls.push(s);
  }
  return [...new Set(urls)].slice(0, 5);
}

/**
 * The profile-field patch that mirrors a new estimate. Only touches
 * `currentValue` when nothing the user typed is there; always records which
 * side owns it so a later run can tell.
 */
export function mirrorPatchFor(
  fields: Record<string, any>,
  record: ValuationRecord,
  filledSpecs: Record<string, unknown>,
): { patch: Record<string, any>; previousValue: number | null; mirrored: boolean } {
  const patch: Record<string, any> = { ...filledSpecs };
  const existing = fields?.currentValue ?? fields?.current_value;
  const hasExisting = existing != null && String(existing).trim() !== "";
  const estimatorOwned = isEstimatorOwnedValue(fields || {});
  const previousValue = Number(existing) || Number(fields?.purchasePrice) || null;
  if (record.status !== "valued" || record.value == null) {
    return { patch, previousValue, mirrored: false };
  }
  if (hasExisting && !estimatorOwned) {
    // The user's own number stays. Pin its provenance so a legacy marker can
    // never reclassify it as ours.
    if (fields.currentValueSource !== "user") patch.currentValueSource = "user";
    return { patch, previousValue, mirrored: false };
  }
  Object.assign(patch, {
    currentValue: record.value,
    currentValueSource: "estimate",
    previousValue: previousValue ?? 0,
    valuationMethod: record.methodSummary,
    valuationConfidence: record.confidenceLabel,
    valuationRange: record.low != null && record.high != null ? `$${record.low.toLocaleString()} - $${record.high.toLocaleString()}` : "",
    valuationLow: record.low ?? undefined,
    valuationHigh: record.high ?? undefined,
    valuationDate: record.valuedAt,
    valuationFactors: record.factors.slice(0, 8),
    valuationMissingInfo: record.missingInfo.slice(0, 8),
  });
  const sources = evidenceSources(record);
  if (sources.length) patch.valuationSources = sources.join(", ");
  return { patch, previousValue, mirrored: true };
}

function specFillsFrom(evidence: ValuationRecord["evidence"], fields: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of evidence) {
    const specs = (e.raw as any)?.specs;
    if (!specs || typeof specs !== "object") continue;
    for (const [k, v] of Object.entries(specs)) {
      const existing = fields?.[k];
      if (existing === undefined || existing === null || String(existing).trim() === "") out[k] = v;
    }
  }
  return out;
}

async function tryLock(storage: IStorage, name: string): Promise<boolean> {
  try {
    const got = await (storage as any).acquireUserLock?.(name, VALUATION_LOCK_TTL_MS);
    // A backend without locks (route test stubs) just runs.
    return got !== false;
  } catch { return true; }
}
async function unlock(storage: IStorage, name: string): Promise<void> {
  try { await (storage as any).releaseUserLock?.(name); } catch { /* lock expires by ttl */ }
}

export async function refreshValuation(
  storage: IStorage,
  profileId: string,
  opts: RefreshOptions,
): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const none: RefreshOutcome = { snapshot: null, ran: false, changed: false, wrote: false, locked: false, filledSpecs: {}, previousValue: null };

  const detail = opts.detail ?? (await storage.getProfileDetail(profileId));
  if (!detail) return none;
  if (!isValuableProfile(detail)) {
    return { ...none, snapshot: await getValuationSnapshot(storage, profileId, { detail, record: null, now }) };
  }

  const previous = await storage.getAssetValuation(profileId).catch(() => null);
  const quickCtx = buildValuationContext(bundleFromDetail(detail), now);
  const freshness = assessFreshness(previous, quickCtx.inputFingerprint, now, VALUATION_MODEL_VERSION);
  if (!opts.force && freshness.fresh) {
    return { ...none, snapshot: { record: previous, supported: true, inputFingerprint: quickCtx.inputFingerprint, freshness } };
  }

  const lock = valuationLockName(profileId);
  if (!(await tryLock(storage, lock))) {
    return {
      ...none, locked: true,
      snapshot: { record: previous, supported: true, inputFingerprint: quickCtx.inputFingerprint, freshness, refreshing: true },
    };
  }

  const reason: RefreshReason = opts.force ? opts.reason : (freshness.reason ?? opts.reason);
  let ctx: ValuationContext = quickCtx;
  let plan: ValuationPlan = planValuation(ctx, now);
  try {
    // Full bundle: history for trend evidence, the AI summary for the dossier,
    // and whatever understanding is already cached for this shape.
    const cachedUnderstanding = await loadCachedUnderstanding(storage, profileId, quickCtx.signature, now);
    const bundle = await resolveAssetBundle(storage, profileId, {
      detail, includeHistory: true, includeSummary: true, understanding: cachedUnderstanding,
    });
    if (!bundle) return none;
    ctx = buildValuationContext(bundle, now);
    plan = planValuation(ctx, now);

    // The model is consulted only when deterministic planning came up short.
    if (plan.needsAi) {
      const allowModel = opts.allowModel ?? !!process.env.ANTHROPIC_API_KEY;
      const understanding: AssetUnderstanding | null = await resolveUnderstanding(storage, ctx, { allowModel, now });
      if (understanding) {
        ctx = buildValuationContext({ ...bundle, understanding }, now);
        plan = planValuation(ctx, now);
      }
    }

    const internal = deriveInternalEvidence(ctx, plan, now);
    const external = plan.needsExternal
      ? await runProviders(ctx, plan, now, { overallTimeoutMs: opts.providerBudgetMs ?? 40_000 })
      : { evidence: [], failures: {}, succeeded: [], elapsedMs: 0 };
    const evidence = [...internal, ...external.evidence];
    const failed = Object.entries(external.failures);

    let record: ValuationRecord;
    if (evidence.every(e => e.value == null) && failed.length > 0) {
      // Every source we needed failed: keep the previous numbers, back off.
      record = errorRecord(ctx, plan, failed.map(([id, m]) => `${id}: ${m}`).join("; "), previous, { now, refreshReason: reason, computeMs: Date.now() - started });
    } else {
      record = computeValuation(ctx, plan, evidence, { now, refreshReason: reason, computeMs: Date.now() - started });
      if (failed.length > 0) {
        record.error = failed.map(([id, m]) => `${id}: ${m}`).join("; ");
        record.errorCount = (previous?.errorCount || 0) + 1;
        record.factors = [...record.factors, `Some sources were unavailable (${failed.map(([id]) => id).join(", ")})`].slice(0, 10);
      }
    }

    // Specs the live search found on the item's own pages fill EMPTY fields
    // only. They change the material inputs, so the record is stamped with
    // the post-fill fingerprint — otherwise the very next open would say
    // "inputs changed" and run the whole pipeline again.
    const filledSpecs = record.status === "valued" ? specFillsFrom(record.evidence, detail.fields || {}) : {};
    if (Object.keys(filledSpecs).length > 0) {
      const filledDetail = { ...detail, fields: { ...(detail.fields || {}), ...filledSpecs } } as ProfileDetail;
      const filledCtx = buildValuationContext(bundleFromDetail(filledDetail, { history: bundle.history, aiSummary: bundle.aiSummary, understanding: ctx.understanding }), now);
      record.inputFingerprint = filledCtx.inputFingerprint;
      record.materialInputs = filledCtx.materialInputs;
    }

    const usedExternal = external.succeeded.length > 0;
    record.nextRefreshAt = scheduleNextRefresh(record.status, plan, record.errorCount, now, usedExternal);
    if (record.status === "valued" && failed.length > 0) {
      // A partial run is re-tried sooner than a complete one, with backoff.
      const retry = new Date(now.getTime() + Math.min(24 * MS_PER_HOUR, MS_PER_HOUR * Math.pow(2, Math.max(0, record.errorCount - 1)))).toISOString();
      if (retry < record.nextRefreshAt) record.nextRefreshAt = retry;
    }
    record.checkedAt = now.toISOString();
    record.computeMs = Date.now() - started;

    // An error record carries the previous numbers forward; it is bookkeeping
    // (retry backoff), not a new estimate, so it is neither journaled nor
    // added to the history.
    const changed = record.status !== "error" && !sameEstimate(previous, record);
    let wrote = false;
    let previousValue: number | null = null;
    if (changed) {
      await storage.saveAssetValuation(profileId, record);
      wrote = true;
      const mirror = mirrorPatchFor(detail.fields || {}, record, filledSpecs);
      previousValue = mirror.previousValue;
      if (Object.keys(mirror.patch).length > 0) {
        await storage.updateProfile(profileId, { fields: mirror.patch } as any);
        // The narrative summary quotes the value; it must not keep quoting the old one.
        try { await storage.setPreference(`profile_ai_${profileId}`, ""); } catch { /* best-effort */ }
      }
    } else {
      await storage.touchAssetValuation(profileId, record);
    }

    logger.info("valuation", `refreshed ${profileId}`, {
      status: record.status, value: record.value, confidence: record.confidence,
      methods: record.methodology, reason, changed, ms: record.computeMs, failures: failed.length,
    });

    return {
      snapshot: {
        record, supported: true, inputFingerprint: record.inputFingerprint,
        freshness: assessFreshness(record, record.inputFingerprint, now, VALUATION_MODEL_VERSION),
      },
      ran: true, changed, wrote, locked: false, filledSpecs, previousValue,
    };
  } catch (err: any) {
    const record = errorRecord(ctx, plan, String(err?.message || err || "valuation failed"), previous, { now, refreshReason: reason, computeMs: Date.now() - started });
    record.nextRefreshAt = scheduleNextRefresh("error", plan, record.errorCount, now, false);
    try { await storage.touchAssetValuation(profileId, record); } catch { /* nothing else to do */ }
    logger.warn("valuation", `refresh failed for ${profileId}: ${record.error}`);
    return {
      snapshot: { record, supported: true, inputFingerprint: ctx.inputFingerprint, freshness: assessFreshness(record, ctx.inputFingerprint, now, VALUATION_MODEL_VERSION) },
      ran: true, changed: false, wrote: false, locked: false, filledSpecs: {}, previousValue: null,
    };
  } finally {
    await unlock(storage, lock);
  }
}
