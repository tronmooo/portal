// One debt is one record, and an edit the chat confirms is the edit that is
// stored (tutorial QA, 2026-11-18):
//
//   1. "Add my Wells Fargo mortgage … $2,155/mo" created TWO liabilities —
//      the mortgage and a separate "Wells Fargo Mortgage payment" bill.
//   2. "Refinanced to 5.5% on $305,000" was confirmed, and the record still
//      read 6.25% and $311,172.08: the tool wrote `annualInterestRate` /
//      `currentBalance` beside the canonical `interestRate` / `balance`, and
//      the storage fold keeps the canonical value when the two disagree.
//   3. A rate typed as 22.9% was saved as the model's 22.99.
//   4. The rate was stored as a decimal (0.0625) under a key whose canonical
//      form is a percent — one panel printed it as "0.1%".
//
// These drive the REAL executeTool dispatcher. The storage double runs the
// real write fold (prepareProfileFields + resolveCanonicalFields), because
// that fold is what made the refinance vanish.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prepareProfileFields } from "../shared/registry-fields";
import { resolveCanonicalFields } from "../shared/entity-integrity";
import { readInterestRatePct, readBalance, readOriginalBalance, statedRatePct } from "../shared/liability-fields";

const SELF = { id: "p-self", name: "Tester", type: "self", fields: {} };
const db = { profiles: [] as any[], obligations: [] as any[] };

const fold = (fields: Record<string, any>) => {
  const prepared = prepareProfileFields(fields);
  const resolved = resolveCanonicalFields(prepared, { at: "2026-11-18T00:00:00Z" });
  return resolved.changed ? resolved.fields : prepared;
};

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => [SELF, ...db.profiles],
    getProfile: async (id: string) => db.profiles.find((r) => r.id === id),
    getObligations: async () => db.obligations,
    createObligation: async (o: any) => { const row = { id: `ob-${db.obligations.length + 1}`, ...o }; db.obligations.push(row); return row; },
    createProfile: async (p: any) => { const row = { id: `l-${db.profiles.length + 1}`, tags: [], notes: "", ...p, fields: fold(p.fields || {}) }; db.profiles.push(row); return row; },
    updateProfile: async (id: string, patch: any) => {
      const r = db.profiles.find((x) => x.id === id);
      if (!r) return undefined;
      // A write supersedes every other spelling of the field (mergeFieldWrite).
      if (patch?.fields) r.fields = fold(patch.fields);
      if (patch?.type_key) r.type_key = patch.type_key;
      return r;
    },
    getLiabilityAssetLinks: async () => [], getLiabilityProfileLinks: async () => [], getAssetPartyLinks: async () => [],
    getHabits: async () => [], getTasks: async () => [], getGoals: async () => [], getEvents: async () => [],
    getTrackers: async () => [], getMemories: async () => [], getDocuments: async () => [],
    getJournalEntries: async () => [], getIncomes: async () => [], getExpenses: async () => [],
  },
}));

import { executeTool } from "../server/ai-engine";

const mortgage = () => db.profiles.find((p) => p.name === "Wells Fargo Mortgage");

beforeEach(() => { db.profiles = []; db.obligations = []; });

describe("create_liability", () => {
  const input = {
    name: "Wells Fargo Mortgage", subtype: "mortgage", lender: "Wells Fargo",
    currentBalance: 312400, originalBalance: 350000, annualRate: 6.25,
    monthlyPayment: 2155, dueDay: 1, remainingTermMonths: 360,
    __userMessage: "Add my Wells Fargo mortgage: $350,000 original, $312,400 balance, 6.25% APR, 30 years, $2,155/mo due on the 1st",
  };

  it("creates the mortgage and nothing else — no separate '<name> payment' bill", async () => {
    const res: any = await executeTool("create_liability", { ...input }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.profiles.map((p) => p.name)).toEqual(["Wells Fargo Mortgage"]);
    expect(db.obligations).toEqual([]);
    // The payment and its day live on the mortgage itself.
    expect(mortgage().fields.monthlyPayment).toBe(2155);
    expect(mortgage().fields.dueDay).toBe(1);
  });

  it("stores the rate as a percent, whichever form the model passed", async () => {
    await executeTool("create_liability", { ...input }, "u1");
    expect(mortgage().fields.interestRate).toBe(6.25);
    db.profiles = [];
    await executeTool("create_liability", { ...input, annualRate: 0.0625 }, "u1");
    expect(mortgage().fields.interestRate).toBe(6.25);
  });

  it("stores the rate the user typed, not a rounded-up neighbour", async () => {
    await executeTool("create_liability", {
      name: "Discover Card", subtype: "credit_card", currentBalance: 1800, annualRate: 22.99,
      __userMessage: "Add a Discover card with an $1,800 balance at 22.9%",
    }, "u1");
    expect(db.profiles[0].fields.interestRate).toBe(22.9);
  });
});

describe("update_liability — a refinance changes the stored record", () => {
  beforeEach(() => {
    db.profiles = [{
      id: "l-m", name: "Wells Fargo Mortgage", type: "liability", type_key: "mortgage", tags: [], notes: "",
      fields: { balance: 311172.08, originalBalance: 350000, interestRate: 6.25, monthlyPayment: 2155 },
    }];
  });

  it("applies the new rate and balance the chat confirmed", async () => {
    const res: any = await executeTool("update_liability", {
      name: "Wells Fargo Mortgage", refinance: true,
      changes: { annualRate: 5.5, currentBalance: 305000, monthlyPayment: 1731 },
      __userMessage: "I refinanced my Wells Fargo mortgage: new rate 5.5% on $305,000",
    }, "u1");
    expect(res.error).toBeUndefined();
    const f = mortgage().fields;
    expect(readInterestRatePct(f)).toBe(5.5);
    expect(readBalance(f)).toBe(305000);
    expect(readOriginalBalance(f)).toBe(305000);
    expect(f.monthlyPayment).toBe(1731);
    // One spelling per fact — no shadow copy left to disagree later.
    expect(f.interestRate).toBe(5.5);
    expect(f.balance).toBe(305000);
  });

  it("a plain balance correction lands too, on a record that uses the alias spelling", async () => {
    db.profiles[0].fields = { currentBalance: 311172.08, annualInterestRate: 0.0625 };
    await executeTool("update_liability", { name: "Wells Fargo Mortgage", changes: { currentBalance: 300000, annualRate: 0.06 } }, "u1");
    expect(readBalance(mortgage().fields)).toBe(300000);
    expect(readInterestRatePct(mortgage().fields)).toBe(6);
  });
});

describe("statedRatePct", () => {
  it("returns a percent for a decimal, a percent or a string", () => {
    expect(statedRatePct(0.0625)).toBe(6.25);
    expect(statedRatePct(6.25)).toBe(6.25);
    expect(statedRatePct("6.25%")).toBe(6.25);
    expect(statedRatePct(0)).toBe(0);
  });
  it("is null when no rate was given", () => {
    expect(statedRatePct(undefined)).toBeNull();
    expect(statedRatePct("")).toBeNull();
    expect(statedRatePct("unknown")).toBeNull();
  });
  it("keeps the model's rate when the message states a different, distant one", () => {
    expect(statedRatePct(5.5, "was 6.25%, now refinanced")).toBe(5.5);
    expect(statedRatePct(22.99, "22.9% APR")).toBe(22.9);
    expect(statedRatePct(22.9, "22.9% APR")).toBe(22.9);
  });
});
