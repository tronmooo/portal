// One chat command about a debt changes ONE record, and changes it for real.
//
// 2026-11-19 (owner report):
//  • "Add my Wells Fargo mortgage … $2,155/mo due the 1st" created the
//    mortgage AND a second liability, "Wells Fargo Mortgage payment" (General).
//  • "I refinanced at 5.5%, new balance $300,000" answered "refinanced" while
//    the APR stayed 6.25% and the balance stayed $311,172.08: the new values
//    were written under alias keys, and the storage fold keeps the stored
//    canonical value when an alias disagrees with it.
//
// These drive the REAL executeTool dispatcher. The storage double applies the
// same canonical fold production applies on every profile write
// (resolveCanonicalFields), so a write that the fold would discard is
// discarded here too.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveCanonicalFields } from "../shared/entity-integrity";
import { readAnnualRate, readBalance, readOriginalBalance } from "../shared/liability-fields";

const SELF = { id: "p-self", name: "Tester", type: "self", fields: {} };

const db = {
  profiles: [] as any[],
  obligations: [] as any[],
  reseed() {
    this.obligations = [];
    this.profiles = [
      SELF,
      {
        id: "l-wf", name: "Wells Fargo Mortgage", type: "liability", type_key: "mortgage", tags: [], notes: "",
        fields: { balance: 311172.08, interestRate: 6.25, originalBalance: 312400, monthlyPayment: 2155, lender: "Wells Fargo" },
      },
    ];
  },
};

const fold = (fields: any) => resolveCanonicalFields(fields).fields;

vi.mock("../server/storage", () => {
  const explicit: Record<string, any> = {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find((r) => r.id === id),
    getSelfProfile: async () => SELF,
    createProfile: async (row: any) => {
      const p = { id: `l-${db.profiles.length + 1}`, tags: [], notes: "", ...row, fields: fold(row.fields || {}) };
      db.profiles.push(p);
      return p;
    },
    // Production semantics: a `fields` patch REPLACES the stored object, then
    // the alias fold runs over it.
    updateProfile: async (id: string, patch: any) => {
      const r = db.profiles.find((x) => x.id === id);
      if (!r) return undefined;
      const { fields, ...rest } = patch || {};
      Object.assign(r, rest);
      if (fields) r.fields = fold(fields);
      return r;
    },
    getObligations: async () => db.obligations,
    createObligation: async (row: any) => { const o = { id: `ob-${db.obligations.length + 1}`, ...row }; db.obligations.push(o); return o; },
  };
  // Anything else the tool touches on the way (links, history, memos) is
  // irrelevant to what these tests assert; it resolves to an empty list.
  const storage = new Proxy(explicit, {
    get: (t, k: string) => (k in t ? t[k] : k === "then" ? undefined : async () => []),
  });
  return { storage };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  db.reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

describe("create_liability creates the loan and nothing else", () => {
  it("a monthly payment and a due day do not spawn a second '… payment' record", async () => {
    const before = db.profiles.length;
    const res: any = await executeTool("create_liability", {
      name: "Chase Auto Loan", subtype: "auto_loan", lender: "Chase",
      currentBalance: 18000, annualRate: 6.25, monthlyPayment: 410, dueDay: 1,
      __userMessage: "Add my Chase auto loan, $18,000 at 6.25%, $410/mo due the 1st",
    }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.obligations).toEqual([]);
    const created = db.profiles.slice(before);
    expect(created.map((p) => p.name)).toEqual(["Chase Auto Loan"]);
    // The loan itself carries what the calendar needs.
    expect(Number(created[0].fields.dueDay)).toBe(1);
    expect(Number(created[0].fields.monthlyPayment)).toBe(410);
    // Stored as a percent: a stored 0.0625 printed as "0.1%" on the Overview.
    expect(created[0].fields.interestRate).toBe(6.25);
  });
});

describe("update_liability replaces the stored value", () => {
  const loan = () => db.profiles.find((p) => p.id === "l-wf");

  it("a refinance moves the rate, the balance and the original amount together", async () => {
    const res: any = await executeTool("update_liability", {
      name: "Wells Fargo Mortgage", refinance: true,
      changes: { annualRate: 5.5, currentBalance: 300000 },
    }, "u1");
    expect(res.error).toBeUndefined();
    expect(readAnnualRate(loan())).toBeCloseTo(0.055, 6);
    expect(loan().fields.interestRate).toBe(5.5);
    expect(readBalance(loan())).toBe(300000);
    expect(readOriginalBalance(loan())).toBe(300000);
    // Nothing was parked as a contradiction: the record says one thing.
    expect(loan().fields._integrity?.stale ?? {}).toEqual({});
  });

  it("a refinance that only changes the rate restarts the loan at the balance still owed", async () => {
    await executeTool("update_liability", { name: "Wells Fargo Mortgage", refinance: true, changes: { annualRate: 5.5 } }, "u1");
    expect(readAnnualRate(loan())).toBeCloseTo(0.055, 6);
    expect(readBalance(loan())).toBe(311172.08);
    expect(readOriginalBalance(loan())).toBe(311172.08);
  });

  it("a plain balance correction changes the balance and leaves the rate alone", async () => {
    await executeTool("update_liability", { name: "Wells Fargo Mortgage", changes: { currentBalance: 310000 } }, "u1");
    expect(readBalance(loan())).toBe(310000);
    expect(readAnnualRate(loan())).toBeCloseTo(0.0625, 6);
    expect(readOriginalBalance(loan())).toBe(312400);
  });
});
