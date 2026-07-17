// Asset valuation: full-record context + no-anchoring regression tests.
//
// Bug: "Look up value" reused the same number because (1) only flat scalar
// fields reached the prompt (upgrades/repairs/docs/notes were dropped) and
// (2) the previous estimate (currentValue/valuationRange/previousValue) was
// fed back into the prompt, so the model anchored on its own prior answer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildValuationDossier,
  parseValuationResponse,
  isPriorValuationKey,
  VALUATION_RESPONSE_SPEC,
} from "../server/valuation";
import { estimateAssetValue } from "../server/ai-engine";

const vehicleProfile = (overrides: Record<string, any> = {}) => ({
  type: "vehicle",
  name: "Robert's Honda CR-V",
  fields: {
    year: 2021,
    make: "Honda",
    model: "CR-V",
    trim: "EX-L",
    mileage: 80000,
    condition: "good",
    location: "Los Angeles, CA",
    purchasePrice: 28000,
    purchaseDate: "2021-11-02",
    specifications: { drivetrain: "AWD", engine: "1.5L turbo" },
    // Prior valuation output — must NEVER appear in a new prompt:
    currentValue: 21400,
    previousValue: 21400,
    valuationRange: "$19,250 - $25,199",
    valuationMethod: "Live search: KBB",
    valuationConfidence: "high",
    valuationDate: "2026-07-01T00:00:00.000Z",
    ...overrides,
  },
});

const richContext = {
  notes: "Garage kept, non-smoker, one owner.",
  aiSummary: "2021 Honda CR-V valued with 80,000 miles; no recorded maintenance history.",
  expenses: [
    { description: "New tires installed", amount: 820, category: "auto", date: "2026-03-14" },
    { description: "Oil change and brake service", amount: 240, category: "maintenance", date: "2026-05-02" },
    { description: "Car wash", amount: 25, category: "auto", date: "2026-06-20" },
  ],
  documents: [
    { name: "Progressive insurance card", type: "insurance", extractedData: { policy: "907344659" } },
    { name: "CA registration", type: "registration", extractedData: { expires: "2026-10-22" } },
  ],
  timeline: [{ type: "expense", title: "Oil change and brake service", timestamp: "2026-05-02T10:00:00Z" }],
};

describe("buildValuationDossier — uses the complete asset record", () => {
  it("includes every relevant stored field, including nested specifications", () => {
    const d = buildValuationDossier(vehicleProfile(), richContext);
    expect(d).toContain("Robert's Honda CR-V");
    expect(d).toContain("year: 2021");
    expect(d).toContain("mileage: 80000");
    expect(d).toContain("condition: good");
    expect(d).toContain("location: Los Angeles, CA");
    expect(d).toContain("trim: EX-L");
    expect(d).toContain("purchasePrice: 28000");
    // Nested objects are serialized, not silently dropped:
    expect(d).toContain("drivetrain");
    expect(d).toContain("AWD");
  });

  it("includes upgrades, repairs/maintenance, documents, notes, summary, and timeline", () => {
    const d = buildValuationDossier(vehicleProfile(), richContext);
    expect(d).toContain("Upgrades & improvements");
    expect(d).toContain("New tires installed");
    expect(d).toContain("Repairs & maintenance history");
    expect(d).toContain("Oil change and brake service");
    expect(d).toContain("Progressive insurance card");
    expect(d).toContain("Garage kept");
    expect(d).toContain("AI profile summary");
    expect(d).toContain("Recent activity");
  });

  it("NEVER includes prior valuation outputs (anchoring regression)", () => {
    const d = buildValuationDossier(vehicleProfile(), richContext);
    expect(d).not.toContain("21400");
    expect(d).not.toContain("currentValue");
    expect(d).not.toContain("previousValue");
    expect(d).not.toContain("$19,250");
    expect(d).not.toContain("valuationRange");
    expect(d).not.toContain("valuationMethod");
    expect(d).not.toContain("valuationDate");
  });

  it("changes when meaningful asset details change", () => {
    const base = buildValuationDossier(vehicleProfile(), richContext);
    const higherMiles = buildValuationDossier(vehicleProfile({ mileage: 120000 }), richContext);
    const worseCondition = buildValuationDossier(vehicleProfile({ condition: "poor" }), richContext);
    const moved = buildValuationDossier(vehicleProfile({ location: "Austin, TX" }), richContext);
    expect(higherMiles).not.toEqual(base);
    expect(higherMiles).toContain("mileage: 120000");
    expect(worseCondition).toContain("condition: poor");
    expect(moved).toContain("Austin, TX");
  });

  it("skips underscore-prefixed and empty fields", () => {
    const d = buildValuationDossier(vehicleProfile({ _internal: "secret", empty: "", nil: null }), richContext);
    expect(d).not.toContain("_internal");
    expect(d).not.toContain("secret");
    expect(d).not.toContain("empty:");
  });

  it("flags prior-valuation keys case-insensitively", () => {
    expect(isPriorValuationKey("currentValue")).toBe(true);
    expect(isPriorValuationKey("CURRENTVALUE")).toBe(true);
    expect(isPriorValuationKey("valuationFactors")).toBe(true);
    expect(isPriorValuationKey("purchasePrice")).toBe(false);
    expect(isPriorValuationKey("mileage")).toBe(false);
  });
});

describe("parseValuationResponse — structured output", () => {
  it("parses value, range, confidence, factors, and missing info", () => {
    const v = parseValuationResponse(JSON.stringify({
      value: 20100, low: 18500, high: 22000, confidence: "medium", method: "KBB, Edmunds",
      factors: ["80,000 miles", "good condition", "new tires"],
      missing: ["service records"],
    }));
    expect(v).not.toBeNull();
    expect(v!.estimatedValue).toBe(20100);
    expect(v!.lowValue).toBe(18500);
    expect(v!.highValue).toBe(22000);
    expect(v!.details).toBe("$18,500 - $22,000");
    expect(v!.factorsConsidered).toEqual(["80,000 miles", "good condition", "new tires"]);
    expect(v!.missingInfo).toEqual(["service records"]);
    expect(new Date(v!.valuationDate).getTime()).toBeGreaterThan(0);
  });

  it("falls back to a legacy range string when low/high are absent", () => {
    const v = parseValuationResponse('{"value": 21400, "confidence": "high", "method": "KBB", "range": "$19,250 - $25,199"}');
    expect(v!.lowValue).toBe(19250);
    expect(v!.highValue).toBe(25199);
  });

  it("swaps a reversed low/high band", () => {
    const v = parseValuationResponse('{"value": 500, "low": 700, "high": 400}');
    expect(v!.lowValue).toBe(400);
    expect(v!.highValue).toBe(700);
  });

  it("returns null for missing or non-positive values", () => {
    expect(parseValuationResponse("no json here")).toBeNull();
    expect(parseValuationResponse('{"value": 0}')).toBeNull();
    expect(parseValuationResponse('{"value": -5}')).toBeNull();
  });

  it("applies the method prefix used by the live-search path", () => {
    const v = parseValuationResponse('{"value": 100, "method": "Swappa"}', { methodPrefix: "Live search: " });
    expect(v!.method).toBe("Live search: Swappa");
  });

  it("response spec demands recomputation and factor/missing reporting", () => {
    expect(VALUATION_RESPONSE_SPEC).toContain("Do NOT reuse or repeat any previous estimate");
    expect(VALUATION_RESPONSE_SPEC).toContain('"factors"');
    expect(VALUATION_RESPONSE_SPEC).toContain('"missing"');
  });
});

describe("estimateAssetValue — live-search path sends the full record", () => {
  const ppxResponse = (body: Record<string, any>) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  });

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("PERPLEXITY_API_KEY", "test-key");
    fetchMock = vi.fn().mockResolvedValue(ppxResponse({
      value: 20100, low: 18500, high: 22000, confidence: "medium", method: "KBB",
      factors: ["80,000 miles"], missing: ["trim level"],
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const sentPrompt = () => {
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    return body.messages.map((m: any) => m.content).join("\n");
  };

  it("refuses non-valuable types without any network call", async () => {
    const result = await estimateAssetValue({ type: "person", name: "Patrick", fields: {} });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the complete dossier and returns the structured valuation", async () => {
    const result = await estimateAssetValue(
      { type: "vehicle", name: vehicleProfile().name, fields: vehicleProfile().fields },
      richContext,
    );
    const prompt = sentPrompt();
    expect(prompt).toContain("mileage: 80000");
    expect(prompt).toContain("condition: good");
    expect(prompt).toContain("New tires installed");
    expect(prompt).toContain("Garage kept");
    // Prior estimate must not be visible to the model:
    expect(prompt).not.toContain("21400");
    expect(prompt).not.toContain("$19,250");

    expect(result).not.toBeNull();
    expect(result!.estimatedValue).toBe(20100);
    expect(result!.lowValue).toBe(18500);
    expect(result!.highValue).toBe(22000);
    expect(result!.factorsConsidered).toEqual(["80,000 miles"]);
    expect(result!.missingInfo).toEqual(["trim level"]);
    expect(result!.method).toBe("Live search: KBB");
    expect(result!.details).toBe("$18,500 - $22,000");
  });

  it("sends a different prompt when asset details change", async () => {
    await estimateAssetValue(
      { type: "vehicle", name: vehicleProfile().name, fields: vehicleProfile().fields },
      richContext,
    );
    const first = sentPrompt();

    fetchMock.mockClear();
    await estimateAssetValue(
      { type: "vehicle", name: vehicleProfile().name, fields: vehicleProfile({ mileage: 120000, condition: "fair" }).fields },
      richContext,
    );
    const second = sentPrompt();

    expect(second).not.toEqual(first);
    expect(second).toContain("mileage: 120000");
    expect(second).toContain("condition: fair");
  });
});
