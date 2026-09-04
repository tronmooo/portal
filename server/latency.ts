// ============================================================
// latency.ts — per-action stage tracing
// ============================================================
// WHY (2026-09 performance audit): "chat is slow" and "the page didn't
// update" were both unfalsifiable. A turn that took 40 seconds produced one
// log line with a total, so every diagnosis started by guessing which stage
// ate the time — intent, entity resolution, the structured lookup, semantic
// search, document fetch, context assembly, the model, or post-processing.
//
// This module makes every slow action explain itself. A trace is a flat list
// of named stages with durations plus a small attribute bag, emitted as ONE
// structured line when the action ends. It is deliberately tiny:
//
//   · no external dependency, no transport, no sampling buffer — a serverless
//     instance can die at any moment, so a trace that isn't flushed inline is
//     a trace that never existed;
//   · never throws and never awaits, so instrumentation cannot change the
//     behaviour or the latency of the thing it measures;
//   · slow traces log at warn with full stage detail, fast ones log at debug,
//     so production logs show the pathology without drowning in the healthy
//     case.
//
// Usage:
//     const t = startTrace("chat", { userId, messageLen });
//     const done = t.stage("structured_lookup");
//     ... work ...
//     done();
//     t.set("tier", 1);
//     t.end();                    // emits
//
// or, for a single awaited step:
//     const rows = await t.measure("db.getDocuments", () => storage.getDocuments());
// ============================================================

import { logger } from "./logger";

/** Actions we trace. Keeping this a union means a typo can't create a
 *  silently separate metric stream. */
export type TraceKind = "chat" | "mutation" | "document" | "upload" | "query";

/** Above this, a trace is a performance event and logs in full. */
const SLOW_THRESHOLD_MS: Record<TraceKind, number> = {
  chat: 2_000,
  mutation: 1_000,
  document: 1_500,
  upload: 10_000,
  query: 500,
};

export interface StageRecord {
  name: string;
  ms: number;
}

export interface TraceSummary {
  kind: TraceKind;
  totalMs: number;
  stages: StageRecord[];
  attrs: Record<string, unknown>;
}

/** Optional sink so tests (and, later, a metrics backend) can observe traces
 *  without parsing log lines. Set to null to disable. */
let sink: ((t: TraceSummary) => void) | null = null;
export function setTraceSink(fn: ((t: TraceSummary) => void) | null): void {
  sink = fn;
}

export interface Trace {
  /** Open a stage; call the returned function to close it. Safe to call the
   *  closer twice (the second call is ignored) and safe to never call it (the
   *  stage is then reported as unclosed rather than silently dropped). */
  stage(name: string): () => void;
  /** Time one awaited step and return its value. */
  measure<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Time one synchronous step and return its value. */
  measureSync<T>(name: string, fn: () => T): T;
  /** Attach context (tier, route, model, row counts, cache hit/miss…). */
  set(key: string, value: unknown): void;
  /** Milliseconds since the trace started. */
  elapsed(): number;
  /** Emit. Idempotent — a second call is ignored. */
  end(extra?: Record<string, unknown>): TraceSummary;
}

const NOOP_CLOSE = () => {};

/**
 * Start a trace. Never throws; on any internal failure it degrades to a no-op
 * so a broken metric can never break a user request.
 */
export function startTrace(kind: TraceKind, attrs: Record<string, unknown> = {}): Trace {
  const startedAt = Date.now();
  const stages: StageRecord[] = [];
  const open = new Map<string, number>();
  const bag: Record<string, unknown> = { ...attrs };
  let ended = false;

  const trace: Trace = {
    stage(name: string) {
      try {
        const t0 = Date.now();
        open.set(name, t0);
        let closed = false;
        return () => {
          if (closed) return;
          closed = true;
          open.delete(name);
          stages.push({ name, ms: Date.now() - t0 });
        };
      } catch {
        return NOOP_CLOSE;
      }
    },
    async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const done = trace.stage(name);
      try {
        return await fn();
      } finally {
        done();
      }
    },
    measureSync<T>(name: string, fn: () => T): T {
      const done = trace.stage(name);
      try {
        return fn();
      } finally {
        done();
      }
    },
    set(key: string, value: unknown) {
      try { bag[key] = value; } catch { /* never break the request */ }
    },
    elapsed() {
      return Date.now() - startedAt;
    },
    end(extra?: Record<string, unknown>): TraceSummary {
      const totalMs = Date.now() - startedAt;
      if (ended) return { kind, totalMs, stages: [...stages], attrs: { ...bag, ...(extra || {}) } };
      ended = true;
      let summary: TraceSummary = { kind, totalMs, stages: [...stages], attrs: { ...bag } };
      try {
        Object.assign(bag, extra || {});
        // An unclosed stage is a bug in the instrumentation, not in the app —
        // report it rather than hiding it. This must happen BEFORE the summary
        // snapshot is taken, or the sink never sees it.
        for (const [name, t0] of open) stages.push({ name: `${name}:unclosed`, ms: Date.now() - t0 });
        open.clear();
        summary = { kind, totalMs, stages: [...stages], attrs: { ...bag } };

        // Stages are additive but not necessarily exhaustive (parallel work
        // overlaps, and not every millisecond is inside a stage). Reporting
        // the unattributed remainder is what stops "the stages add to 3s but
        // the request took 30s" from being a mystery.
        const accounted = stages.reduce((a, s) => a + s.ms, 0);
        const line = stages.map((s) => `${s.name}=${s.ms}ms`).join(" ");
        const attrLine = Object.entries(bag)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)}`)
          .join(" ");
        const msg = `[trace:${kind}] total=${totalMs}ms accounted=${accounted}ms ${line}${attrLine ? ` | ${attrLine}` : ""}`;

        if (totalMs >= (SLOW_THRESHOLD_MS[kind] ?? 1000)) logger.warn("perf", msg);
        else logger.info("perf", msg);
      } catch { /* a metric must never break a request */ }
      try { sink?.(summary); } catch { /* nor may a sink */ }
      return summary;
    },
  };
  return trace;
}

/**
 * The stage vocabulary, pinned so the chat path, the mutation path and the
 * dashboards all spell the same stage the same way. Referenced by
 * tests/latency-telemetry.test.ts.
 */
export const CHAT_STAGES = [
  "intent",
  "entity_resolution",
  "structured_lookup",
  "semantic_search",
  "document_fetch",
  "context_build",
  "model",
  "postprocess",
] as const;

export const MUTATION_STAGES = [
  "validate",
  "db_commit",
  "derived",
  "cache_bust",
  "manifest",
] as const;

export const DOCUMENT_STAGES = [
  "metadata_fetch",
  "content_fetch",
  "parse",
  "render",
] as const;
