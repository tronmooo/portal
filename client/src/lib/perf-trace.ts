// ── Operation traces ─────────────────────────────────────────────────────────
// perf-marks.ts records INDIVIDUAL durations. This module groups the steps of
// one user-visible operation ("open asset", "create liability") into a single
// block so the console shows what the asset/liability audit asked for:
//
//   [perf] OPEN ASSET  a1b2…
//     profile bootstrap:        72ms
//     first meaningful render: 141ms
//     total:                   141ms
//
// Deliberately development-only in effect: every line goes through
// console.debug, which the production build strips (vite.config.ts
// esbuild.pure), and the traces themselves are a Map of a handful of numbers.
// The step marks also land on the browser performance timeline via perf-marks,
// so a trace can be read from a real device profile as well as the console.
//
// These are MEASUREMENT tools. They exist so "the asset page is slow" becomes
// "the asset page spends 3.1s in the liabilities follow-up query" — nothing in
// this file changes behaviour.
import { perfMark, perfMeasure } from "./perf-marks";

interface Trace {
  label: string;
  startedAt: number;
  lastAt: number;
  steps: Array<{ name: string; ms: number }>;
  done: boolean;
}

const traces = new Map<string, Trace>();

/** How long a trace may stay open before a new start() replaces it. */
const TRACE_TTL_MS = 60_000;

/**
 * Begin (or restart) a trace. `key` identifies the operation instance — use
 * something like `open-asset:${profileId}` so two profiles opened in quick
 * succession don't interleave.
 */
export function traceStart(key: string, label: string): void {
  const now = Date.now();
  traces.set(key, { label, startedAt: now, lastAt: now, steps: [], done: false });
  perfMark(`${key}:start`);
}

/**
 * Record a step. The duration is measured from the previous step (or the
 * trace start), so steps read as a timeline rather than a set of overlapping
 * totals. No-ops when the trace was never started or has already ended — a
 * component that re-renders must not be able to corrupt a finished trace.
 */
export function traceStep(key: string, name: string): void {
  const t = traces.get(key);
  if (!t || t.done) return;
  const now = Date.now();
  if (now - t.startedAt > TRACE_TTL_MS) { traces.delete(key); return; }
  t.steps.push({ name, ms: now - t.lastAt });
  t.lastAt = now;
  perfMeasure(`${key}:${name}`, `${key}:start`);
}

/**
 * Close the trace and print the block. Safe to call more than once — only the
 * first call prints, so a "first meaningful render" effect that re-runs cannot
 * produce duplicate reports.
 */
export function traceEnd(key: string, finalStep?: string): void {
  const t = traces.get(key);
  if (!t || t.done) return;
  if (finalStep) traceStep(key, finalStep);
  t.done = true;
  const total = Date.now() - t.startedAt;
  const width = Math.max(0, ...t.steps.map((s) => s.name.length));
  const lines = t.steps
    .map((s) => `  ${s.name.padEnd(width)}  ${s.ms}ms`)
    .concat(`  ${"total".padEnd(width)}  ${total}ms`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.debug(`[perf] ${t.label}\n${lines}`);
  traces.delete(key);
}

/**
 * Time one awaited operation and report it as a standalone line. Used for the
 * CRUD paths (create / edit / delete) where there is a single round-trip worth
 * naming rather than a multi-step open.
 *
 * Returns the operation's own result and never swallows its error — a failed
 * write is still timed, and still throws.
 */
export async function traceOp<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    // eslint-disable-next-line no-console
    console.debug(`[perf] ${label}: ${Date.now() - started}ms`);
  }
}
