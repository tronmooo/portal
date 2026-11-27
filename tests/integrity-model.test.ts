// The integrity model stays complete and honest (owner, 2026-11-27: "a
// dependency map and coverage matrix that identifies every feature,
// relationship, calculation, and workflow"). docs/INTEGRITY_MAP.md is generated
// from tests/integrity/model.ts and the code; this suite fails when a door
// into the app fits no data type, when the model names a module that is gone,
// or when a scenario could pass on the strength of a success answer alone.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS } from "../server/ai-engine";
import { extractApiRoutes } from "../scripts/workflow-inventory";
import { MODEL, OPERATIONS, CROSS_CUTTING, entityOfRoute, entityOfTool, operationOfRoute, operationOfTool, parseCoverKey } from "./integrity/model";
import { allScenarios } from "./integrity/framework";
import { buildMatrix, stateOf } from "../scripts/gen-integrity-map";
import "./integrity/scenarios/index";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const toolNames: string[] = TOOL_DEFINITIONS.map((t: any) => t.name);

describe("every door belongs to a data type", () => {
  const routes = extractApiRoutes();

  it("every API route is assigned (a new resource must be placed in tests/integrity/model.ts)", () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.filter((r) => !entityOfRoute(r.path)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it("every chat tool is assigned", () => {
    expect(toolNames.length).toBeGreaterThan(140);
    expect(toolNames.filter((n) => !entityOfTool(n))).toEqual([]);
  });

  it("the specific data type wins over the general one", () => {
    expect(entityOfRoute("/api/liabilities/:id/payments")?.key).toBe("liabilityPayment");
    expect(entityOfRoute("/api/liabilities/:id/occurrences/:date/pay")?.key).toBe("bill");
    expect(entityOfRoute("/api/liabilities/:id/parties")?.key).toBe("liability");
    expect(entityOfRoute("/api/trackers/:id/entries")?.key).toBe("trackerEntry");
    expect(entityOfRoute("/api/trackers/:id")?.key).toBe("tracker");
    expect(entityOfRoute("/api/profiles/:id/owners")?.key).toBe("asset");
    expect(entityOfRoute("/api/profiles/:id")?.key).toBe("profile");
    expect(entityOfTool("add_liability_payment")?.key).toBe("liabilityPayment");
    expect(entityOfTool("log_tracker_entry")?.key).toBe("trackerEntry");
    expect(entityOfTool("create_note")?.key).toBe("note");
  });

  it("operations are read from the method and the path", () => {
    expect(operationOfRoute("POST", "/api/expenses")).toBe("create");
    expect(operationOfRoute("PATCH", "/api/expenses/:id")).toBe("edit");
    expect(operationOfRoute("DELETE", "/api/expenses/:id")).toBe("delete");
    expect(operationOfRoute("POST", "/api/expenses/:id/restore")).toBe("restore");
    expect(operationOfRoute("POST", "/api/artifacts/:id/duplicate")).toBe("duplicate");
    expect(operationOfRoute("POST", "/api/tasks/:id/occurrence")).toBe("reschedule");
    expect(operationOfRoute("PUT", "/api/profiles/:id/owners")).toBe("transfer");
    expect(operationOfRoute("POST", "/api/liabilities/:id/occurrences/:date/skip")).toBe("cancel");
    expect(operationOfRoute("DELETE", "/api/obligations/:id/last-payment")).toBe("cancel");
    expect(operationOfRoute("POST", "/api/habits/:id/checkin")).toBe("complete");
    expect(operationOfRoute("POST", "/api/documents/:id/purge")).toBe("archive");
    expect(operationOfRoute("POST", "/api/workspace/journal/reflect")).toBe("read"); // proposes, stores nothing
    expect(operationOfTool("query_tasks")).toBeNull();
    expect(operationOfTool("undo_last_payment")).toBe("cancel");
    expect(operationOfTool("restore_task")).toBe("restore");
  });
});

describe("the dependency map names things that exist", () => {
  it("every module a derived figure cites is a file in the repository", () => {
    const missing: string[] = [];
    for (const e of MODEL) for (const d of e.derived) {
      for (const m of d.source.matchAll(/(?:shared|server|client)\/[\w./-]+\.(?:tsx|ts)/g)) {
        if (!fs.existsSync(path.join(ROOT, m[0]))) missing.push(`${e.key}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every data type a user works with says where it is stored, what it feeds or takes with it, and where it shows", () => {
    for (const e of MODEL.filter((m) => !m.system)) {
      expect(e.stores.length, `${e.key} stores`).toBeGreaterThan(0);
      expect(e.derived.length + e.dependents.length, `${e.key} consequences`).toBeGreaterThan(0);
      expect(e.screens.length, `${e.key} screens`).toBeGreaterThan(0);
    }
    expect(new Set(MODEL.map((m) => m.key)).size).toBe(MODEL.length);
  });
});

describe("a scenario cannot pass on a success answer alone", () => {
  const scenarios = allScenarios();

  it("every scenario owes evidence beyond the action itself", () => {
    expect(scenarios.length).toBeGreaterThan(30);
    for (const s of scenarios) {
      const beyond = s.requires.filter((k) => k !== "action");
      expect(beyond.length, `${s.id} must owe database, derived or screen evidence`).toBeGreaterThan(0);
    }
  });

  it("every `covers` key is a data type × operation × door of the model, or a named cross-cutting property", () => {
    const bad = scenarios.flatMap((s) => s.covers.filter((c) => parseCoverKey(c) === null).map((c) => `${s.id}: ${c}`));
    expect(bad).toEqual([]);
    for (const s of scenarios) expect(s.covers.length, `${s.id} covers something`).toBeGreaterThan(0);
  });

  it("a scenario short of a kind of evidence is INCOMPLETE, and one failed check is FAIL (the framework's rule)", () => {
    const src = read("tests/integrity/framework.ts");
    expect(src).toMatch(/res\.missing = def\.requires\.filter\(\(k\) => !res\.checks\.some\(\(c\) => c\.kind === k && c\.ok\)\)/);
    expect(src).toMatch(/res\.status = res\.error \? "error" : failed \? "fail" : res\.missing\.length \? "incomplete" : "pass"/);
  });

  it("the oracle imports nothing from the app", () => {
    const src = read("tests/integrity/oracle.ts");
    expect(src.match(/^\s*import\s.+from\s+["'][^"']+["']/gm) ?? []).toEqual([]);
    expect(src).not.toMatch(/require\(/);
  });

  it("the run writes as the smoke account only, under its gate lock, through the rate-limit-aware fetch", () => {
    const run = read("tests/integrity/run.ts");
    expect(run).toMatch(/acquireGateLock\(preferenceLockIo\(/);
    const files = ["tests/integrity/framework.ts", "tests/integrity/run.ts", ...fs.readdirSync(path.join(ROOT, "tests/integrity/scenarios")).map((f) => `tests/integrity/scenarios/${f}`)];
    // One file may call fetch() directly: the account scenarios, which sign up
    // and act as OTHER, throwaway accounts and must see a 429 unhandled (the
    // sign-in limiter is one of the things they test). That is safe only
    // because they can never reach a deployed app — held below.
    const ISOLATED_ONLY_FILE = "tests/integrity/scenarios/accounts.ts";
    for (const f of files) {
      if (f === ISOLATED_ONLY_FILE) continue;
      const bare = read(f).split("\n").filter((l) => /(^|[^\w.])fetch\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      expect(bare, `${f} makes no bare fetch() call`).toEqual([]);
    }
    const accounts = read(ISOLATED_ONLY_FILE);
    const defs = accounts.split(/\nscenario\(\{/).slice(1);
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) expect(d.slice(0, 700), `every scenario in ${ISOLATED_ONLY_FILE} is isolatedOnly`).toMatch(/isolatedOnly: true/);
    // …and the framework runs an isolatedOnly scenario only when the app AND
    // the database under test are both on this machine.
    const fw = read("tests/integrity/framework.ts");
    expect(fw).toMatch(/IS_ISOLATED = process\.env\.INTEGRITY_ISOLATED === "1" && LOCAL\.test\(API_BASE\) && LOCAL\.test\(SB_URL\)/);
    expect(fw).toMatch(/if \(def\.isolatedOnly && !IS_ISOLATED\) \{ results\.push\(/);
    // the one deliberate exception: a request that has to be cut off mid-flight
    expect(read("tests/integrity/scenarios/hardening.ts").match(/globalThis\.fetch\(/g)?.length).toBe(1);
    // the other account is only ever asked for THIS account's rows
    expect(read("tests/integrity/framework.ts")).toMatch(/the other account is the smoke account/);
  });
});

describe("the coverage matrix", () => {
  const { rows, crossCutting } = buildMatrix();

  it("has a row for every operation a data type's doors offer, in the operations' vocabulary", () => {
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) expect(OPERATIONS).toContain(r.op);
  });

  it("the money and schedule operations the owner named each have a database-verifying scenario, not only a test that names them", () => {
    const verified = (entity: string, op: string, door: "ui" | "api" | "chat") => {
      // "has a scenario": whether it PASSED is the run's business (and the map's V / S), not this guard's
      const r = rows.find((x) => x.entity === entity && x.op === op);
      return !!r && ["verified", "pending"].includes(stateOf(r[door]));
    };
    const must: Array<[string, string, "ui" | "api" | "chat"]> = [
      ["expense", "create", "api"], ["expense", "edit", "api"], ["expense", "delete", "api"], ["expense", "restore", "api"], ["expense", "create", "ui"], ["expense", "create", "chat"],
      ["task", "create", "api"], ["task", "reschedule", "api"], ["task", "restore", "api"], ["task", "create", "ui"], ["task", "create", "chat"],
      ["event", "create", "api"], ["event", "reschedule", "api"], ["event", "delete", "api"],
      ["bill", "complete", "api"], ["bill", "cancel", "api"], ["liabilityPayment", "create", "api"], ["liabilityPayment", "delete", "api"],
      ["liability", "create", "api"], ["liability", "transfer", "api"], ["asset", "create", "api"], ["asset", "edit", "api"], ["asset", "transfer", "api"],
      ["account", "create", "api"], ["budget", "create", "api"], ["habit", "complete", "api"], ["habit", "restore", "api"],
      ["tracker", "create", "api"], ["trackerEntry", "edit", "api"], ["goal", "restore", "api"], ["journal", "create", "api"], ["note", "restore", "api"],
      ["artifact", "duplicate", "api"], ["document", "restore", "api"], ["document", "archive", "api"], ["detail", "create", "api"], ["profile", "delete", "api"],
    ];
    expect(must.filter(([e, o, d]) => !verified(e, o, d)).map((m) => m.join("."))).toEqual([]);
  });

  it("every cross-cutting property has a scenario", () => {
    expect(Object.keys(CROSS_CUTTING).filter((k) => !(crossCutting[k] || []).length)).toEqual([]);
  });

  it("docs/INTEGRITY_MAP.md exists and lists every data type", () => {
    const doc = read("docs/INTEGRITY_MAP.md");
    for (const e of MODEL.filter((m) => !m.system)) expect(doc, e.key).toContain(`\`${e.key}\``);
  });
});
