// One food = one entry (owner, 2026-11-22). "Eat a banana and a doughnut" was
// saved as ONE "Banana + Doughnut" entry of 355 kcal: the chat prompt told the
// model that one meal is one entry. The prompt now asks for one log per food,
// and the server splits a combined call before it runs (server/meal-split.ts),
// so the rule holds whatever the model sends.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitSeparateFoods, shareMealValues, foodLabel } from "../shared/food-split";
import { splitCombinedFoodLog } from "../server/meal-split";

describe("which foods an item names", () => {
  it.each([
    ["Banana + Doughnut", ["Banana", "Doughnut"]],
    ["a banana and a doughnut", ["a banana", "a doughnut"]],
    ["Big Mac + medium fries", ["Big Mac", "medium fries"]],
    ["Steak, Blueberries, Mac & Cheese", ["Steak", "Blueberries", "Mac & Cheese"]],
    ["3 eggs, 2 wheat toast with butter, a banana and coffee with creamer", ["3 eggs", "2 wheat toast with butter", "a banana", "coffee with creamer"]],
    ["pizza and a beer", ["pizza", "a beer"]],
  ])("%s is separate foods", (item, foods) => {
    expect(splitSeparateFoods(item)).toEqual(foods);
  });

  it.each([
    "Banana",
    "Mac and Cheese",
    "Peanut butter and jelly sandwich",
    "Coffee with cream and sugar",
    "Bacon, egg and cheese sandwich",
    "Smoothie with banana, spinach and protein powder",
    "Gatorade (half bottle, ~16 oz)",
    "Quaker Instant Oatmeal Maple & Brown Sugar (1 packet) with 2% milk (1 cup)",
    "Fish and chips",
  ])("%s is one food", (item) => {
    expect(splitSeparateFoods(item)).toEqual([item]);
  });

  it("labels an entry by its food, without the article", () => {
    expect(foodLabel("a banana")).toBe("Banana");
    expect(foodLabel("2 eggs")).toBe("2 eggs");
  });
});

describe("each food gets its own numbers", () => {
  it("a priced food keeps its values and the rest share what is left", () => {
    const shares = shareMealValues({ calories: 355, protein: 4 }, [{ calories: 105, protein: 1 }, null]);
    expect(shares).toEqual([{ calories: 105, protein: 1 }, { calories: 250, protein: 3 }]);
  });
  it("never goes below zero when the reference exceeds the model's total", () => {
    expect(shareMealValues({ calories: 100 }, [{ calories: 150 }, null])[1].calories).toBe(0);
  });
});

describe("a combined chat call becomes one call per food", () => {
  const call = (item: string, extra: Record<string, any> = {}) => ({
    trackerName: "Calories",
    values: { item, calories: 355, protein: 4, carbs: 76, fat: 13, mealType: "snack", ...extra },
    forProfile: "Me",
  });

  it("the screenshot: 'Banana + Doughnut' is a Banana entry and a Doughnut entry", async () => {
    const parts = await splitCombinedFoodLog(call("Banana + Doughnut"), "Eat a banana and a doughnut");
    expect(parts).not.toBeNull();
    expect(parts!.map((p) => p.values.item)).toEqual(["Banana", "Doughnut"]);
    for (const p of parts!) {
      expect(p.trackerName).toBe("Calories");
      expect(p.forProfile).toBe("Me");
      expect(p.values.mealType).toBe("snack");
      expect(p.values.calories).toBeGreaterThan(0);
      expect(p.values.calories).toBeLessThan(355);
    }
  });

  it("a single food, and a non-nutrition tracker, run as they were sent", async () => {
    expect(await splitCombinedFoodLog(call("Banana"), "ate a banana")).toBeNull();
    expect(await splitCombinedFoodLog(call("Mac and Cheese"), "ate mac and cheese")).toBeNull();
    expect(await splitCombinedFoodLog({ trackerName: "Running", values: { item: "5k + cooldown", distance: 3 } }, "ran")).toBeNull();
  });

  it("numbers the user read off a label are not divided by guesswork", async () => {
    expect(await splitCombinedFoodLog(call("Protein bar + shake"), "protein bar and shake, it says 355 calories total")).toBeNull();
  });
});

describe("the chat is told the same rule, and both doors apply the split", () => {
  const engine = readFileSync("server/ai-engine.ts", "utf8");
  it("the prompt says one food = one entry and no longer one meal = one entry", () => {
    expect(engine).toContain("ONE FOOD = ONE ENTRY");
    expect(engine).not.toContain("ONE MEAL = ONE ENTRY");
    expect(readFileSync("server/ai-bulk-log.ts", "utf8")).toContain("ONE operation PER food");
  });
  it("the tool loop and the bulk lane both split before executing", () => {
    expect(engine.match(/await splitCombinedFoodLog\(/g)?.length).toBe(2);
  });
});
