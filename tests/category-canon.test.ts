// Pins the one category vocabulary.
//
// QA report 2026-07-25: "Assets, liabilities and subscriptions use
// inconsistent category names: Subscription and Subscription · Utility and
// Utilities · Liability and Other."
import { describe, it, expect } from "vitest";
import {
  canonicalExpenseCategory,
  canonicalObligationCategory,
  categoryLabel,
  isCanonicalExpenseCategory,
  isCanonicalObligationCategory,
  EXPENSE_CATEGORIES,
  OBLIGATION_CATEGORIES,
} from "../shared/category-canon";

describe("the reported duplicate buckets collapse to one", () => {
  it("folds Utility / Utilities / Electric into one bucket", () => {
    for (const raw of ["utility", "Utility", "utilities", "Utilities", "utility_bill", "Utility Bill", "electric", "water"]) {
      expect(canonicalExpenseCategory(raw)).toBe("utilities");
    }
    for (const raw of ["utility", "Utilities", "utility-plan"]) {
      expect(canonicalObligationCategory(raw)).toBe("utilities");
    }
  });

  it("folds Subscription / Subscriptions / Membership into one bucket", () => {
    for (const raw of ["subscription", "Subscription", "subscriptions", "Subscriptions", "membership", "Streaming"]) {
      expect(canonicalExpenseCategory(raw)).toBe("subscription");
      expect(canonicalObligationCategory(raw)).toBe("subscription");
    }
  });

  it("folds Liability and Other into General", () => {
    // "Liability" is a record type, never a category — writing it as one is
    // what put a "Liability" bucket next to "Other".
    for (const raw of ["liability", "Liability", "liabilities", "other", "Other", "misc", "uncategorized", ""]) {
      expect(canonicalExpenseCategory(raw)).toBe("general");
    }
  });
});

describe("canonicalExpenseCategory", () => {
  it("is idempotent — folding a canonical value changes nothing", () => {
    for (const c of EXPENSE_CATEGORIES) {
      expect(canonicalExpenseCategory(c)).toBe(c);
      expect(canonicalExpenseCategory(canonicalExpenseCategory(c))).toBe(c);
    }
  });

  it("always returns a value the schema union allows", () => {
    const inputs = ["utility", "groceries", "Auto", "rent", "??", null, undefined, 7, {}, "Vacation"];
    for (const raw of inputs) {
      expect(isCanonicalExpenseCategory(canonicalExpenseCategory(raw as any))).toBe(true);
    }
  });

  it("maps common phrasings to the right bucket", () => {
    expect(canonicalExpenseCategory("groceries")).toBe("food");
    expect(canonicalExpenseCategory("Restaurant")).toBe("food");
    expect(canonicalExpenseCategory("Auto")).toBe("vehicle");
    expect(canonicalExpenseCategory("rent")).toBe("housing");
    expect(canonicalExpenseCategory("vacation")).toBe("travel");
    expect(canonicalExpenseCategory("transportation")).toBe("transport");
  });
});

describe("canonicalObligationCategory", () => {
  it("is idempotent and stays inside its own vocabulary", () => {
    for (const c of OBLIGATION_CATEGORIES) {
      expect(canonicalObligationCategory(c)).toBe(c);
    }
    // "transport" is an EXPENSE category but not an obligation one — it must
    // fall back rather than be stored as a value the union forbids.
    expect(isCanonicalObligationCategory(canonicalObligationCategory("groceries"))).toBe(true);
    expect(canonicalObligationCategory("groceries")).toBe("general");
  });

  it("routes phone plans to communication", () => {
    expect(canonicalObligationCategory("phone bill")).toBe("communication");
    expect(canonicalObligationCategory("Verizon Phone Bill")).toBe("general"); // vendor name, not a category
    expect(canonicalObligationCategory("mobile")).toBe("communication");
  });
});

describe("categoryLabel", () => {
  it("derives one display string per canonical value", () => {
    expect(categoryLabel("utilities")).toBe("Utilities");
    expect(categoryLabel("subscription")).toBe("Subscription");
    expect(categoryLabel("general")).toBe("General");
    expect(categoryLabel("communication")).toBe("Phone & Internet");
  });

  it("gives the same label regardless of the input spelling", () => {
    const a = categoryLabel(canonicalExpenseCategory("Utility"));
    const b = categoryLabel(canonicalExpenseCategory("utilities"));
    expect(a).toBe(b);
  });
});
