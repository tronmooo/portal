// The food databases behind the internal table (server/nutrition-sources.ts):
// USDA FoodData Central and Open Food Facts, by name and by barcode.
//
// The network is replaced by RECORDED responses (tests/fixtures/
// nutrition-sources/recorded.json, captured from the live APIs on 2026-11-25),
// so the suite pins how real records are read: which figure is the energy,
// when the label's own per-serving values are used instead of per-100 g
// arithmetic, how "1 cup" and "12 crackers" become an amount of the record,
// and what is refused (a barcode that fails its check digit, a retail product
// offered for a restaurant order, a chooser that says "none of these").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  barcodeIn, barcodeLookup, componentFromSource, fdcDetail, fdcSearch, isValidGtin, resolveAmount, resolveFromSources,
  restaurantIn, scoreChoose, searchQuery, type SourceCandidate, type SourceDeps,
} from "../server/nutrition-sources";
import { normalizeQuantity } from "../shared/nutrition-enrichment";

const REC = JSON.parse(readFileSync(join(__dirname, "fixtures", "nutrition-sources", "recorded.json"), "utf8"));
const NOW = "2026-11-25T12:00:00.000Z";
const requested: string[] = [];
/** Answers from the recording; anything not recorded is "nothing found", as a failed request would be. */
const fetchJson: SourceDeps["fetchJson"] = async (url) => {
  requested.push(url);
  if (url.includes("/foods/search") && /quinoa/i.test(url)) return REC["fdc-search-quinoa-cooked"];
  if (url.includes("/foods/search") && /triscuit/i.test(url) && url.includes("Branded")) return REC["fdc-search-triscuit"];
  if (url.includes("/food/168917")) return REC["fdc-detail-168917"];
  if (url.includes("/food/1461209")) return REC["fdc-detail-1461209"];
  if (url.includes("/food/2744038")) return REC["fdc-detail-2744038"];
  if (url.includes("/product/3017620422003")) return REC["off-barcode-3017620422003"];
  return null;
};
const deps = (choose?: SourceDeps["choose"]): SourceDeps => ({ fetchJson, now: () => NOW, choose: choose ?? (async () => null) });
const total = (c: any, k: string) => c?.nutrients?.[k]?.value;

describe("USDA FoodData Central records", () => {
  it("a generic food is read per 100 g and scaled by the stated weight", async () => {
    const found = await fdcSearch("quinoa cooked", "generic", deps());
    const quinoa = found.find((c) => c.name === "Quinoa, cooked")!;
    expect(quinoa).toMatchObject({ provider: "fdc", id: "168917", dataType: "SR Legacy", per100Unit: "g" });
    expect(quinoa.per100).toMatchObject({ calories: 120, protein: 4.4, carbs: 21.3, fat: 1.92 });
    const [c] = await resolveFromSources([{ phrase: "Quinoa, cooked", quantityText: "150 grams of cooked quinoa", branded: false }], deps());
    expect(c!.name).toBe("Quinoa, cooked");
    expect([total(c, "calories"), total(c, "protein"), total(c, "carbs"), total(c, "fat")]).toEqual([180, 6.6, 31.95, 2.88]);
    expect(c!.sourceType).toBe("reference");
    expect(c!.source).toContain("USDA FoodData Central SR Legacy #168917");
    expect(c!.sourceRef).toMatchObject({ provider: "fdc", id: "168917" });
    expect(c!.servingAssumed).toBe(false);
  });

  it("'1 cup' is the record's own cup (185 g), never a generic 240 ml", async () => {
    const [c] = await resolveFromSources([{ phrase: "Quinoa, cooked", quantityText: "1 cup of cooked quinoa", branded: false }], deps());
    expect(total(c, "calories")).toBe(222);
    expect(c!.source).toContain("185 g per cup");
  });

  it("a branded product uses the label's printed per-serving values, and a count is read against the label's serving", async () => {
    // The chooser picks the 8.5 oz box, a record that carries its printed label.
    const pick8oz: SourceDeps["choose"] = async (asks) => asks.map((a) => ({ pick: a.candidates.findIndex((c) => c.id === "2744038") }));
    const [c] = await resolveFromSources([{ phrase: "Triscuit Original Crackers", quantityText: "12 Triscuit Original crackers", branded: true }], deps(pick8oz));
    // 6 crackers (28 g) per serving → 12 crackers = 2 servings of the printed label: 120 kcal × 2, not 429 kcal/100 g × 56 g.
    expect(c!.servings).toBe(2);
    expect(c!.matchedServing!.label).toContain("6 crackers");
    expect(total(c, "calories")).toBe(240);
    expect(total(c, "fat")).toBe(7);
    expect(c!.sourceType).toBe("product_database");
    expect(c!.confidence).toBe("high");
    // By weight: 42 g of a 28 g serving is 1.5 servings of the same printed label.
    const [w] = await resolveFromSources([{ phrase: "Triscuit Original Crackers", quantityText: "42 g of Triscuit Original crackers", branded: true }], deps(pick8oz));
    expect(w!.servings).toBe(1.5);
    expect(total(w, "calories")).toBe(180);
  });

  it("no chooser and no clear name match → no record (a wrong record is worse than none)", async () => {
    const [c] = await resolveFromSources([{ phrase: "Zanzibar spiced breadfruit stew", quantityText: "a bowl", branded: false }], deps());
    expect(c).toBeNull();
    const quinoaList = await fdcSearch("quinoa cooked", "generic", deps());
    expect(scoreChoose({ phrase: "purple yam jam", quantityText: "", branded: false }, quinoaList).pick).toBeNull();
  });

  it("a chooser that answers 'none of these' is obeyed; one that picks reads an assumed amount as assumed", async () => {
    const none = await resolveFromSources([{ phrase: "Quinoa, cooked", quantityText: "150 g", branded: false }], deps(async (asks) => asks.map(() => ({ pick: null }))));
    expect(none[0]).toBeNull();
    const bowl = await resolveFromSources(
      [{ phrase: "Quinoa, cooked", quantityText: "a big bowl of quinoa", branded: false }],
      deps(async (asks) => asks.map((a) => ({ pick: a.candidates.findIndex((c) => c.name === "Quinoa, cooked"), assumedAmount: 300 }))),
    );
    expect(total(bowl[0], "calories")).toBe(360);
    expect(bowl[0]!.servingAssumed).toBe(true);
    expect(bowl[0]!.confidence).toBe("medium");
    // A stated weight is never replaced by the chooser's reading.
    const stated = await resolveFromSources(
      [{ phrase: "Quinoa, cooked", quantityText: "150 g of quinoa", branded: false }],
      deps(async (asks) => asks.map((a) => ({ pick: a.candidates.findIndex((c) => c.name === "Quinoa, cooked"), assumedAmount: 999 }))),
    );
    expect(total(stated[0], "calories")).toBe(180);
  });
});

describe("barcodes", () => {
  it("a GTIN passes its check digit; an amount or a phone number does not", () => {
    expect(isValidGtin("3017620422003")).toBe(true);
    expect(isValidGtin("3017620422004")).toBe(false);
    expect(isValidGtin("012345678905")).toBe(true);
    expect(barcodeIn("I ate 30 g of the product with barcode 3017620422003.")).toBe("3017620422003");
    expect(barcodeIn("barcode 3 017620 422003")).toBe("3017620422003");
    expect(barcodeIn("call me at 5551234567 about 1200 calories")).toBeNull();
    expect(barcodeIn("I ate 30 g of Nutella")).toBeNull();
  });

  it("a barcode names the product outright: Open Food Facts record, per-100 g × the stated weight, exact", async () => {
    const product = await barcodeLookup("3017620422003", deps());
    expect(product).toMatchObject({ provider: "off", id: "3017620422003", name: "Nutella" });
    const [c] = await resolveFromSources([{ phrase: "Barcode 3017620422003 (30 g)", quantityText: "30 g of the product with barcode 3017620422003", branded: true }], deps());
    expect([total(c, "calories"), total(c, "protein"), total(c, "carbs"), total(c, "fat")]).toEqual([161.7, 1.89, 17.25, 9.27]);
    expect(c!.confidence).toBe("exact");
    expect(c!.source).toContain("barcode match");
    expect(c!.sourceRef).toMatchObject({ provider: "off", barcode: "3017620422003" });
    // The barcode is looked up before any name search.
    expect(requested.some((u) => u.includes("/product/3017620422003"))).toBe(true);
  });

  it("a number that fails the check digit is not looked up", async () => {
    expect(await barcodeLookup("3017620422004", deps())).toBeNull();
  });
});

describe("amounts against a record", () => {
  const drink: SourceCandidate = { provider: "off", id: "1", name: "Oat drink", per100: { calories: 46, protein: 1, carbs: 6.6, fat: 1.5 }, per100Unit: "ml", isBeverage: true, serving: { ml: 250, label: "250 ml" }, perServing: { calories: 115 }, package: { ml: 1000, label: "1 L" } };
  const solid: SourceCandidate = { provider: "fdc", id: "2", name: "Rice, cooked", dataType: "SR Legacy", per100: { calories: 130 }, per100Unit: "g", portions: [{ label: "1 cup", grams: 158 }, { label: "3 oz", grams: 85 }] };
  const q = (t: string) => normalizeQuantity(t);

  it("volume of a drink, share of its package, weight and household measure", () => {
    expect(resolveAmount(drink, q("330 ml of oat drink"), "oat drink")).toMatchObject({ amount: 330, unit: "ml", assumed: false });
    expect(resolveAmount(drink, q("half the carton of oat drink"), "oat drink")).toMatchObject({ amount: 500, unit: "ml" });
    expect(resolveAmount(solid, q("200 g of rice"), "rice")).toMatchObject({ amount: 200, unit: "g", assumed: false });
    expect(resolveAmount(solid, q("1.5 cups of rice"), "rice")).toMatchObject({ amount: 237, unit: "g", assumed: false });
  });

  it("an amount the record cannot read is assumed and says so; with nothing to go on there is no answer", () => {
    expect(resolveAmount(solid, q("a plate of rice"), "rice", { pick: 0, assumedAmount: 300 })).toMatchObject({ amount: 300, assumed: true });
    expect(resolveAmount({ ...solid, portions: [] }, q("some rice"), "rice")).toBeNull();
  });

  it("a per-100 g record never prices a volume it has no measure for as if density were known", () => {
    const c = componentFromSource({ ...solid, portions: [] }, { phrase: "Rice, cooked", quantityText: "200 ml of rice", branded: false }, { pick: 0 }, NOW);
    expect(c!.servingAssumed).toBe(true);
    expect(c!.source).toContain("density not on record");
  });
});

describe("what is searched, and what is refused", () => {
  it("the search words are the food, without amounts and verbs", () => {
    expect(searchQuery("I ate 150 grams of cooked quinoa")).toBe("cooked quinoa");
    expect(searchQuery("Chicken thigh, roasted (116 g)")).toBe("Chicken thigh roasted");
    expect(searchQuery("2 slices of Dave's Killer Bread 21 Whole Grains")).toBe("Dave's Killer Bread Whole Grains");
  });

  it("a restaurant order only accepts records that carry the restaurant's name", async () => {
    expect(restaurantIn("Chipotle Chicken Burrito Bowl")).toBe("chipotle");
    expect(restaurantIn("McDonald's Egg McMuffin")).toBe("mcdonalds");
    expect(restaurantIn("quinoa bowl")).toBeNull();
    // The recording answers "quinoa" searches with plain quinoa records: none is Panera's.
    const [c] = await resolveFromSources([{ phrase: "Panera quinoa bowl", quantityText: "a Panera quinoa bowl", branded: true }], deps(async (asks) => asks.map(() => ({ pick: 0 }))));
    expect(c).toBeNull();
  });

  it("the record's detail adds household measures and the printed label", async () => {
    const [quinoa] = (await fdcSearch("quinoa cooked", "generic", deps())).filter((c) => c.id === "168917");
    const detailed = await fdcDetail(quinoa, deps());
    expect(detailed.portions).toEqual([{ label: "1 cup", grams: 185 }]);
  });
});
