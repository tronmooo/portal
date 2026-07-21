// Pins shared/profile-field-canon — the write-time canonicalization that stops
// asset/liability/profile records from accumulating redundant field variants
// ("value" + "marketValue" + "estimated_value" all meaning currentValue).
import { describe, it, expect } from "vitest";
import {
  canonicalizeProfileFields, sweepRedundantAliases, canonicalFieldKey, looselyEqual,
} from "../shared/profile-field-canon";

describe("canonicalFieldKey", () => {
  it("maps aliases to canonical camelCase keys", () => {
    expect(canonicalFieldKey("value")).toBe("currentValue");
    expect(canonicalFieldKey("market_value")).toBe("currentValue");
    expect(canonicalFieldKey("estimatedValue")).toBe("currentValue");
    expect(canonicalFieldKey("amount_owed")).toBe("balance");
    expect(canonicalFieldKey("loan_balance")).toBe("balance");
    expect(canonicalFieldKey("apr")).toBe("interestRate");
    expect(canonicalFieldKey("purchase_price")).toBe("purchasePrice");
  });
  it("leaves unknown keys untouched", () => {
    expect(canonicalFieldKey("vin")).toBe("vin");
    expect(canonicalFieldKey("breed")).toBe("breed");
  });
});

describe("looselyEqual", () => {
  it("compares currency strings and numbers numerically", () => {
    expect(looselyEqual("$26,000", 26000)).toBe(true);
    expect(looselyEqual("26000", "26,000")).toBe(true);
    expect(looselyEqual(26000, 25000)).toBe(false);
  });
  it("compares strings case-insensitively", () => {
    expect(looselyEqual("Toyota", "toyota")).toBe(true);
    expect(looselyEqual("Toyota", "Honda")).toBe(false);
  });
});

describe("canonicalizeProfileFields", () => {
  it("renames alias keys to canonical spellings", () => {
    const r = canonicalizeProfileFields({ value: 26000, loan_balance: 12000 });
    expect(r.fields).toEqual({ currentValue: 26000, balance: 12000 });
    expect(r.renamed).toEqual({ value: "currentValue", loan_balance: "balance" });
  });

  it("merges same-payload duplicates that agree, keeps conflicts", () => {
    const agree = canonicalizeProfileFields({ currentValue: 26000, value: "$26,000" });
    expect(agree.fields).toEqual({ currentValue: 26000 });
    expect(agree.dropped).toEqual(["value"]);

    const conflict = canonicalizeProfileFields({ currentValue: 26000, value: 31000 });
    expect(conflict.fields.currentValue).toBe(26000);
    expect(conflict.fields.value).toBe(31000); // never lose a differing value
  });

  it("adopts the existing record's spelling for case/format twins", () => {
    const r = canonicalizeProfileFields({ zip_code: "90210" }, { zipCode: "11111" });
    expect(r.fields).toEqual({ zipCode: "90210" });
  });

  it("passes through reserved and unknown keys", () => {
    const r = canonicalizeProfileFields({ _notes: "x", vin: "123" });
    expect(r.fields).toEqual({ _notes: "x", vin: "123" });
  });
});

describe("sweepRedundantAliases", () => {
  it("drops stale alias copies that equal the canonical value", () => {
    const r = sweepRedundantAliases({ currentValue: 26000, value: "$26,000", marketValue: 26000, vin: "123" });
    expect(r.fields).toEqual({ currentValue: 26000, vin: "123" });
    expect(r.removed.sort()).toEqual(["marketValue", "value"]);
  });

  it("keeps aliases whose values differ", () => {
    const r = sweepRedundantAliases({ currentValue: 26000, value: 31000 });
    expect(r.fields).toEqual({ currentValue: 26000, value: 31000 });
    expect(r.removed).toEqual([]);
  });

  it("drops empty alias copies", () => {
    const r = sweepRedundantAliases({ balance: 5000, amount_owed: "" });
    expect(r.fields).toEqual({ balance: 5000 });
  });

  it("does nothing without a canonical key present", () => {
    const r = sweepRedundantAliases({ value: 26000 });
    expect(r.fields).toEqual({ value: 26000 });
  });
});
