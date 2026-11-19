// A month's interest is charged once, and "extra principal" is principal.
//
// 2026-11-19 (owner report): a $500 payment on a $3,200 card left $2,766.64,
// and every further payment the same day lost another month of interest;
// "Extra principal +$100" recorded payment + $100 with interest charged.
//
// Drives the real applyLiabilityPayment against a ledger double.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { applyLiabilityPayment } from "../server/liability-payments";
import { interestChargedInMonth } from "../shared/liability-calc";

function ledger(initial: any) {
  let liability = initial;
  const payments: any[] = [];
  const storage: any = {
    getLiabilityPayments: async (id: string) => payments.filter((p) => p.liabilityProfileId === id),
    createLiabilityPayment: async (data: any) => { const row = { id: `pay-${payments.length + 1}`, ...data }; payments.push(row); return row; },
    updateProfile: async (_id: string, patch: any) => {
      liability = { ...liability, ...patch, fields: { ...liability.fields, ...patch.fields } };
      return liability;
    },
  };
  return { storage, payments, current: () => liability };
}

const CARD = {
  id: "liab-card", name: "Chase Sapphire", type: "liability", type_key: "credit_card",
  fields: { currentBalance: 3200, interestRate: 24.99, minimumPayment: 35 },
};

describe("interest is charged once per month", () => {
  it("the first payment of the month carries the month's interest", async () => {
    const l = ledger(CARD);
    const out = await applyLiabilityPayment(l.storage, l.current(), { amount: 500, paymentDate: "2026-11-18" }, "UTC");
    expect(out.interest).toBeCloseTo(66.64, 2);
    expect(out.newBalance).toBeCloseTo(2766.64, 2);
  });

  it("a second payment the same day is all principal", async () => {
    const l = ledger(CARD);
    await applyLiabilityPayment(l.storage, l.current(), { amount: 500, paymentDate: "2026-11-18" }, "UTC");
    const second = await applyLiabilityPayment(l.storage, l.current(), { amount: 500, paymentDate: "2026-11-18" }, "UTC");
    expect(second.interest).toBe(0);
    expect(second.principal).toBe(500);
    expect(second.newBalance).toBeCloseTo(2266.64, 2);
    expect(l.payments.map((p) => p.interestPortion)).toEqual([66.64, 0]);
  });

  it("the next month charges interest again", async () => {
    const l = ledger(CARD);
    await applyLiabilityPayment(l.storage, l.current(), { amount: 500, paymentDate: "2026-11-18" }, "UTC");
    const dec = await applyLiabilityPayment(l.storage, l.current(), { amount: 500, paymentDate: "2026-12-18" }, "UTC");
    expect(dec.interest).toBeGreaterThan(50);
  });

  it("an extra-principal payment earlier in the month does not waive the regular payment's interest", async () => {
    const l = ledger(CARD);
    const extra = await applyLiabilityPayment(l.storage, l.current(), { amount: 100, paymentDate: "2026-11-02", paymentType: "extra_principal" }, "UTC");
    expect(extra.interest).toBe(0);
    expect(extra.newBalance).toBe(3100);
    const regular = await applyLiabilityPayment(l.storage, l.current(), { amount: 500, paymentDate: "2026-11-18" }, "UTC");
    expect(regular.interest).toBeCloseTo(64.56, 2);
  });

  it("a reversed payment's interest does not count as charged", () => {
    expect(interestChargedInMonth([{ paymentDate: "2026-11-18", interestPortion: 66.64, paymentType: "reversal" }], "2026-11-20")).toBe(false);
    expect(interestChargedInMonth([{ paymentDate: "2026-11-18", interestPortion: 66.64, paymentType: "standard" }], "2026-11-20")).toBe(true);
    expect(interestChargedInMonth([{ paymentDate: "2026-10-18", interestPortion: 66.64 }], "2026-11-20")).toBe(false);
  });
});

describe("the Extra principal preset on the liability page", () => {
  const src = readFileSync(resolve(__dirname, "../client/src/pages/liability-detail.tsx"), "utf8");
  it("posts the payment as extra_principal", () => {
    expect(src).toMatch(/paymentDialog\.preset === "extra" \? \{ paymentType: "extra_principal"/);
  });
  it("no longer prefills the regular payment plus $100", () => {
    expect(src).not.toMatch(/monthlyPayment \|\| 0\) \+ 100/);
  });
});
