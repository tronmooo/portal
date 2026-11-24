// Shared by the live workflow checks (tests/live-*-workflows-check.ts): one
// place for PASS/FAIL lines, timed API calls and the speed summary.
//
// Each check drives a domain's workflows against the deployed app as the
// smoke account, reads every write back from the list a screen reads, and
// expects a bad input to be a 4xx with a reason (never a 500).
import { api, type ApiResponse } from "../smoke/fixture/api";
import { UI_BASE } from "../smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "../smoke/fixture/gate-lock";

/** A call slower than this is reported (the route budget is 1.5 s to usable). */
export const SLOW_MS = 1500;

export interface WorkflowRun {
  /** A short unique tag to name this run's records with. */
  tag: string;
  check: (ok: boolean, what: string) => void;
  /** A timed request. `ms` is the request itself, not a wait for the write limit. */
  call: (method: string, path: string, body?: any) => Promise<ApiResponse>;
  /** Registers an undo that runs (in reverse order) however the run ends. */
  cleanup: (undo: () => Promise<unknown>) => void;
  section: (name: string) => void;
}

/** The rows of a list response, whichever envelope the route uses. A shape
 *  with no list in it throws: a missing list must not read as an empty one. */
export function list(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of ["items", "budgets", "transactions", "accounts", "connections", "runs", "candidates", "transfers", "recurring", "data"]) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  throw new Error(`not a list: ${JSON.stringify(data).slice(0, 160)}`);
}

export const detail = (r: { status: number; data: any }) => `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`;

/** A refused input: a 4xx carrying a reason. */
export const refused = (r: { status: number; data: any }) =>
  r.status >= 400 && r.status < 500 && typeof r.data?.error === "string" && r.data.error.length > 0;

export const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

export async function runWorkflowCheck(gate: string, body: (run: WorkflowRun) => Promise<void>): Promise<never> {
  let failed = false;
  const timings: Array<{ call: string; ms: number }> = [];
  const undos: Array<() => Promise<unknown>> = [];
  const run: WorkflowRun = {
    tag: `WF${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    check: (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; },
    call: async (method, path, reqBody) => {
      const r = await api(method, path, reqBody);
      const shape = path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/\/[0-9a-f]{32,}/g, "/:token");
      timings.push({ call: `${method} ${shape}`, ms: r.ms });
      return r;
    },
    cleanup: (undo) => { undos.push(undo); },
    section: (name) => console.log(`\n— ${name}`),
  };

  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate });
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}; run ${run.tag}`);
    await body(run);
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    for (const undo of undos.reverse()) await undo().catch(() => undefined);
    await release();
  }

  const byCall = new Map<string, number[]>();
  for (const t of timings) byCall.set(t.call, [...(byCall.get(t.call) ?? []), t.ms]);
  const worst = [...byCall.entries()].map(([c, ms]) => ({ call: c, max: Math.max(...ms), n: ms.length })).sort((a, b) => b.max - a.max);
  console.log("\n— slowest calls (worst of n)");
  for (const w of worst.slice(0, 8)) console.log(`  ${String(w.max).padStart(5)}ms  ${w.call}  (n=${w.n})`);
  const slow = worst.filter((w) => w.max > SLOW_MS);
  console.log(slow.length
    ? `\nSLOW  ${slow.length} call(s) over ${SLOW_MS}ms: ${slow.map((s) => `${s.call} ${s.max}ms`).join("; ")}`
    : `\nno call over ${SLOW_MS}ms`);
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}
