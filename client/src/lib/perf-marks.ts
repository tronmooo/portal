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
