// Integrity run framework.
//
// WHY (owner, 2026-11-27: "Do not mark a feature as passing simply because a
// button responds or a success notification appears. A feature passes only
// when the intended action, persisted data, dependent calculations, and all
// affected screens have been verified."): the existing live checks print PASS
// per assertion, and nothing stops a check from asserting only the response of
// the write it just made. Here every scenario DECLARES the evidence it owes:
//
//   action   the request (or the tap) did what was asked, read back from the app
//   db       the stored row, read straight from Postgres (not through the app)
//   derived  a figure computed from the record equals an INDEPENDENT calculation
//            (tests/integrity/oracle.ts never imports the app's shared/ code)
//   screen   a real browser shows it, without a page reload
//
// A scenario with a passing check of every kind it owes is PASS. One that is
// short a kind is INCOMPLETE — never PASS — and one failed check is FAIL, with
// the steps that led to it (and a screenshot when a browser was open).
//
// The run writes as the smoke account only, holds its gate lock, and removes
// every record it made (CLAUDE.md: "Only the smoke account may be written to").
import fs from "node:fs";
import path from "node:path";
import { api as smokeApi, fetchWithRateLimitRetry, getSmokeToken, type ApiResponse } from "../smoke/fixture/api";
import { API_BASE, SB_URL, SB_ANON, SMOKE_USER_ID } from "../smoke/fixture/account";

export type Evidence = "action" | "db" | "derived" | "screen";
export type CheckKind = Evidence | "isolation" | "perf" | "guard";
export type Status = "pass" | "fail" | "incomplete" | "error" | "skipped";

export interface Check { kind: CheckKind; ok: boolean; what: string; detail?: string }
export interface Finding { severity: "bug" | "discrepancy" | "sync" | "perf" | "gap"; title: string; detail: string; scenario: string }

export interface ScenarioResult {
  id: string; title: string; area: string; covers: string[]; requires: Evidence[];
  status: Status; checks: Check[]; steps: string[]; error?: string; screenshots: string[]; ms: number;
  missing: Evidence[]; skippedWhy?: string;
}

export interface Ctx {
  /** Unique per run, in every record name the run creates. */
  tag: string;
  /** Deterministic for a given --seed. */
  rng: () => number;
  int: (lo: number, hi: number) => number;
  pick: <T>(xs: readonly T[]) => T;
  /** Today's calendar day in the app's zone. */
  today: string;
  api: (method: string, path: string, body?: any) => Promise<ApiResponse>;
  /** The same request signed as the OTHER test account (isolation). */
  apiAsOther: (method: string, path: string, body?: any) => Promise<ApiResponse>;
  db: Db;
  check: (kind: CheckKind, ok: boolean, what: string, detail?: string) => boolean;
  /** Numbers within `tol` (default half a cent). */
  near: (kind: CheckKind, actual: unknown, expected: number, what: string, tol?: number) => boolean;
  same: (kind: CheckKind, actual: unknown, expected: unknown, what: string) => boolean;
  step: (text: string) => void;
  finding: (f: Omit<Finding, "scenario">) => void;
  cleanup: (undo: () => Promise<unknown>) => void;
  /** Present when the run has a browser; scenarios marked `browser` need it. */
  ui?: UiHandle;
  self: { id: string; name: string };
}

export interface UiHandle {
  desktop: any; // SignedInPage
  phone: any;
  shot: (page: any, name: string) => Promise<string>;
}

export interface Db {
  /** One row by id, or null. Throws on a query error: a failed read is not "no row". */
  row: (table: string, id: string) => Promise<any | null>;
  rows: (table: string, query: string) => Promise<any[]>;
  count: (table: string, query: string) => Promise<number>;
}

export interface ScenarioDef {
  id: string; title: string; area: string;
  /** `entity.operation.door` keys of tests/integrity/model.ts this scenario proves. */
  covers: string[];
  requires: Evidence[];
  browser?: boolean;
  /** Spends model calls; skipped with --no-chat. */
  chat?: boolean;
  run: (ctx: Ctx) => Promise<void>;
}

const registry: ScenarioDef[] = [];
export function scenario(def: ScenarioDef): void {
  if (registry.some((s) => s.id === def.id)) throw new Error(`duplicate scenario id ${def.id}`);
  registry.push(def);
}
export const allScenarios = (): readonly ScenarioDef[] => registry;

// ── deterministic randomness ────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const laToday = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

// ── direct database reads (Postgres through PostgREST, the account's own RLS) ─
export function makeDb(): Db {
  const get = async (q: string, countOnly = false) => {
    const { response } = await fetchWithRateLimitRetry(`${SB_URL}/rest/v1/${q}`, {
      method: countOnly ? "HEAD" : "GET",
      headers: { apikey: SB_ANON, Authorization: `Bearer ${await getSmokeToken()}`, Prefer: "count=exact" },
    });
    if (!response.ok) throw new Error(`db read ${q}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  return {
    row: async (table, id) => {
      const rows = await (await get(`${table}?select=*&id=eq.${id}`)).json();
      return rows[0] ?? null;
    },
    rows: async (table, query) => (await get(`${table}?select=*&${query}`)).json(),
    count: async (table, query) => {
      const r = await get(`${table}?select=id&${query}`, true);
      const total = (r.headers.get("content-range") || "").split("/")[1];
      if (!/^\d+$/.test(total || "")) throw new Error(`db count ${table}: no total (${r.headers.get("content-range")})`);
      return Number(total);
    },
  };
}

// ── the other account (isolation) ───────────────────────────────────────────
// The QA account the contract suite's isolation test already signs in as. It
// is only ever asked to reach the smoke account's rows, which must be refused,
// so nothing is written to it.
let otherToken: string | null = null;
export async function getOtherToken(): Promise<string> {
  if (otherToken) return otherToken;
  const email = process.env.INTEGRITY_OTHER_EMAIL || "testfix2026@aol.com";
  const password = process.env.INTEGRITY_OTHER_PASSWORD || "Testtest1!";
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(SB_URL, SB_ANON);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`other-account sign-in failed: ${error?.message}`);
  if (data.session.user.id === SMOKE_USER_ID) throw new Error("the other account is the smoke account");
  otherToken = data.session.access_token;
  return otherToken;
}

// ── running ─────────────────────────────────────────────────────────────────
export interface RunOptions {
  seed: number; only?: RegExp; chat: boolean; browser: boolean; outDir: string;
  ui?: UiHandle; self: { id: string; name: string };
}

const shape = (p: string) => p.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");

export async function runScenarios(opts: RunOptions): Promise<{ results: ScenarioResult[]; findings: Finding[]; timings: Array<{ call: string; ms: number }> }> {
  const results: ScenarioResult[] = [];
  const findings: Finding[] = [];
  const timings: Array<{ call: string; ms: number }> = [];
  const db = makeDb();
  let n = 0;
  for (const def of allScenarios()) {
    n++;
    const base: ScenarioResult = {
      id: def.id, title: def.title, area: def.area, covers: def.covers, requires: def.requires,
      status: "skipped", checks: [], steps: [], screenshots: [], ms: 0, missing: [],
    };
    if (opts.only && !opts.only.test(def.id)) continue;
    if (def.chat && !opts.chat) { results.push({ ...base, skippedWhy: "--no-chat" }); continue; }
    if (def.browser && !opts.ui) { results.push({ ...base, skippedWhy: opts.browser ? "browser unavailable" : "--no-browser" }); continue; }

    const rng = mulberry32(opts.seed + n * 7919);
    const undos: Array<() => Promise<unknown>> = [];
    const res = { ...base };
    const ctx: Ctx = {
      tag: `IG${opts.seed.toString(36).toUpperCase()}${n.toString(36).toUpperCase()}${Math.floor(Date.now() / 1000).toString(36).slice(-3).toUpperCase()}`,
      rng,
      int: (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)),
      pick: (xs) => xs[Math.floor(rng() * xs.length)],
      today: laToday(),
      api: async (method, p, body) => {
        const r = await smokeApi(method, p, body);
        timings.push({ call: `${method} ${shape(p)}`, ms: r.ms });
        res.steps.push(`${method} /api${p}${body !== undefined ? ` ${JSON.stringify(body).slice(0, 300)}` : ""} → ${r.status}`);
        return r;
      },
      apiAsOther: async (method, p, body) => {
        const { response, ms } = await fetchWithRateLimitRetry(`${API_BASE}${p}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getOtherToken()}` },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        let data: any = text;
        try { data = JSON.parse(text); } catch { /* text */ }
        res.steps.push(`[other account] ${method} /api${p} → ${response.status}`);
        return { status: response.status, ok: response.ok, data, headers: response.headers, ms };
      },
      db,
      check: (kind, ok, what, detail) => {
        res.checks.push({ kind, ok, what, detail: ok ? undefined : detail });
        console.log(`  ${ok ? "ok  " : "FAIL"} [${kind}] ${what}${!ok && detail ? ` — ${detail}` : ""}`);
        return ok;
      },
      near: (kind, actual, expected, what, tol = 0.005) => {
        const a = typeof actual === "number" ? actual : Number(actual);
        const ok = Number.isFinite(a) && Math.abs(a - expected) <= tol;
        return ctx.check(kind, ok, `${what} = ${expected}`, `got ${JSON.stringify(actual)}`);
      },
      same: (kind, actual, expected, what) =>
        ctx.check(kind, JSON.stringify(actual) === JSON.stringify(expected), `${what} = ${JSON.stringify(expected)}`, `got ${JSON.stringify(actual)}`),
      step: (text) => { res.steps.push(text); },
      finding: (f) => { findings.push({ ...f, scenario: def.id }); },
      cleanup: (undo) => { undos.push(undo); },
      ui: opts.ui,
      self: opts.self,
    };

    console.log(`\n▶ ${def.id} — ${def.title}`);
    const t0 = Date.now();
    try {
      await def.run(ctx);
    } catch (e: any) {
      res.error = String(e?.stack || e).slice(0, 1200);
      console.log(`  ERROR ${String(e?.message || e).slice(0, 300)}`);
    }
    if (opts.ui && (res.error || res.checks.some((c) => !c.ok)) && def.browser) {
      for (const [name, p] of [["desktop", opts.ui.desktop], ["phone", opts.ui.phone]] as const) {
        try { res.screenshots.push(await opts.ui.shot(p.page, `${def.id}-${name}`)); } catch { /* page gone */ }
      }
    }
    for (const undo of undos.reverse()) await undo().catch(() => undefined);
    const left = await sweepTagged(db, ctx.tag).catch(() => [] as string[]);
    if (left.length) res.steps.push(`swept after the scenario: ${left.join(", ")}`);
    res.ms = Date.now() - t0;
    const failed = res.checks.some((c) => !c.ok);
    res.missing = def.requires.filter((k) => !res.checks.some((c) => c.kind === k && c.ok));
    res.status = res.error ? "error" : failed ? "fail" : res.missing.length ? "incomplete" : "pass";
    console.log(`  ⇒ ${res.status.toUpperCase()}${res.missing.length ? ` (no ${res.missing.join(", ")} evidence)` : ""} in ${(res.ms / 1000).toFixed(1)}s`);
    results.push(res);
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outDir, "results.json"), JSON.stringify({ seed: opts.seed, at: new Date().toISOString(), results, findings, timings }, null, 2));
  return { results, findings, timings };
}

// Records a scenario made but did not itself remove — a payment's expense
// outlives the bill it paid, a completed repeating task leaves its next
// occurrence — found by the run's tag and deleted through the app.
const SWEEP: Array<[table: string, column: string, path: string]> = [
  ["expenses", "description", "/expenses"], ["incomes", "description", "/incomes"], ["tasks", "title", "/tasks"],
  ["events", "title", "/events"], ["habits", "name", "/habits"], ["goals", "title", "/goals"],
  ["artifacts", "title", "/artifacts"], ["journal_entries", "content", "/journal"], ["trackers", "name", "/trackers"],
  ["documents", "name", "/documents"], ["profiles", "name", "/profiles"],
];
export async function sweepTagged(db: Db, tag: string): Promise<string[]> {
  const out: string[] = [];
  for (const [table, column, path] of SWEEP) {
    const rows = await db.rows(table, `${column}=ilike.*${encodeURIComponent(tag)}*&deleted_at=is.null`).catch(() => db.rows(table, `${column}=ilike.*${encodeURIComponent(tag)}*`).catch(() => []));
    for (const r of rows) {
      if (table === "profiles" && r.type === "self") continue;
      const d = await smokeApi("DELETE", `${path}/${r.id}`);
      if (d.ok) out.push(`${table} "${String(r[column]).slice(0, 40)}"`);
    }
  }
  return out;
}

/** The rows of a list response, whichever envelope; a shape with no list throws. */
export function listOf(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of ["items", "rows", "budgets", "data", "payments", "entries"]) if (Array.isArray(data?.[k])) return data[k];
  throw new Error(`not a list: ${JSON.stringify(data).slice(0, 200)}`);
}

export function must<T = any>(r: ApiResponse<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
