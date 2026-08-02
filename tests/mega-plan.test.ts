// Pins the pure pieces of the mega-plan path: whitelist parsing, dependency
// ref validation, cross-section dedupe (the same recurring payment phrased as
// both a bill and a liability collapses to ONE record), ref remapping onto
// dedupe survivors, and Kahn toposort with cycle breaking.
import { describe, it, expect } from "vitest";
import {
  MEGA_ACTION_TOOLS,
  MAX_MEGA_OPERATIONS,
  EXTRACT_PLAN_TOOL,
  parseExtractedPlan,
  normalizeMegaPlan,
  megaOpIdentity,
  sectionForOp,
  buildMegaExtractionPrompt,
  type MegaPlanOp,
} from "../server/ai-mega-plan";

function parseOps(operations: any[]): MegaPlanOp[] {
  return parseExtractedPlan({ operations }).ops;
}

describe("parseExtractedPlan", () => {
  it("keeps whitelisted well-formed operations in order with sections and refs", () => {
    const { ops, warnings } = parseExtractedPlan({
      operations: [
        { tool: "create_profile", input: { name: "Honda CR-V", type: "asset" }, raw: "create a Honda CR-V asset", section: "assets" },
        { tool: "create_liability", input: { name: "Auto Loan", amount: 412 }, raw: "auto loan", section: "liabilities" },
        { tool: "link_liability_asset", input: {}, raw: "link the loan to the car", section: "liabilities", refs: { liabilityName: "#op2", assetName: "#op1" } },
      ],
    });
    expect(warnings).toEqual([]);
    expect(ops.length).toBe(3);
    expect(ops[0].originalIndex).toBe(1);
    expect(ops[0].section).toBe("assets");
    expect(ops[2].refs).toEqual({ liabilityName: 2, assetName: 1 });
  });

  it("drops non-whitelisted tools (no deletes through the mega path)", () => {
    const { ops, warnings } = parseExtractedPlan({
      operations: [
        { tool: "delete_task", input: { title: "x" }, raw: "delete it" },
        { tool: "merge_profiles", input: {}, raw: "merge" },
        { tool: "create_task", input: { title: "Call dentist" }, raw: "call the dentist" },
      ],
    });
    expect(ops.length).toBe(1);
    expect(ops[0].tool).toBe("create_task");
    expect(warnings.length).toBe(2);
  });

  it("validates refs: self-refs and out-of-range refs are dropped with a warning", () => {
    const { ops, warnings } = parseExtractedPlan({
      operations: [
        { tool: "create_profile", input: { name: "Car" }, raw: "car", refs: { assetName: "#op1" } }, // self
        { tool: "create_liability", input: { name: "Loan" }, raw: "loan", refs: { assetName: "#op99" } }, // out of range
      ],
    });
    expect(ops[0].refs).toEqual({});
    expect(ops[1].refs).toEqual({});
    expect(warnings.length).toBe(2);
  });

  it("accepts ref spellings #op3, op3, and bare numbers", () => {
    const ops = parseOps([
      { tool: "create_profile", input: { name: "Car" }, raw: "car" },
      { tool: "create_profile", input: { name: "Boat" }, raw: "boat" },
      { tool: "create_profile", input: { name: "House" }, raw: "house" },
      { tool: "link_entities", input: {}, raw: "link", refs: { a: "#op1", b: "op2", c: 3 } },
    ]);
    expect(ops[3].refs).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("caps at MAX_MEGA_OPERATIONS", () => {
    const operations = Array.from({ length: MAX_MEGA_OPERATIONS + 20 }, (_, i) => ({
      tool: "create_task",
      input: { title: `Task ${i}` },
      raw: `task ${i}`,
    }));
    const { ops, warnings } = parseExtractedPlan({ operations });
    expect(ops.length).toBe(MAX_MEGA_OPERATIONS);
    expect(warnings.some((w) => w.includes("capped"))).toBe(true);
  });

  it("tolerates garbage input", () => {
    expect(parseExtractedPlan(null).ops).toEqual([]);
    expect(parseExtractedPlan({}).ops).toEqual([]);
    expect(parseExtractedPlan({ operations: "nope" }).ops).toEqual([]);
  });
});

describe("megaOpIdentity — cross-section identity", () => {
  it("the same recurring payment phrased as bill and liability collide", () => {
    const bill = parseOps([{ tool: "create_obligation", input: { name: "Internet bill", amount: 74.99, frequency: "monthly", dueDay: 20 }, raw: "internet bill" }])[0];
    const liability = parseOps([{ tool: "create_liability", input: { name: "Internet", amount: 74.99, frequency: "Monthly", dueDay: 20 }, raw: "internet liability" }])[0];
    expect(megaOpIdentity(bill)).toBe(megaOpIdentity(liability));
  });

  it("two different bills with the same amount do NOT collide (name slug differs)", () => {
    const a = parseOps([{ tool: "create_liability", input: { name: "Internet", amount: 74.99, frequency: "monthly", dueDay: 20 }, raw: "a" }])[0];
    const b = parseOps([{ tool: "create_liability", input: { name: "Hulu", amount: 74.99, frequency: "monthly", dueDay: 20 }, raw: "b" }])[0];
    expect(megaOpIdentity(a)).not.toBe(megaOpIdentity(b));
  });

  it("same-name bills with different amounts do NOT collide", () => {
    const a = parseOps([{ tool: "create_liability", input: { name: "Phone", amount: 86.5, frequency: "monthly" }, raw: "a" }])[0];
    const b = parseOps([{ tool: "create_liability", input: { name: "Phone", amount: 42, frequency: "monthly" }, raw: "b" }])[0];
    expect(megaOpIdentity(a)).not.toBe(megaOpIdentity(b));
  });

  it("one-time (non-recurring) expenses never collide with bills", () => {
    const expense = parseOps([{ tool: "create_expense", input: { description: "Internet", amount: 74.99 }, raw: "paid internet" }])[0];
    expect(megaOpIdentity(expense)).toBeNull();
  });

  it("tracker entries only collide on identical tracker + values + time", () => {
    const a = parseOps([{ tool: "log_tracker_entry", input: { trackerName: "Hydration", values: { ounces: 84 } }, raw: "a" }])[0];
    const b = parseOps([{ tool: "log_tracker_entry", input: { trackerName: "Hydration", values: { ounces: 84 } }, raw: "b" }])[0];
    const c = parseOps([{ tool: "log_tracker_entry", input: { trackerName: "Hydration", values: { ounces: 12 } }, raw: "c" }])[0];
    expect(megaOpIdentity(a)).toBe(megaOpIdentity(b));
    expect(megaOpIdentity(a)).not.toBe(megaOpIdentity(c));
  });
});

describe("normalizeMegaPlan — dedupe + ordering", () => {
  it("merges bill+liability twins, prefers create_liability, unions inputs, and pre-seeds a deduped outcome", () => {
    const parsed = parseOps([
      { tool: "create_obligation", input: { name: "Internet bill", amount: 74.99, frequency: "monthly", dueDay: 20, category: "utilities" }, raw: "internet bill", section: "bills" },
      { tool: "create_liability", input: { name: "Internet", amount: 74.99, frequency: "monthly", dueDay: 20 }, raw: "internet liability", section: "liabilities" },
    ]);
    const { ops, preseededOutcomes, aliasMap } = normalizeMegaPlan(parsed);
    expect(ops.length).toBe(1);
    expect(ops[0].tool).toBe("create_liability");
    // Union: the survivor picked up the dropped op's category.
    expect(ops[0].input.category).toBe("utilities");
    expect(preseededOutcomes.length).toBe(1);
    expect(preseededOutcomes[0].status).toBe("deduped");
    expect(preseededOutcomes[0].tool).toBe("create_obligation");
    expect(aliasMap[1]).toBe(2);
  });

  it("remaps refs that pointed at a deduped op onto its survivor", () => {
    const parsed = parseOps([
      { tool: "create_obligation", input: { name: "Internet bill", amount: 74.99, frequency: "monthly", dueDay: 20 }, raw: "bill" },
      { tool: "create_liability", input: { name: "Internet", amount: 74.99, frequency: "monthly", dueDay: 20 }, raw: "liability" },
      { tool: "link_liability_owner" as any, input: {}, raw: "x" }, // dropped by whitelist — placeholder
      { tool: "link_entities", input: {}, raw: "link it", refs: { liabilityName: "#op1" } },
    ]);
    const { ops } = normalizeMegaPlan(parsed);
    const link = ops.find((o) => o.tool === "link_entities")!;
    expect(link.refs.liabilityName).toBe(2); // #op1 (obligation) → survivor #op2 (liability)
  });

  it("orders dependencies before dependents even when the plan lists them backwards", () => {
    const parsed = parseOps([
      { tool: "link_liability_asset", input: {}, raw: "link loan to car", refs: { assetName: "#op3", liabilityName: "#op2" } },
      { tool: "create_liability", input: { name: "Auto Loan", amount: 412 }, raw: "loan" },
      { tool: "create_profile", input: { name: "Honda CR-V", type: "asset" }, raw: "car" },
    ]);
    const { ops } = normalizeMegaPlan(parsed);
    const order = ops.map((o) => o.originalIndex);
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(1));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
  });

  it("keeps message order for independent ops", () => {
    const parsed = parseOps([
      { tool: "create_task", input: { title: "A" }, raw: "a" },
      { tool: "create_task", input: { title: "B" }, raw: "b" },
      { tool: "create_task", input: { title: "C" }, raw: "c" },
    ]);
    const { ops } = normalizeMegaPlan(parsed);
    expect(ops.map((o) => o.input.title)).toEqual(["A", "B", "C"]);
  });

  it("breaks dependency cycles with a warning instead of dropping ops", () => {
    const parsed = parseOps([
      { tool: "link_entities", input: { a: 1 }, raw: "one", dependsOn: [2] },
      { tool: "link_entities", input: { a: 2 }, raw: "two", dependsOn: [1] },
    ]);
    const { ops, warnings } = normalizeMegaPlan(parsed);
    expect(ops.length).toBe(2);
    expect(warnings.some((w) => w.includes("circular"))).toBe(true);
  });
});

describe("sectionForOp", () => {
  it("honors the extractor's section tag and falls back by tool", () => {
    expect(sectionForOp("create_task", "attention")).toBe("attention");
    expect(sectionForOp("create_task", null)).toBe("tasks");
    expect(sectionForOp("create_liability", undefined)).toBe("bills");
    expect(sectionForOp("log_tracker_entry", "wellness")).toBe("wellness");
    expect(sectionForOp("unknown_tool", "bogus")).toBe("dashboard");
  });
});

describe("extraction contract", () => {
  it("EXTRACT_PLAN_TOOL enumerates exactly the whitelist", () => {
    const schema: any = EXTRACT_PLAN_TOOL.input_schema;
    expect(schema.properties.operations.items.properties.tool.enum).toEqual([...MEGA_ACTION_TOOLS]);
  });

  it("prompt teaches the section doctrine (attention derivation, bills-as-liabilities, transfers, refs)", () => {
    const prompt = buildMegaExtractionPrompt({
      nowISO: "Sunday, August 2, 2026 at 9:00 AM",
      timezone: "America/New_York",
      trackerNames: ["Hydration", "Weight"],
      profileNames: ["Me"],
      habitNames: ["Meditate"],
    });
    expect(prompt).toContain("NO attention table");
    expect(prompt).toContain("create_liability (bills are liability records");
    expect(prompt).toContain('category "transfer"');
    expect(prompt).toContain("#opN");
    expect(prompt).toContain("Hydration");
  });
});
