// Scanned nutrition labels and barcodes (shared/nutrition-scan.ts,
// server/nutrition-label-scan.ts): what a picture's reading may contain, how
// the amount eaten is read against the label's own serving, and that the
// stored entry is the label's figures times that amount — nothing looked up,
// nothing filled in. The picture reader and the network are injected.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { enrichNutritionEntry } from "../server/nutrition-enrichment";
import { labelFromCandidate, scanNutritionLabel } from "../server/nutrition-label-scan";
import { asksToLogPicturedFood, consumedFromScan, sanitizeScannedLabel, scaledScanValues, scanItemName, type ScannedLabel } from "../shared/nutrition-scan";
import { verificationOf, type NutritionEnrichment } from "../shared/nutrition-enrichment";

/** What the reader returns for the granola label in tests/fixtures/nutrition-labels/granola.png. */
const GRANOLA_READING = {
  kind: "label", productName: "Maple Pecan Granola", brand: "Northfield Oats", barcode: null,
  serving: { text: "2/3 cup (55g)", grams: 55, ml: null, householdAmount: 0.667, householdUnit: "cup" },
  servingsPerContainer: 8,
  perServing: { calories: 230, fat: 9, saturatedFat: 1, transFat: 0, cholesterol: 0, sodium: 115, carbs: 34, fiber: 4, sugar: 10, addedSugar: 8, protein: 5, vitaminD: 0, calcium: 26, iron: 1.6, potassium: 150 },
  perContainer: null,
  dailyValues: { fat: 12, saturatedFat: 5, sodium: 5, carbs: 12, fiber: 14, addedSugar: 16, calcium: 2, iron: 8, potassium: 4 },
};
const granola = (): ScannedLabel => sanitizeScannedLabel(GRANOLA_READING)!;

describe("what a reading may contain", () => {
  it("keeps what is printed, under canonical keys, with the serving and % Daily Values", () => {
    const l = granola();
    expect(l.serving).toMatchObject({ text: "2/3 cup (55g)", grams: 55, householdUnit: "cup" });
    expect(l.servingsPerContainer).toBe(8);
    expect(l.perServing).toMatchObject({ calories: 230, fat: 9, carbs: 34, protein: 5, fiber: 4, sugar: 10, addedSugar: 8, sodium: 115, iron: 1.6 });
    expect(l.dailyValues).toMatchObject({ fat: 12, fiber: 14, iron: 8 });
    expect(scanItemName(l)).toBe("Northfield Oats Maple Pecan Granola");
  });

  it("'<1 g', 'trace' and unreadable values are left out, never stored as 0; a printed 0 is kept", () => {
    const l = sanitizeScannedLabel({ serving: { text: "about 15 chips (28g)" }, perServing: { calories: 150, fat: "9g", sugar: "<1g", fiber: "trace", transFat: 0, protein: "2 g", sodium: "n/a", "Total Carbohydrate": 16 } })!;
    expect(l.perServing).toEqual({ calories: 150, fat: 9, transFat: 0, protein: 2, carbs: 16 });
    expect("sugar" in l.perServing).toBe(false);
    expect("fiber" in l.perServing).toBe(false);
    // The serving's weight is read from its printed text when the reader left it out.
    expect(l.serving.grams).toBe(28);
  });

  it("something that is not a nutrition label is refused", () => {
    expect(sanitizeScannedLabel({ serving: { text: "1 cup" }, perServing: {} })).toBeNull();
    expect(sanitizeScannedLabel(null)).toBeNull();
    expect(sanitizeScannedLabel({ perServing: { protein: 3 } })).toBeNull();
  });
});

describe("how much was eaten, against the label's own serving", () => {
  const cases: Array<[string, number, boolean]> = [
    ["I ate 2 servings of this.", 2, false],
    ["I ate 82.5 grams of this", 1.5, false],
    ["I ate a third of a cup of this granola", 0.4998, false],
    ["half a cup", 0.7496, false],
    ["I ate the whole bag", 8, false],
    ["half the bag", 4, false],
    ["I had half a serving", 0.5, false],
    ["Log this food for me.", 1, true],
    ["", 1, true],
  ];
  for (const [said, servings, assumed] of cases) {
    it(`"${said}" → ${servings} serving(s)${assumed ? " (assumed)" : ""}`, () => {
      const eaten = consumedFromScan(granola(), said);
      expect(eaten.servings).toBeCloseTo(servings, 3);
      expect(eaten.assumed).toBe(assumed);
    });
  }

  it("a count is read against the label's pieces, a volume against its millilitres", () => {
    const bar = sanitizeScannedLabel({ serving: { text: "1 bar (60g)" }, servingsPerContainer: 1, perServing: { calories: 200, protein: 12, carbs: 22 } })!;
    expect(consumedFromScan(bar, "I ate half of this bar").servings).toBe(0.5);
    expect(consumedFromScan(bar, "I ate 2 bars").servings).toBe(2);
    const cookies = sanitizeScannedLabel({ serving: { text: "3 cookies (34g)" }, perServing: { calories: 160, fat: 7, carbs: 25 } })!;
    expect(consumedFromScan(cookies, "I ate 7 cookies").servings).toBeCloseTo(2.3333, 3);
    const drink = sanitizeScannedLabel({ serving: { text: "8 fl oz (240mL)" }, servingsPerContainer: 2.5, perServing: { calories: 70, carbs: 17, protein: 1 } })!;
    expect(consumedFromScan(drink, "I drank 12 fl oz of this").servings).toBeCloseTo(1.479, 2);
    expect(consumedFromScan(drink, "I drank the whole bottle of this").servings).toBe(2.5);
    expect(consumedFromScan(drink, "360 ml").servings).toBe(1.5);
  });

  it("the figures are the label's, times the servings: printed calories are scaled, never recomputed", () => {
    expect(scaledScanValues(granola(), 1.5)).toMatchObject({ calories: 345, fat: 13.5, carbs: 51, protein: 7.5, fiber: 6, sodium: 173 });
  });
});

describe("reading a picture", () => {
  it("a label picture → the label; nothing is written", async () => {
    const out = await scanNutritionLabel("aGVsbG8=", "image/png", { read: async () => JSON.stringify(GRANOLA_READING) });
    expect(out.kind).toBe("label");
    if (out.kind === "label") expect(out.label.perServing.calories).toBe(230);
  });

  it("a barcode picture → the digits, checked, then the product from the database", async () => {
    const product = { status: 1, product: { code: "3017620422003", product_name: "Nutella", brands: "Ferrero", quantity: "400 g", nutriments: { "energy-kcal_100g": 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9 } } };
    const out = await scanNutritionLabel("aGVsbG8=", "image/png", { read: async () => '{"kind":"barcode","barcode":"3 017620 422003"}', fetchJson: async (url) => (url.includes("3017620422003") ? product : null) });
    expect(out.kind).toBe("barcode");
    if (out.kind === "barcode") {
      expect(out.barcode).toBe("3017620422003");
      expect(out.label).toMatchObject({ origin: "barcode", productName: "Nutella", serving: { text: "100 g", grams: 100 }, perServing: { calories: 539 } });
      expect(consumedFromScan(out.label!, "I ate 30 g of this").servings).toBe(0.3);
    }
    // Digits that fail the check digit are a misread, not a product.
    const bad = await scanNutritionLabel("aGVsbG8=", "image/png", { read: async () => '{"kind":"barcode","barcode":"3017620422004"}' });
    expect(bad.kind).toBe("none");
  });

  it("a picture of something else is 'none', and a reader failure is an error with nothing logged", async () => {
    const cat = await scanNutritionLabel("aGVsbG8=", "image/png", { read: async () => '{"kind":"none","reason":"a cat on a sofa"}' });
    expect(cat).toEqual({ kind: "none", reason: "a cat on a sofa" });
    await expect(scanNutritionLabel("aGVsbG8=", "image/png", { read: async () => { throw new Error("timeout"); } })).rejects.toThrow(/could not be read/);
  });

  it("a database product without per-serving figures is offered per 100 g", () => {
    const l = labelFromCandidate({ provider: "off", id: "5053990101573", name: "Pringles Original", brand: "Pringles", per100: { calories: 528, protein: 6.2, carbs: 54, fat: 31 }, per100Unit: "g" })!;
    expect(l.serving).toMatchObject({ text: "100 g", grams: 100 });
    expect(consumedFromScan(l, "30 g").servings).toBe(0.3);
  });
});

describe("a scanned label is the entry's whole source", () => {
  let storage: MemStorage;
  let trackerId: string;
  beforeEach(async () => {
    storage = new MemStorage();
    trackerId = (await storage.createTracker({ name: "Nutrition", category: "nutrition", fields: [{ name: "calories", type: "number", unit: "kcal", isPrimary: true }, { name: "item", type: "text" }] })).id;
  });

  it("the entry takes the label × servings, records where it came from, and keeps what the label omits unknown", async () => {
    // A base entry carrying a guess for something this label does not print (caffeine).
    const entry = await storage.logEntry({ trackerId, values: { item: "Northfield Oats Maple Pecan Granola", calories: 1, caffeine: 40 } } as any);
    const out = await enrichNutritionEntry(storage, { entryId: entry!.id, trackerId, message: "", mode: "auto", scan: { label: granola(), quantity: "I ate 2 servings of this." }, deps: { now: () => "2026-11-25T12:00:00.000Z" } });
    expect(out.status).toBe("applied");
    const stored = (await storage.getTrackerEntry(entry!.id))! as any;
    expect(stored.values).toMatchObject({ calories: 460, fat: 18, carbs: 68, protein: 10, fiber: 8, sugar: 20, sodium: 230 });
    expect("caffeine" in stored.values).toBe(false);
    const e = stored.computed.nutrition as NutritionEnrichment;
    expect(e.components).toHaveLength(1);
    expect(e.components[0]).toMatchObject({ sourceType: "user", servings: 2, servingAssumed: false, sourceRef: { provider: "scan" } });
    expect(e.components[0].source).toContain("nutrition label you scanned");
    expect(e.components[0].dailyValues).toMatchObject({ fat: 24, fiber: 28 });
    expect(e.totals.iron?.value).toBe(3.2);
    expect(e.verification).toBe("verified");
    expect(verificationOf(e)).toBe("verified");
  });

  it("no amount stated: one serving, marked assumed and not called verified", async () => {
    const entry = await storage.logEntry({ trackerId, values: { item: "Granola", calories: 1 } } as any);
    await enrichNutritionEntry(storage, { entryId: entry!.id, trackerId, message: "", mode: "auto", scan: { label: granola(), quantity: "Log this food for me." } });
    const e = ((await storage.getTrackerEntry(entry!.id))! as any).computed.nutrition as NutritionEnrichment;
    expect(((await storage.getTrackerEntry(entry!.id))! as any).values.calories).toBe(230);
    expect(e.components[0].servingAssumed).toBe(true);
    expect(e.verification).toBe("estimated");
  });
});

describe("a picture sent in chat", () => {
  it("is treated as food to log only when the message says so", () => {
    expect(asksToLogPicturedFood("I ate 2 servings of this.")).toBe(true);
    expect(asksToLogPicturedFood("Log this food for me.")).toBe(true);
    expect(asksToLogPicturedFood("I drank the whole bottle of this.")).toBe(true);
    expect(asksToLogPicturedFood("Save this receipt")).toBe(false);
    expect(asksToLogPicturedFood("Here is my insurance card")).toBe(false);
    expect(asksToLogPicturedFood("")).toBe(false);
  });
});
