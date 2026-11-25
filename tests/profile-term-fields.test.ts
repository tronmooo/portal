// A loan's rate and its day of the month are refused when they are not one.
//
// Input variations, 2026-11-25 (production, smoke account): PATCH
// /api/profiles/:id stored a rate of -3 and of 5000, and a due day of 0 and
// of 32, on a loan. The payoff math and the schedule read those as numbers.
// A negative PAYMENT was already refused; the terms beside it were not.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProfileTermFields, validateProfileMoneyFields, MAX_INTEREST_RATE_PCT } from "../shared/quick-add";
import { startHarness, type Harness } from "./helpers/route-harness";

describe("validateProfileTermFields", () => {
  it("accepts the rates and days a loan can have", () => {
    for (const fields of [
      { interestRate: 0 }, { interestRate: 0.9 }, { interestRate: 29.99 }, { interestRate: "6.25%" },
      { interestRate: MAX_INTEREST_RATE_PCT }, { dueDay: 1 }, { dueDay: 31 }, { dueDay: "15" },
      { interestRate: "", dueDay: null }, {},
    ]) expect(validateProfileTermFields(fields), JSON.stringify(fields)).toBeNull();
  });

  it("refuses a rate that is negative, absurd or not a number", () => {
    expect(validateProfileTermFields({ interestRate: -3 })).toMatch(/interestRate cannot be negative/);
    expect(validateProfileTermFields({ interestRate: 5000 })).toMatch(/interestRate is too high/);
    expect(validateProfileTermFields({ interestRate: "low" })).toMatch(/interestRate must be a number/);
    expect(validateProfileTermFields({ apr: -1 })).toMatch(/apr cannot be negative/);
  });

  it("refuses a due day that is not a day of the month", () => {
    for (const dueDay of [0, 32, -1, 1.5, "soon", "2026-11-25"]) {
      expect(validateProfileTermFields({ dueDay }), String(dueDay)).toMatch(/dueDay must be a day of the month/);
    }
  });

  it("runs as part of the money check every profile route already calls", () => {
    expect(validateProfileMoneyFields({ balance: 100, interestRate: 5000 })).toMatch(/too high/);
    expect(validateProfileMoneyFields({ balance: 100, dueDay: 32 })).toMatch(/day of the month/);
    expect(validateProfileMoneyFields({ balance: 100, interestRate: 6.25, dueDay: 15 })).toBeNull();
  });
});

describe("the profile routes", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it("a loan cannot be created with a 5000% rate or a due day of 32", async () => {
    const rate = await h.api("POST", "/api/profiles", { type: "liability", name: "Loan A", fields: { balance: 5000, interestRate: 5000 } });
    expect(rate.status).toBe(400);
    expect(String(rate.data?.error)).toMatch(/interestRate is too high/);
    const day = await h.api("POST", "/api/profiles", { type: "liability", name: "Loan B", fields: { balance: 5000, dueDay: 32 } });
    expect(day.status).toBe(400);
    expect(h.db.profiles.filter((p) => /^Loan [AB]$/.test(p.name))).toHaveLength(0);
  });

  it("an edit to a bad rate or day is refused and the stored terms stay", async () => {
    const made = await h.api("POST", "/api/profiles", { type: "liability", name: "Loan C", fields: { balance: 5000, interestRate: 6.25, _interestRateUnit: "percent", dueDay: 15 } });
    expect(made.status).toBe(201);
    const id = made.data.id;
    for (const fields of [{ interestRate: -3 }, { interestRate: 5000 }, { dueDay: 0 }, { dueDay: 32 }]) {
      const r = await h.api("PATCH", `/api/profiles/${id}`, { fields });
      expect(r.status, JSON.stringify(fields)).toBe(400);
    }
    const stored = h.db.profiles.find((p) => p.id === id);
    expect(stored).toBeTruthy();
    expect(stored.fields.interestRate).toBe(6.25);
    expect(stored.fields.dueDay).toBe(15);
    const ok = await h.api("PATCH", `/api/profiles/${id}`, { fields: { interestRate: 7.5, _interestRateUnit: "percent", dueDay: 31 } });
    expect(ok.status).toBe(200);
  });
});
