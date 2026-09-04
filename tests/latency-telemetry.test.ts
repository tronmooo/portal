// tests/latency-telemetry.test.ts — the stage tracer.
//
// Telemetry that can throw is worse than no telemetry, because it converts a
// slow request into a failed one. These tests pin the two properties that
// matter: stages are recorded accurately, and NOTHING in this module can ever
// propagate an error into the request it is measuring.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startTrace,
  setTraceSink,
  CHAT_STAGES,
  MUTATION_STAGES,
  DOCUMENT_STAGES,
  type TraceSummary,
} from "../server/latency";

function capture(): { seen: TraceSummary[] } {
  const seen: TraceSummary[] = [];
  setTraceSink((t) => seen.push(t));
  return { seen };
}

afterEach(() => setTraceSink(null));

describe("stage recording", () => {
  it("records each closed stage once, in completion order", () => {
    const { seen } = capture();
    const t = startTrace("chat");
    t.stage("intent")();
    t.stage("structured_lookup")();
    t.end();
    expect(seen).toHaveLength(1);
    expect(seen[0].stages.map((s) => s.name)).toEqual(["intent", "structured_lookup"]);
  });

  it("measures real elapsed time for an awaited stage", async () => {
    const { seen } = capture();
    const t = startTrace("chat");
    await t.measure("model", () => new Promise((r) => setTimeout(r, 40)));
    t.end();
    const model = seen[0].stages.find((s) => s.name === "model")!;
    expect(model.ms).toBeGreaterThanOrEqual(30);
  });

  it("closes the stage even when the measured work throws, and rethrows", async () => {
    const { seen } = capture();
    const t = startTrace("chat");
    await expect(t.measure("model", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    t.end();
    expect(seen[0].stages.map((s) => s.name)).toEqual(["model"]);
  });

  it("returns the measured value through unchanged", async () => {
    const t = startTrace("query");
    expect(await t.measure("db", async () => ({ rows: 7 }))).toEqual({ rows: 7 });
    expect(t.measureSync("fmt", () => "ok")).toBe("ok");
    t.end();
  });

  it("ignores a double close instead of double-counting", () => {
    const { seen } = capture();
    const t = startTrace("chat");
    const done = t.stage("intent");
    done();
    done();
    t.end();
    expect(seen[0].stages.filter((s) => s.name === "intent")).toHaveLength(1);
  });

  it("reports an unclosed stage rather than dropping it", () => {
    const { seen } = capture();
    const t = startTrace("chat");
    t.stage("model"); // deliberately never closed
    t.end();
    expect(seen[0].stages.some((s) => s.name === "model:unclosed")).toBe(true);
  });
});

describe("attributes and totals", () => {
  it("carries attributes from start, set() and end()", () => {
    const { seen } = capture();
    const t = startTrace("chat", { route: "tier1" });
    t.set("tier", 1);
    t.end({ hit: true });
    expect(seen[0].attrs).toMatchObject({ route: "tier1", tier: 1, hit: true });
  });

  it("reports a non-negative total and a live elapsed()", async () => {
    const t = startTrace("mutation");
    await new Promise((r) => setTimeout(r, 15));
    expect(t.elapsed()).toBeGreaterThanOrEqual(10);
    expect(t.end().totalMs).toBeGreaterThanOrEqual(10);
  });
});

describe("idempotence and isolation", () => {
  it("emits exactly once no matter how often end() is called", () => {
    const { seen } = capture();
    const t = startTrace("chat");
    t.end();
    t.end();
    t.end();
    expect(seen).toHaveLength(1);
  });

  it("still returns a summary from a repeat end() call", () => {
    const t = startTrace("chat");
    const first = t.end();
    const second = t.end();
    expect(second.kind).toBe(first.kind);
  });

  it("keeps concurrent traces separate", () => {
    const { seen } = capture();
    const a = startTrace("chat", { id: "a" });
    const b = startTrace("mutation", { id: "b" });
    a.stage("intent")();
    b.stage("db_commit")();
    a.end();
    b.end();
    const byId = new Map(seen.map((s) => [s.attrs.id, s]));
    expect(byId.get("a")!.stages.map((s) => s.name)).toEqual(["intent"]);
    expect(byId.get("b")!.stages.map((s) => s.name)).toEqual(["db_commit"]);
  });
});

describe("telemetry can never break a request", () => {
  it("survives a throwing sink", () => {
    setTraceSink(() => { throw new Error("sink exploded"); });
    const t = startTrace("chat");
    t.stage("intent")();
    expect(() => t.end()).not.toThrow();
  });

  it("survives unserializable attribute values", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    const t = startTrace("chat");
    t.set("cyclic", cyclic);
    t.set("fn", () => {});
    expect(() => t.end()).not.toThrow();
  });

  it("logs a slow trace at warn and a fast one below warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    startTrace("query").end();                 // fast: under the 500 ms bar
    expect(warn).not.toHaveBeenCalled();

    const slow = startTrace("query");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    slow.end();
    expect(warn).toHaveBeenCalled();

    vi.restoreAllMocks();
    warn.mockRestore();
    log.mockRestore();
  });
});

describe("the stage vocabulary is pinned", () => {
  it("covers every chat stage the audit requires", () => {
    for (const s of ["intent", "entity_resolution", "structured_lookup", "semantic_search", "document_fetch", "context_build", "model", "postprocess"]) {
      expect(CHAT_STAGES).toContain(s as any);
    }
  });

  it("names mutation and document stages", () => {
    expect(MUTATION_STAGES).toContain("db_commit" as any);
    expect(DOCUMENT_STAGES).toContain("metadata_fetch" as any);
  });

  it("has no duplicate stage names", () => {
    for (const list of [CHAT_STAGES, MUTATION_STAGES, DOCUMENT_STAGES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
