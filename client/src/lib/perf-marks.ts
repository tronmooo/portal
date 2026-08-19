// PERF Phase 0 (PERF_PLAN_LAUNCH 2026-07-16): lightweight user-timing marks
// around the startup path and profile switches, so "the app feels slow" is
// attributable to a specific stage instead of a guess.
//
// Marks land in the browser's performance timeline (DevTools → Performance →
// Timings) in every build; the console summary is console.debug, which the
// production build strips (vite.config.ts esbuild.pure), so this costs nothing
// for real users. Read programmatically via performance.getEntriesByType(
// "measure") or window.__portolPerf() in the console.
const PREFIX = "portol:";

export function perfMark(name: string): void {
  try { performance.mark(PREFIX + name); } catch { /* perf API unavailable */ }
}

/** Measure from an earlier mark (or navigation start when omitted/missing). */
export function perfMeasure(name: string, startMark?: string): void {
  try {
    const start = startMark ? PREFIX + startMark : undefined;
    if (start && performance.getEntriesByName(start, "mark").length === 0) {
      performance.measure(PREFIX + name);
    } else {
      performance.measure(PREFIX + name, start);
    }
    const entries = performance.getEntriesByName(PREFIX + name, "measure");
    const last = entries[entries.length - 1];
    if (last) console.debug(`[perf] ${name}: ${Math.round(last.duration)}ms`);
  } catch { /* ignore */ }
}

/** Console helper: dump every portol measure as a table. Dev diagnostics. */
declare global {
  // eslint-disable-next-line no-var
  var __portolPerf: (() => Array<{ name: string; ms: number }>) | undefined;
}
try {
  globalThis.__portolPerf = () => {
    const rows = performance
      .getEntriesByType("measure")
      .filter((e) => e.name.startsWith(PREFIX))
      .map((e) => ({ name: e.name.slice(PREFIX.length), ms: Math.round(e.duration) }));
    if (typeof console.table === "function") console.table(rows);
    return rows;
  };
} catch { /* SSR/test env */ }

/** ?perfLog=1 — opt-in verbose timing output. Never on for real users. */
export function perfLogEnabled(): boolean {
  try {
    return typeof window !== "undefined" &&
      /(?:\?|&)perfLog=1\b/.test(window.location.search + window.location.hash);
  } catch { return false; }
}

/**
 * Print the SERVER half of the write pipeline next to the client marks.
 *
 * The point of pairing them: "the AI is slow" and "the UI is slow" look
 * identical from the outside. With engineMs / per-tool execMs+verifyMs / bumpMs
 * from the server and chat:round-trip + chat:cache-patch from the client, every
 * stage from AI tool call → DB commit → cache update → render is attributable.
 * Shape comes from processMessage's meta.timings (server/ai-engine.ts) plus the
 * cache-barrier numbers routes.ts adds.
 */
export function logServerTimings(payload: unknown): void {
  if (!perfLogEnabled()) return;
  try {
    const t = (payload as any)?.meta?.timings;
    if (!t) return;
    const rows: Array<{ stage: string; ms: number }> = [];
    if (typeof t.engineMs === "number") rows.push({ stage: "server:engine", ms: t.engineMs });
    if (typeof t.aiMs === "number") rows.push({ stage: "server:ai-turn", ms: t.aiMs });
    for (const tool of Array.isArray(t.tools) ? t.tools : []) {
      rows.push({ stage: `server:tool ${tool.tool} exec`, ms: tool.execMs });
      rows.push({ stage: `server:tool ${tool.tool} verify`, ms: tool.verifyMs });
    }
    if (typeof t.bumpMs === "number") rows.push({ stage: "server:cache-barrier", ms: t.bumpMs });
    if (rows.length === 0) return;
    if (typeof console.table === "function") console.table(rows);
    else console.log("[perf] server timings", rows);
  } catch { /* diagnostics must never break a reply */ }
}
