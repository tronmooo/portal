// A payment the chat says it recorded IS recorded, and the balance it quotes
// is the stored one (Liabilities tutorial, 2026-11-20).
//
//  1. After a $95 payment on Chase Sapphire, "Paid $500 on my Chase Sapphire"
//     answered "New balance: $2,671.64" with a receipt card — and wrote
//     nothing. The pay pipeline treats the chat as automation, and automation
//     gets the idempotent answer on an occurrence that is already settled: the
//     first payment's row. Same on Discover: $100 worked, "another $50" the
//     same day vanished.
//  2. "$100 on Discover → new balance $1,150" while the record held $1,173.85:
//     the sentence was the model's own subtraction, ignoring the interest.
//
// These drive the REAL executeTool dispatcher and the real pay pipeline
// against an in-memory storage that implements the occurrence claim.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readBalance } from "../shared/liability-fields";
import { paymentReceiptLine, paymentNotRecordedLine, composePaymentReply } from "../shared/payment-receipt";

const SELF = { id: "p-self", name: "Tester", type: "self", fields: {} };
const db = { profiles: [] as any[], payments: [] as any[], seq: 0 };
const find = (id: string) => db.profiles.find((p) => p.id === id);
const mergeFields = (id: string, patch: Record<string, any>) => {
  const p = find(id);
  if (!p) return undefined;
  const fields = { ...(p.fields || {}) };
  for (const [k, v] of Object.entries(patch || {})) { if (v === null || v === undefined) delete fields[k]; else fields[k] = v; }
  p.fields = fields;
  return p;
};

vi.mock("../server/storage", () => {
  const explicit: Record<string, any> = {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => find(id),
    getSelfProfile: async () => SELF,
    updateProfile: async (id: string, patch: any) => mergeFields(id, patch?.fields || {}),
    mutateProfileFields: async (id: string, fn: (fresh: any) => any) => {
      const patch = fn(find(id));
      return patch ? mergeFields(id, patch.fields || {}) : find(id);
    },
    claimBillOccurrence: async (id: string, date: string, stamp: any, extra: any) => {
      const prior = { ...((find(id).fields || {}).occurrences || {}) };
      if (prior[date]?.status === "paid") return { status: "already-paid", occurrences: prior };
      mergeFields(id, { ...extra, occurrences: { ...prior, [date]: { ...(prior[date] || {}), ...stamp } } });
      return { status: "claimed", occurrences: prior };
    },
    createLiabilityPayment: async (data: any) => { const row = { id: data.id || `pay-${++db.seq}`, ...data }; db.payments.unshift(row); return row; },
    getLiabilityPayments: async (id: string) => db.payments.filter((p) => p.liabilityProfileId === id),
    getLiabilityPayment: async (id: string) => db.payments.find((p) => p.id === id),
    getObligations: async () => [],
    getExpenses: async () => [],
  };
  const storage = new Proxy(explicit, {
    get: (t, k: string) => (k in t ? t[k] : k === "then" ? undefined : async () => []),
  });
  return { storage };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  db.payments = []; db.seq = 0;
  db.profiles = [
    SELF,
    { id: "l-chase", name: "Chase Sapphire", type: "liability", type_key: "credit_card", tags: [], notes: "", fields: { balance: 3200, interestRate: 24.99, minimumPayment: 95, dueDay: 12 } },
    { id: "l-disc", name: "Discover It", type: "liability", type_key: "credit_card", tags: [], notes: "", fields: { balance: 1250, interestRate: 22.9, dueDay: 20 } },
  ];
  ({ executeTool } = await import("../server/ai-engine"));
});

const rowsOn = (id: string) => db.payments.filter((p) => p.liabilityProfileId === id);
const pay = (name: string, amount: number, msg: string) => executeTool("add_liability_payment", { liabilityName: name, amount, __userMessage: msg }, "u1");
/** Make every stamp on a liability look older than the double-call window. */
const age = (id: string, ms: number) => {
  const occ = { ...(find(id).fields.occurrences || {}) };
  for (const k of Object.keys(occ)) occ[k] = { ...occ[k], postedAt: new Date(Date.now() - ms).toISOString() };
  find(id).fields.occurrences = occ;
};

describe("a second chat payment the same day is its own payment", () => {
  it("$500 after a $95 payment is recorded and moves the balance", async () => {
    await pay("Chase Sapphire", 95, "Paid the $95 minimum on my Chase Sapphire");
    const afterFirst = readBalance(find("l-chase"));
    expect(rowsOn("l-chase")).toHaveLength(1);

    const res: any = await pay("Chase Sapphire", 500, "Paid $500 on my Chase Sapphire.");
    expect(res.error).toBeUndefined();
    expect(res.deduped).not.toBe(true);
    expect(rowsOn("l-chase")).toHaveLength(2);
    // Interest was charged once this month; the second payment is all principal.
    expect(readBalance(find("l-chase"))).toBeCloseTo(afterFirst - 500, 2);
  });

  it("'another $50' on Discover after $100 is recorded too", async () => {
    await pay("Discover It", 100, "Paid $100 on Discover");
    const afterFirst = readBalance(find("l-disc"));
    await pay("Discover It", 50, "another $50 on Discover");
    expect(rowsOn("l-disc")).toHaveLength(2);
    expect(readBalance(find("l-disc"))).toBeCloseTo(afterFirst - 50, 2);
  });

  it("the same amount again, minutes later, is a second payment", async () => {
    await pay("Discover It", 50, "Paid $50 on Discover");
    age("l-disc", 5 * 60_000);
    const res: any = await pay("Discover It", 50, "Paid another $50 on Discover");
    expect(res.deduped).not.toBe(true);
    expect(rowsOn("l-disc")).toHaveLength(2);
  });
});

describe("the model calling the tool twice for one payment is still one payment", () => {
  it("the same money seconds later is folded — and the reply says so instead of claiming a new balance", async () => {
    await pay("Discover It", 100, "Paid $100 on Discover");
    const balance = readBalance(find("l-disc"));
    const res: any = await pay("Discover It", 100, "Paid $100 on Discover");
    expect(rowsOn("l-disc")).toHaveLength(1);
    expect(readBalance(find("l-disc"))).toBe(balance);
    expect(res.deduped).toBe(true);
    // No "payment recorded" card for a payment that was not recorded.
    expect(res.actions).toEqual([]);
    expect(String(res.message)).toMatch(/No new payment was recorded/);
    expect(String(res.message)).toContain("$1,173.85");
  });
});

describe("the balance the chat quotes is the stored balance", () => {
  it("the tool's confirmation carries the read-back balance and the real split", async () => {
    const res: any = await pay("Discover It", 100, "Paid $100 on my Discover It");
    // 22.9% on $1,250 → $23.85 interest, $76.15 principal → $1,173.85.
    expect(readBalance(find("l-disc"))).toBe(1173.85);
    expect(res.result.balanceAfter).toBe(1173.85);
    expect(res.result.newBalance).toBe(1173.85);
    expect(res.result.paymentReceipt).toBe("Recorded $100.00 on Discover It — $76.15 to principal, $23.85 interest. Balance is now $1,173.85.");
  });

  it("the reply is built from that line; the model's own balance sentence is dropped", () => {
    const line = paymentReceiptLine({ liabilityName: "Discover It", amount: 100, principal: 76.15, interest: 23.85, balanceAfter: 1173.85 });
    const reply = composePaymentReply([line], "Payment recorded! Your new balance is $1,150.00. Nice work chipping away at it.");
    expect(reply).toContain("Balance is now $1,173.85.");
    expect(reply).not.toContain("1,150");
    expect(reply).toContain("Nice work chipping away at it.");
  });

  it("a reply that is only the model's claim becomes only the server's line", () => {
    const line = paymentReceiptLine({ liabilityName: "Chase Sapphire", amount: 500, principal: 500, interest: 0, balanceAfter: 2671.64 });
    expect(composePaymentReply([line], "New balance: $2,700.00")).toBe(line);
    expect(composePaymentReply([line], "Created liability.")).toBe(line);
    expect(line).toBe("Recorded $500.00 on Chase Sapphire. Balance is now $2,671.64.");
  });

  it("with no payment line the reply is untouched", () => {
    expect(composePaymentReply([], "Your balance is $5.")).toBe("Your balance is $5.");
  });

  it("a payment that was not written never reads as recorded", () => {
    const line = paymentNotRecordedLine("Discover It", 50, 1173.85);
    expect(line).toMatch(/^No new payment was recorded on Discover It/);
    expect(line).toContain("still $1,173.85");
  });
});
