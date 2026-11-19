// "Add my auto loan … and its $553 payment due the 15th" is ONE liability.
//
// Rule L1 (CLAUDE.md). create_liability no longer spawns a "<name> payment"
// bill, but the model can still ask for that bill itself with
// create_obligation — and that door stored a second liability card under the
// loan's own name (owner report, 2026-11-19: "when I say an auto loan and a
// payment … only one liability, not two different cards").
//
// These drive the REAL executeTool dispatcher, in every order the model can
// emit the two calls.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveCanonicalFields } from "../shared/entity-integrity";
import { readMonthlyPayment, readBalance } from "../shared/liability-fields";
import { isLiabilityTabProfile } from "../shared/asset-value";

const SELF = { id: "p-self", name: "Tester", type: "self", fields: {} };
const db = { profiles: [] as any[] };
const fold = (fields: any) => resolveCanonicalFields(fields).fields;

vi.mock("../server/storage", () => {
  const createProfile = async (row: any) => {
    const p = { id: `l-${db.profiles.length + 1}`, tags: [], notes: "", ...row, fields: fold(row.fields || {}) };
    db.profiles.push(p);
    return p;
  };
  const explicit: Record<string, any> = {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find((r) => r.id === id),
    getSelfProfile: async () => SELF,
    createProfile,
    updateProfile: async (id: string, patch: any) => {
      const r = db.profiles.find((x) => x.id === id);
      if (!r) return undefined;
      const { fields, ...rest } = patch || {};
      Object.assign(r, rest);
      if (fields) r.fields = fold(fields);
      return r;
    },
    // What production does with a bill: it IS a liability profile.
    getObligations: async () => db.profiles.filter((p) => p.type_key === "bill").map((p) => ({ id: p.id, name: p.name, amount: p.fields.amount, frequency: p.fields.frequency, linkedProfiles: [SELF.id] })),
    createObligation: async (row: any) => {
      const p = await createProfile({ name: row.name, type: "liability", type_key: "bill", parentProfileId: SELF.id, fields: { amount: row.amount, monthlyPayment: row.amount, frequency: row.frequency || "monthly", dueDate: row.nextDueDate, source: "obligation" } });
      return { id: p.id, name: p.name, amount: row.amount, frequency: row.frequency || "monthly", nextDueDate: row.nextDueDate, linkedProfiles: [SELF.id] };
    },
    getObligation: async (id: string) => db.profiles.find((p) => p.id === id),
  };
  const storage = new Proxy(explicit, {
    get: (t, k: string) => (k in t ? t[k] : k === "then" ? undefined : async () => []),
  });
  return { storage };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
let toolInterferenceKey: (t: { id: string; name: string; input?: any }) => string;
beforeEach(async () => {
  db.profiles = [SELF];
  ({ executeTool, toolInterferenceKey } = await import("../server/ai-engine") as any);
});

const MSG = "Add my Honda Civic auto loan: $21,500 balance at 6.5%, and the payment is $553.12 a month due on the 15th";
const LOAN = { name: "Honda Civic Loan", subtype: "auto_loan", currentBalance: 21500, annualRate: 6.5, __userMessage: MSG };
const PAYMENT = { name: "Honda Civic Loan payment", amount: 553.12, frequency: "monthly", nextDueDate: "2026-12-15", __userMessage: MSG };

/** Every card the Liabilities tab would draw. */
const cards = () => db.profiles.filter((p) => isLiabilityTabProfile(p));

describe("an auto loan and its payment are one liability card", () => {
  it("loan first, then a bill for its payment → still one card, payment stored on the loan", async () => {
    await executeTool("create_liability", { ...LOAN }, "u1");
    const res: any = await executeTool("create_obligation", { ...PAYMENT }, "u1");
    expect(res.error).toBeUndefined();
    expect(cards().map((p) => p.name)).toEqual(["Honda Civic Loan"]);
    const loan = cards()[0];
    expect(loan.type_key).toBe("auto_loan");
    expect(readMonthlyPayment(loan.fields)).toBe(553.12);
    expect(loan.fields.dueDay).toBe(15);
    expect(readBalance(loan.fields)).toBe(21500);
    expect(String(res.message)).toMatch(/one liability/i);
  });

  it("the bill first, then the loan → still one card, and it is the loan", async () => {
    await executeTool("create_obligation", { ...PAYMENT }, "u1");
    await executeTool("create_liability", { ...LOAN, monthlyPayment: 553.12, dueDay: 15 }, "u1");
    expect(cards().map((p) => p.name)).toEqual(["Honda Civic Loan"]);
    const loan = cards()[0];
    expect(loan.type_key).toBe("auto_loan");
    expect(readBalance(loan.fields)).toBe(21500);
    expect(readMonthlyPayment(loan.fields)).toBe(553.12);
  });

  it("the loan alone, with its payment and due day → one card", async () => {
    await executeTool("create_liability", { ...LOAN, monthlyPayment: 553.12, dueDay: 15 }, "u1");
    expect(cards().map((p) => p.name)).toEqual(["Honda Civic Loan"]);
  });

  it("a later 'the car payment is $560 now' updates the loan instead of adding a bill", async () => {
    await executeTool("create_liability", { ...LOAN, monthlyPayment: 553.12, dueDay: 15 }, "u1");
    await executeTool("create_obligation", { name: "Honda Civic Loan payment", amount: 560, frequency: "monthly" }, "u1");
    expect(cards()).toHaveLength(1);
    expect(readMonthlyPayment(cards()[0].fields)).toBe(560);
    expect(cards()[0].fields.dueDay).toBe(15);
  });

  it("a one-time 'payment' bill on a debt is refused toward add_liability_payment, not stored as a second card", async () => {
    await executeTool("create_liability", { ...LOAN }, "u1");
    const res: any = await executeTool("create_obligation", { name: "Honda Civic Loan payment", amount: 553.12, frequency: "once" }, "u1");
    expect(String(res.error)).toMatch(/add_liability_payment/);
    expect(cards()).toHaveLength(1);
  });

  it("the two creates take turns in one model round (same interference key)", () => {
    const a = toolInterferenceKey({ id: "1", name: "create_liability", input: LOAN });
    const b = toolInterferenceKey({ id: "2", name: "create_obligation", input: PAYMENT });
    expect(a).toBe(b);
  });
});

describe("an ordinary bill is unaffected", () => {
  it("a phone bill is still created as its own bill", async () => {
    await executeTool("create_liability", { ...LOAN }, "u1");
    await executeTool("create_obligation", { name: "Phone Bill", amount: 86.5, frequency: "monthly", nextDueDate: "2026-12-05" }, "u1");
    expect(cards().map((p) => p.name).sort()).toEqual(["Honda Civic Loan", "Phone Bill"]);
  });
});
