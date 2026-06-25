// Regression tests for the "foods are never standalone trackers" rule.
//
// User report (2026-06-25): logging "Spinach Blueberry Banana Smoothie with
// Greek Yogurt and Honey" auto-created a standalone tracker for that one
// smoothie instead of logging it as an entry on the profile's Nutrition
// tracker. These tests pin the exact name that misrouted, plus the boundaries
// of the rule (generic Nutrition tracker still creatable; real non-food
// trackers untouched; supplements under `medication` not mistaken for meals).
import { describe, it, expect } from "vitest";
import { classifyNutritionAutoCreate } from "../shared/nutrition-shaped";

describe("classifyNutritionAutoCreate", () => {
  it("diverts the exact production name that caused the bug", () => {
    const v = classifyNutritionAutoCreate(
      "Spinach Blueberry Banana Smoothie with Greek Yogurt and Honey",
      "nutrition",
    );
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") {
      expect(v.nutrition.item).toBe(
        "Spinach Blueberry Banana Smoothie with Greek Yogurt and Honey",
      );
    }
  });

  it("diverts a food-shaped name even under a neutral/custom category", () => {
    for (const name of ["Chicken Caesar Salad", "Pepperoni Pizza", "Cheeseburger", "Blueberries"]) {
      expect(classifyNutritionAutoCreate(name, "custom").kind).toBe("divert");
      expect(classifyNutritionAutoCreate(name, undefined).kind).toBe("divert");
    }
  });

  it("diverts the 'X with Y and Z' composed-dish phrasing", () => {
    const v = classifyNutritionAutoCreate("Oatmeal with Almonds and Maple Syrup", "");
    expect(v.kind).toBe("divert");
  });

  it("ALLOWS the generic Nutrition / Calories tracker itself", () => {
    for (const name of ["Nutrition", "Calories", "Daily Nutrition", "Food Log", "Macros", "Caloric Intake", "Nutrients"]) {
      expect(classifyNutritionAutoCreate(name, "nutrition").kind).toBe("allow");
    }
  });

  it("does NOT divert real non-food trackers", () => {
    for (const [name, cat] of [
      ["Bench Press", "fitness"],
      ["Blood Pressure", "health"],
      ["Soccer", "fitness"],
      ["Chess", "custom"],
      ["Reading", "habit"],
      ["Net Worth", "finance"],
    ] as const) {
      expect(classifyNutritionAutoCreate(name, cat).kind).toBe("allow");
    }
  });

  it("does NOT mistake supplements/medications for meals", () => {
    // "Fish Oil" contains the food stem "fish" but is a supplement tracker.
    expect(classifyNutritionAutoCreate("Fish Oil", "medication").kind).toBe("allow");
    expect(classifyNutritionAutoCreate("Salmon Fishing Trips", "lifestyle").kind).toBe("allow");
  });

  it("title-cases an all-lowercase food name", () => {
    const v = classifyNutritionAutoCreate("greek yogurt", "nutrition");
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") expect(v.nutrition.item).toBe("Greek Yogurt");
  });

  it("handles empty / whitespace names gracefully", () => {
    expect(classifyNutritionAutoCreate("", "nutrition").kind).toBe("allow");
    expect(classifyNutritionAutoCreate("   ", undefined).kind).toBe("allow");
  });
});
