// A PATCH changes what was sent and nothing else.
//
// 2026-11-23, upgrading zod 3 → 4: `schema.partial().safeParse(body)` began
// filling in every field that has a `.default()` — so renaming a document
// would also have written `extractedData: {}`, `tags: []`,
// `linkedProfiles: []` over the stored values, on all twelve PATCH routes.
// Two route tests caught it for two routes; this pins the rule for every one.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  parsePatch,
  insertProfileSchema, insertTrackerSchema, insertTaskSchema, insertExpenseSchema, insertEventSchema, insertDocumentSchema,
  insertHabitSchema, insertObligationSchema, insertArtifactSchema, insertJournalEntrySchema, insertGoalSchema, insertIncomeSchema,
} from "../shared/schema";

const SCHEMAS = {
  insertProfileSchema, insertTrackerSchema, insertTaskSchema, insertExpenseSchema, insertEventSchema, insertDocumentSchema,
  insertHabitSchema, insertObligationSchema, insertArtifactSchema, insertJournalEntrySchema, insertGoalSchema, insertIncomeSchema,
} as const;

describe("parsePatch keeps only the fields the request sent", () => {
  it.each(Object.entries(SCHEMAS))("%s: an empty PATCH carries nothing", (_name, schema) => {
    const r = parsePatch(schema as any, {});
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({});
  });

  it("the failure this guards against is real: a bare partial() parse invents fields", () => {
    const invented = Object.entries(SCHEMAS).filter(([, schema]) => {
      const r = (schema as any).partial().safeParse({});
      return r.success && Object.keys(r.data).length > 0;
    }).map(([name]) => name);
    // If this ever becomes empty the helper is no longer needed — but the rule stays.
    expect(invented).toContain("insertDocumentSchema");
    expect(invented.length).toBeGreaterThan(5);
  });

  it("a rename carries the name alone — not empty tags, fields or owners", () => {
    const r = parsePatch(insertDocumentSchema, { name: "Renamed" });
    expect(r.success && r.data).toEqual({ name: "Renamed" });
    const p = parsePatch(insertProfileSchema, { name: "Renamed" });
    expect(p.success && Object.keys(p.data)).toEqual(["name"]);
  });

  it("a field that WAS sent is kept, validated and coerced — including an explicit empty value", () => {
    const r = parsePatch(insertDocumentSchema, { extractedData: {}, tags: [] });
    expect(r.success && r.data).toEqual({ extractedData: {}, tags: [] });
  });

  it("an invalid value is still refused", () => {
    const r = parsePatch(insertExpenseSchema, { amount: "a lot" });
    expect(r.success).toBe(false);
  });

  it("a body that is not an object carries nothing", () => {
    for (const body of [[], null, undefined]) {
      const r = parsePatch(insertTaskSchema, body);
      if (r.success) expect(r.data).toEqual({});
    }
  });
});

describe("no route parses a PATCH body with a bare partial()", () => {
  const files = readdirSync("server").filter((f) => f.endsWith(".ts")).map((f) => `server/${f}`);
  it.each(files)("%s", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/\.partial\(\)\s*\.(safeParse|parse)\(/);
  });
  it("the twelve PATCH routes use parsePatch", () => {
    const n = (readFileSync("server/routes.ts", "utf8").match(/parsePatch\(insert\w+Schema, req\.body\)/g) || []).length;
    expect(n).toBe(12);
  });
});
