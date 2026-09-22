// shared/domain — the global consistency layer.
//
//   Database / source records
//     ↓ canonicalEntityType          (entity-types)
//     ↓ resolveOwnership / visibility (ownership)
//     ↓ findDuplicate                 (dedup)
//     ↓ domain logic                  (date-status, financial-period, health,
//                                      payment-classification, liability-payment,
//                                      alerts, priority, outliers, counts …)
//     ↓ shared aggregates
//   Dashboard / Chat / Search / Calendar / Notifications / Profiles
//
// A page never decides on its own who owns a record, whether it is overdue,
// whether a payment is fixed, which month an expense belongs to, what a
// health reading means, or whether two records are duplicates. It calls here.

export * from "./entity-types";
export * from "./ownership";
export * from "./dedup";
export * from "./liability-payment";
export * from "./date-status";
export * from "./financial-period";
export * from "./data-environment";
export * from "./payment-classification";
export * from "./counts";
export * from "./health";
export * from "./tracker-icons";
export * from "./tracker-metadata";
export * from "./alerts";
export * from "./outliers";
export * from "./wellness-window";
export * from "./priority";
export * from "./format";
export * from "./route-metadata";
export * from "./documents-artifacts";
export * from "./asset-grouping";

import { canonicalEntityType, type RecordSource } from "./entity-types";
import { resolveOwnership, visibilityFor, type OwnershipContext, type ResolvedScope, type ResolvedOwnership } from "./ownership";
import { forEnvironment, type EnvironmentTagged } from "./data-environment";
import { findDuplicate, type DedupRecord } from "./dedup";

export interface ResolvedRecord<T> {
  record: T;
  entityType: ReturnType<typeof canonicalEntityType>;
  ownership: ResolvedOwnership;
}

export interface ResolveOptions<T> {
  scope: ResolvedScope;
  ctx: OwnershipContext;
  includeTestData?: boolean;
  /** When given, near-duplicate rows collapse onto the first one seen. */
  dedupKey?: (row: T) => DedupRecord;
}

/**
 * The pipeline for one record set: environment → visibility → ownership →
 * dedupe. Every surface that lists or counts records calls this.
 */
export function resolveRecordSet<T extends EnvironmentTagged>(source: RecordSource | string, rows: readonly T[], opts: ResolveOptions<T>): ResolvedRecord<T>[] {
  const out: ResolvedRecord<T>[] = [];
  const kept: DedupRecord[] = [];
  for (const record of forEnvironment(rows, { includeTest: opts.includeTestData === true })) {
    if (visibilityFor(source, record, opts.scope, opts.ctx) !== "visible") continue;
    if (opts.dedupKey) {
      const key = opts.dedupKey(record);
      if (findDuplicate(key, kept).confidence === "high") continue;
      kept.push(key);
    }
    out.push({ record, entityType: canonicalEntityType(source, record), ownership: resolveOwnership(source, record, opts.ctx) });
  }
  return out;
}
