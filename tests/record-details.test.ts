// The pure half of the detail layer (shared/record-details): value types,
// definitions, rules and the per-record view. Every screen, the REST routes
// and the chat tools read through these, so a rule here is a rule everywhere.
import { describe, it, expect } from "vitest";
import {
  applyDetailChange, buildDefinition, buildRecordDetailsView, definitionAppliesTo, emptyRecordDetails,
  evaluateDetailRules, formatDetailValue, matchesDetail, normalizeDetailValue, parseDefinitions,
  parseRecordDetails, parseRecordDetailsKey, recordDetailsKey, recordScopeTokens, slugifyDetailId,
  suggestedTemplates, valueDistribution, defaultScopeFor, parseQuickDetail, HISTORY_LIMIT,
  type DetailDefinition,
} from "../shared/record-details";

const NOW = "2026-11-21T10:00:00.000Z";
const TODAY = "2026-11-21";

function def(input: Record<string, unknown>, id = "d"): DetailDefinition {
  const r = buildDefinition(input as any, { id, now: NOW });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("value types", () => {
  it("a condition is one of an ordered scale, matched without case", () => {
    const condition = def({ label: "Condition", kind: "condition", appliesTo: ["vehicle"] });
    expect(condition.options).toEqual(["Excellent", "Good", "Fair", "Poor"]);
    expect(normalizeDetailValue(condition, "good")).toEqual({ ok: true, value: "Good" });
    const bad = normalizeDetailValue(condition, "shiny");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Excellent, Good, Fair, Poor/);
  });

  it("numbers, money and percents parse what people type", () => {
    expect(normalizeDetailValue(def({ label: "Mileage", kind: "number", unit: "mi" }), "84,200")).toEqual({ ok: true, value: 84200 });
    expect(normalizeDetailValue(def({ label: "Value", kind: "currency" }), "$12.5k")).toEqual({ ok: true, value: 12500 });
    expect(normalizeDetailValue(def({ label: "Rate", kind: "percent" }), "6.25%")).toEqual({ ok: true, value: 6.25 });
    expect(normalizeDetailValue(def({ label: "Mileage", kind: "number" }), "lots").ok).toBe(false);
  });

  it("enforces min / max on write", () => {
    const year = def({ label: "Year built", kind: "number", min: 1800, max: 2100 });
    const r = normalizeDetailValue(year, 1700);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least 1800/);
  });

  it("a rating is a whole number on its own scale", () => {
    const rating = def({ label: "Worth it?", kind: "rating", scaleMax: 5 });
    expect(normalizeDetailValue(rating, "4")).toEqual({ ok: true, value: 4 });
    expect(normalizeDetailValue(rating, "4/5")).toEqual({ ok: true, value: 4 });
    expect(normalizeDetailValue(rating, "★★★☆☆")).toEqual({ ok: true, value: 3 });
    expect(normalizeDetailValue(rating, 6).ok).toBe(false);
    expect(formatDetailValue(rating, 4)).toBe("4 / 5");
  });

  it("dates are calendar days and reject impossible ones", () => {
    const d = def({ label: "Renewal", kind: "date" });
    expect(normalizeDetailValue(d, "2026-3-5")).toEqual({ ok: true, value: "2026-03-05" });
    expect(normalizeDetailValue(d, "03/05/2026")).toEqual({ ok: true, value: "2026-03-05" });
    expect(normalizeDetailValue(d, "2026-02-30").ok).toBe(false);
    expect(formatDetailValue(d, "2026-03-05")).toBe("Mar 5, 2026");
  });

  it("yes/no, links and multiple choice", () => {
    expect(normalizeDetailValue(def({ label: "Signed", kind: "boolean" }), "yes")).toEqual({ ok: true, value: true });
    expect(normalizeDetailValue(def({ label: "Site", kind: "url" }), "example.com/a")).toEqual({ ok: true, value: "https://example.com/a" });
    expect(normalizeDetailValue(def({ label: "Site", kind: "url" }), "javascript:alert(1)").ok).toBe(false);
    const tags = def({ label: "Uses", kind: "multiselect", options: ["Commute", "Road trips", "Towing"] });
    // Stored in the definition's order, de-duplicated.
    expect(normalizeDetailValue(tags, "towing, commute, Towing")).toEqual({ ok: true, value: ["Commute", "Towing"] });
    expect(normalizeDetailValue(tags, "flying").ok).toBe(false);
  });
});

describe("definitions", () => {
  it("a dropdown needs options; a blank name is refused", () => {
    expect(buildDefinition({ label: "Fuel", kind: "select" }, { id: "x", now: NOW }).ok).toBe(false);
    expect(buildDefinition({ label: "  ", kind: "text" }, { id: "x", now: NOW }).ok).toBe(false);
    expect(buildDefinition({ label: "X", kind: "spreadsheet" }, { id: "x", now: NOW }).ok).toBe(false);
  });

  it("rules are checked against the value type", () => {
    const ok = buildDefinition({ label: "Condition", kind: "condition", rules: [{ op: "at_or_worse", value: "fair", severity: "warning" }] }, { id: "c", now: NOW });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.rules?.[0]).toMatchObject({ op: "at_or_worse", value: "Fair" });
    const wrongOp = buildDefinition({ label: "Condition", kind: "condition", rules: [{ op: "within_days", value: 3 }] }, { id: "c", now: NOW });
    expect(wrongOp.ok).toBe(false);
    const wrongOperand = buildDefinition({ label: "Condition", kind: "condition", rules: [{ op: "is", value: "Sparkly" }] }, { id: "c", now: NOW });
    expect(wrongOperand.ok).toBe(false);
  });

  it("ids are slugs, unique within the catalog", () => {
    expect(slugifyDetailId("Roof age")).toBe("roof-age");
    expect(slugifyDetailId("Roof age", new Set(["roof-age"]))).toBe("roof-age-2");
  });

  it("parsing stored JSON drops malformed entries instead of throwing", () => {
    expect(parseDefinitions("not json")).toEqual([]);
    const parsed = parseDefinitions(JSON.stringify([{ id: "a", label: "A", kind: "text", appliesTo: ["*"] }, { id: "b", kind: "nope" }, null]));
    expect(parsed.map((d) => d.id)).toEqual(["a"]);
    expect(parseRecordDetails("{")).toEqual(emptyRecordDetails());
  });

  it("record keys round-trip and reject other prefixes", () => {
    expect(parseRecordDetailsKey(recordDetailsKey("profile", "p-1"))).toEqual({ entityType: "profile", entityId: "p-1" });
    expect(parseRecordDetailsKey("details:spaceship:1")).toBeNull();
    expect(parseRecordDetailsKey("valuation:p-1")).toBeNull();
  });
});

describe("scope", () => {
  it("a car answers to vehicle, asset and profile", () => {
    const tokens = recordScopeTokens("profile", { type: "vehicle", type_key: "car" });
    expect(tokens).toEqual(expect.arrayContaining(["profile", "vehicle", "asset", "car"]));
    expect(definitionAppliesTo({ appliesTo: ["asset"] }, tokens)).toBe(true);
    expect(definitionAppliesTo({ appliesTo: ["person"] }, tokens)).toBe(false);
    expect(definitionAppliesTo({ appliesTo: ["*"] }, tokens)).toBe(true);
  });

  it("a definition born on a record defaults to that record's type", () => {
    expect(defaultScopeFor("profile", { type: "vehicle" })).toBe("vehicle");
    expect(defaultScopeFor("profile", { type: "self" })).toBe("person");
    expect(defaultScopeFor("document", { type: "contract" })).toBe("contract");
    expect(defaultScopeFor("document", { type: "other" })).toBe("document");
    expect(defaultScopeFor("task", {})).toBe("task");
  });

  it("suggestions are a fixed library for the record, skipping names already defined", () => {
    const tokens = recordScopeTokens("profile", { type: "vehicle" });
    const first = suggestedTemplates(tokens, []);
    expect(first[0]).toMatchObject({ label: "Condition", kind: "condition", scope: "vehicle" });
    // Deterministic: the same record gets the same suggestions every time.
    expect(suggestedTemplates(tokens, [])).toEqual(first);
    const existing = [def({ label: "Condition", kind: "condition" })];
    expect(suggestedTemplates(tokens, existing).some((t) => t.label === "Condition")).toBe(false);
  });
});

describe("rules and flags (derived, never stored)", () => {
  const condition = def({
    label: "Condition", kind: "condition", appliesTo: ["vehicle"], required: true,
    rules: [{ id: "worn", op: "at_or_worse", value: "Fair", severity: "warning" }, { id: "bad", op: "is", value: "Poor", severity: "critical", message: "Needs repair" }],
  }, "condition");

  it("condition comparisons follow the scale's order", () => {
    expect(matchesDetail(condition, "Poor", "worse_than", "Fair", TODAY)).toBe(true);
    expect(matchesDetail(condition, "Good", "at_or_worse", "Fair", TODAY)).toBe(false);
    expect(matchesDetail(condition, "Fair", "at_or_worse", "Fair", TODAY)).toBe(true);
    expect(matchesDetail(condition, "Excellent", "better_than", "Good", TODAY)).toBe(true);
  });

  it("a value raises its flags worst-first and changing the value clears them", () => {
    const poor = evaluateDetailRules(condition, "Poor", TODAY);
    expect(poor.map((f) => f.severity)).toEqual(["critical", "warning"]);
    expect(poor[0].message).toBe("Needs repair");
    expect(poor[1].message).toBe("Condition is at or worse than Fair");
    expect(evaluateDetailRules(condition, "Good", TODAY)).toEqual([]);
  });

  it("required flags a missing value only where the characteristic applies", () => {
    expect(evaluateDetailRules(condition, null, TODAY, true).map((f) => f.ruleId)).toEqual(["required"]);
    expect(evaluateDetailRules(condition, null, TODAY, false)).toEqual([]);
  });

  it("date rules count calendar days from today", () => {
    const renewal = def({ label: "Renewal", kind: "date", rules: [
      { id: "soon", op: "within_days", value: 30, severity: "warning" },
      { id: "late", op: "past", severity: "critical" },
    ] });
    expect(evaluateDetailRules(renewal, "2026-12-10", TODAY).map((f) => f.ruleId)).toEqual(["soon"]);
    expect(evaluateDetailRules(renewal, "2026-11-20", TODAY).map((f) => f.ruleId)).toEqual(["late"]);
    expect(evaluateDetailRules(renewal, "2027-06-01", TODAY)).toEqual([]);
  });
});

describe("values on a record", () => {
  it("keeps a bounded history of what it used to be", () => {
    let rec = emptyRecordDetails();
    rec = applyDetailChange(rec, "condition", "Excellent", "2025-01-01T00:00:00Z");
    rec = applyDetailChange(rec, "condition", "Good", "2026-01-01T00:00:00Z");
    expect(rec.values.condition.value).toBe("Good");
    expect(rec.values.condition.history).toEqual([{ value: "Excellent", at: "2025-01-01T00:00:00Z" }]);
    // Setting the same value again is not a change.
    expect(applyDetailChange(rec, "condition", "Good", NOW)).toBe(rec);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) rec = applyDetailChange(rec, "condition", i % 2 ? "Fair" : "Poor", NOW);
    expect(rec.values.condition.history!.length).toBe(HISTORY_LIMIT);
    rec = applyDetailChange(rec, "condition", null, NOW);
    expect(rec.values.condition).toBeUndefined();
  });

  it("the view shows set values, required gaps, and offers the rest", () => {
    const condition = def({ label: "Condition", kind: "condition", appliesTo: ["vehicle"] }, "condition");
    const color = def({ label: "Color", kind: "text", appliesTo: ["vehicle"] }, "color");
    const vin = def({ label: "VIN", kind: "text", appliesTo: ["vehicle"], required: true }, "vin");
    const breed = def({ label: "Breed", kind: "text", appliesTo: ["pet"] }, "breed");
    const details = applyDetailChange(emptyRecordDetails(), "condition", "Good", NOW);
    const view = buildRecordDetailsView({
      entityType: "profile", entityId: "car", record: { type: "vehicle" },
      definitions: [condition, color, vin, breed], details, todayISO: TODAY,
    });
    expect(view.rows.map((r) => [r.definition.id, r.display])).toEqual([["condition", "Good"], ["vin", "—"]]);
    expect(view.available.map((d) => d.id)).toEqual(["color"]);
    expect(view.flags.map((f) => f.message)).toEqual(["VIN is missing"]);
  });

  it("a value that fell out of an edited dropdown is marked stale, not hidden", () => {
    const fuel = def({ label: "Fuel", kind: "select", options: ["Gas", "Electric"] }, "fuel");
    const details = applyDetailChange(emptyRecordDetails(), "fuel", "Diesel", NOW);
    const view = buildRecordDetailsView({ entityType: "profile", entityId: "car", record: { type: "vehicle" }, definitions: [fuel], details, todayISO: TODAY });
    expect(view.rows[0]).toMatchObject({ display: "Diesel", stale: true });
  });

  it("distribution follows the scale's order", () => {
    const condition = def({ label: "Condition", kind: "condition" });
    expect(valueDistribution(condition, ["Poor", "Good", "Good", null])).toEqual([
      { value: "Good", count: 2 }, { value: "Poor", count: 1 }, { value: "—", count: 1 },
    ]);
  });
});

describe("inferring a new characteristic's type from chat", () => {
  it("a template wins: Condition on a car is the condition scale", async () => {
    const { inferDetailDefinition } = await import("../shared/record-details");
    const car = recordScopeTokens("profile", { type: "vehicle" });
    expect(inferDetailDefinition("Condition", "good", car)).toMatchObject({ kind: "condition", appliesTo: ["vehicle"] });
    expect(inferDetailDefinition("Paint condition", "fair", car)).toMatchObject({ kind: "condition" });
  });
  it("otherwise the value's shape decides; text is the last resort", async () => {
    const { inferDetailDefinition, fieldKeyIdentity } = await import("../shared/record-details");
    expect(inferDetailDefinition("Garage kept", "yes", []).kind).toBe("boolean");
    expect(inferDetailDefinition("Tire pressure", "35", []).kind).toBe("number");
    expect(inferDetailDefinition("Deposit", "$1,200", []).kind).toBe("currency");
    expect(inferDetailDefinition("Last detailed", "2026-10-02", []).kind).toBe("date");
    expect(inferDetailDefinition("Nickname", "Blue Thunder", []).kind).toBe("text");
    expect(fieldKeyIdentity("roofCondition")).toBe("roof condition");
  });
});

// ── Quick add (owner request 2026-11-21: "I type 'Cracked screen', that's it") ──
describe("parseQuickDetail", () => {
  const cond = buildDefinition({ label: "Condition", kind: "condition", appliesTo: ["vehicle"] }, { id: "condition", now: "2026-11-21T00:00:00Z" });
  const defs = cond.ok ? [cond.value] : [];
  const tokens = ["profile", "asset", "vehicle"];
  const ready = (s: string) => {
    const r = parseQuickDetail(s, defs, tokens);
    if (!r || r.status !== "ready") throw new Error(`expected ready for ${s}: ${JSON.stringify(r)}`);
    return r;
  };
  it("a bare phrase is a yes/no flag, never free text", () => {
    const r = ready("cracked screen");
    expect(r).toMatchObject({ label: "Cracked screen", kind: "boolean", value: true, existing: null });
    expect(r.input).toMatchObject({ label: "Cracked screen", kind: "boolean" });
  });
  it("label: value, known name + value, trailing numbers", () => {
    expect(ready("Color: Blue")).toMatchObject({ label: "Color", kind: "text", value: "Blue" });
    expect(ready("condition good")).toMatchObject({ kind: "condition", value: "Good", input: null });
    expect(ready("condition good").existing?.id).toBe("condition");
    expect(ready("Mileage 45000")).toMatchObject({ label: "Mileage", kind: "number", value: 45000 });
    expect(ready("Battery health 87%")).toMatchObject({ kind: "percent", value: 87 });
  });
  it("a bare existing non-yes/no name asks for its value; a wrong value is refused", () => {
    expect(parseQuickDetail("Condition", defs, tokens)).toMatchObject({ status: "needs_value", kind: "condition" });
    expect(parseQuickDetail("Condition: meh", defs, tokens)).toMatchObject({ status: "invalid" });
    expect(parseQuickDetail("   ", defs, tokens)).toBeNull();
  });
});
