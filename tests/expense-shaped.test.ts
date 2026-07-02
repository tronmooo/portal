// Regression tests for the "trackers are never money" rule.
//
// User report (2026-06-10): "$400 car repairs for Ford F150" auto-created a
// "Vehicle Maintenance" tracker (category "custom") instead of only logging
// an expense on the F150 profile. These tests pin the exact production
// payloads that misrouted, plus the boundaries of the rule.
import { describe, it, expect } from "vitest";
import { classifyTrackerAutoCreate } from "../shared/expense-shaped";

describe("classifyTrackerAutoCreate", () => {
  it("diverts the exact production payload that caused the bug", () => {
    // Real entry_values from the live incident (tracker de6cec4c, 2026-05-22)
    const v = classifyTrackerAutoCreate(
      "Vehicle Maintenance",
      { cost: 400, date: "2026-05-21", vehicle: "Ford F150 2025", description: "Car repairs", serviceType: "repairs" },
      "$400 car repairs for Ford F150 2025",
    );
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") {
      expect(v.expense.amount).toBe(400);
      expect(v.expense.description).toBe("Car repairs");
      expect(v.expense.category).toBe("repair");
      expect(v.expense.profileHint).toBe("Ford F150 2025");
      expect(v.expense.date).toBe("2026-05-21");
    }
  });

  it("diverts the second production variant (mileage alongside cost)", () => {
    const v = classifyTrackerAutoCreate(
      "Vehicle Maintenance",
      { cost: 400, date: "2026-05-21", mileage: 60000, description: "Car repairs", maintenanceType: "repair" },
      "$400 car repairs",
    );
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") expect(v.expense.amount).toBe(400); // cost wins, not mileage
  });

  it("diverts any money-key value even with an innocent tracker name", () => {
    const v = classifyTrackerAutoCreate("Coffee", { cost: 5.5 }, "log my coffee");
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") expect(v.expense.amount).toBe(5.5);
  });

  it("pulls the amount from the message when values carry none", () => {
    const v = classifyTrackerAutoCreate("Repairs", { item: "brakes" } as any, "spent $1,250.50 on repairs");
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") expect(v.expense.amount).toBe(1250.5);
  });

  it("refuses an expense-flavored name with no usable amount (no off-category tracker)", () => {
    const v = classifyTrackerAutoCreate("Vehicle Maintenance", { mileage: 60000 }, "log maintenance for the truck");
    expect(v.kind).toBe("refuse");
  });

  it("allows genuinely non-monetary trackers", () => {
    expect(classifyTrackerAutoCreate("Running", { distance: 5, pace: 9.5 }, "ran 5 miles").kind).toBe("allow");
    expect(classifyTrackerAutoCreate("Sleep", { hours: 7.5 }, "slept 7.5 hours").kind).toBe("allow");
    expect(classifyTrackerAutoCreate("Blood Pressure", { systolic: 120, diastolic: 80 }, "bp 120/80").kind).toBe("allow");
  });

  it("does not misread plain numbers as money without a money key or currency", () => {
    // "Weight 215" — no $, no money key: must remain a tracker.
    expect(classifyTrackerAutoCreate("Weight", { weight: 215 }, "weight 215").kind).toBe("allow");
  });

  it("does not treat an ambiguous 'amount'/'total' quantity as money (Coffee 2 cups)", () => {
    // User report: "Coffee 2 cups" logged as {amount: 2} inside a big mixed
    // message that mentioned dollars elsewhere ($47.82) was wrongly diverted to
    // a $2 expense. An ambiguous key is money only when THAT figure is a $-amount.
    expect(classifyTrackerAutoCreate("Coffee", { amount: 2 }, "Coffee 2 cups; grocery $47.82 for Robert").kind).toBe("allow");
    expect(classifyTrackerAutoCreate("Walking", { total: 8600 }, "Walking 8,600 steps").kind).toBe("allow");
    expect(classifyTrackerAutoCreate("Water", { amount: 72 }, "Water 72 ounces").kind).toBe("allow");
  });

  it("still diverts an ambiguous key when the figure is an explicit dollar amount", () => {
    const v = classifyTrackerAutoCreate("Tip", { amount: 20 }, "gave a $20 tip");
    expect(v.kind).toBe("divert");
    if (v.kind === "divert") expect(v.expense.amount).toBe(20);
  });
});
