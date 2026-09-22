// server/integrity-log.ts — Rule 38: serious data anomalies fail loudly.
//
// One sink for every "this should be impossible" the system detects at
// runtime. Before this file each detector had its own fate: the chat routing
// gate wrote to an in-memory ring, the envelope's duplicate_count and
// profile_isolation_valid were "DIAGNOSTIC ONLY — never mention it", and the
// storage layer's ownership guard threw plain errors. None of it was
// countable, so a class of anomaly could recur for weeks without a metric.
//
// The record is deliberately small and structured so it is greppable in the
// platform logs (`[integrity:<kind>]`) and cheap to ship to Sentry. It never
// throws: an integrity log line must not be able to break the write it is
// describing.

import { logger } from "./logger";

export type IntegrityKind =
  | "owner_changed_unexpectedly"
  | "duplicate_write"
  | "child_promoted_to_parent"
  | "impossible_date"
  | "mismatched_totals"
  | "stale_dependency"
  | "ai_read_triggered_write"
  | "scope_mismatch"
  | "conflicting_canonical_facts"
  | "validation_failed"
  | "owner_unresolved"
  | "idempotent_replay";

export interface IntegrityRecord {
  kind: IntegrityKind;
  /** Short, human-readable statement of what was observed. */
  message: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  turnId?: string;
  requestId?: string;
  operationId?: string;
  /** Anything else that helps reconstruct the event. Kept small. */
  detail?: Record<string, unknown>;
  at: string;
}

/** Bounded in-memory ring — a test seam and a debugging aid, not the durable record. */
const RING_SIZE = 500;
const ring: IntegrityRecord[] = [];

const clip = (v: unknown, n = 300): string => {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Record one anomaly. Severity is fixed per kind: anything that means data is
 * already wrong (duplicate write, owner drift, a read that wrote) logs at
 * error; anything that was caught BEFORE the write (validation, unresolved
 * owner, a replay that was correctly short-circuited) logs at warn.
 */
export function logIntegrity(input: Omit<IntegrityRecord, "at"> & { at?: string }): IntegrityRecord {
  const record: IntegrityRecord = {
    ...input,
    message: clip(input.message, 500),
    at: input.at ?? new Date().toISOString(),
  };
  try {
    ring.push(record);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    const caught = new Set<IntegrityKind>(["validation_failed", "owner_unresolved", "idempotent_replay", "scope_mismatch"]);
    const level = caught.has(record.kind) ? "warn" : "error";
    logger[level]("integrity", `[integrity:${record.kind}] ${record.message}`, {
      ...(record.entityType ? { entityType: record.entityType } : {}),
      ...(record.entityId ? { entityId: clip(record.entityId, 64) } : {}),
      ...(record.userId ? { userId: clip(record.userId, 8) } : {}),
      ...(record.turnId ? { turnId: clip(record.turnId, 8) } : {}),
      ...(record.requestId ? { requestId: clip(record.requestId, 32) } : {}),
      ...(record.operationId ? { operationId: clip(record.operationId, 32) } : {}),
      ...(record.detail ? { detail: clip(record.detail, 400) } : {}),
    });
  } catch {
    /* an integrity log line must never fail the write it describes */
  }
  return record;
}

export function getIntegrityRecords(limit = 100, kind?: IntegrityKind): IntegrityRecord[] {
  const rows = kind ? ring.filter((r) => r.kind === kind) : ring;
  return rows.slice(-limit);
}

export function clearIntegrityRecords(): void {
  ring.length = 0;
}
