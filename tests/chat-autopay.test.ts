// Auto Pay from chat, through the REAL executeTool dispatcher.
//
// "Put my car loan on autopay", "my November car payment didn't go through",
// "the Verizon autopay went through", "I only paid $200" — each goes through
// the same operations the buttons use (server/autopay), applies to loans as
// well as bills, changes ONE payment and never the schedule, and answers from
// a read-back of what is stored (L2).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSchedule, deriveScheduleFields, nextDueOccurrence } from "../shared/liability-schedule";
import { resolveLiabilityBalance } from "../shared/asset-value";
import { isRecurringBillProfile } from "../shared/liability-types";

const h = vi.hoisted(() => ({ db: { profiles: [] as any[], payments: [] as any[], expenses: [] as any[], seq: 0 } }));

vi.mock("../server/storage", () => {
  const db = h.db;
  const find = (id: string) => db.profiles.find((p) => p.id === id);
  const mergeFields = (id: string, patch: Record<string, any>) => {
    const p = find(id);
    if (!p) return undefined;
    const fields = { ...(p.fields || {}) };
    for (const [k, v] of Object.entries(patch || {})) { if (v === null || v === undefined) delete fields[k]; else fields[k] = v; }
    p.fields = fields;
    return p;
  };
  const explicit: Record<string, any> = {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => find(id),
    getSelfProfile: async () => find("p-self"),
    updateProfile: async (id: string, patch: any) => mergeFields(id, patch?.fields || {}),
    // The pay pipeline moves a balance through this when the storage has it.
    mutateProfileFields: async (id: string, fn: (fresh: any) => any) => {
      const patch = fn(find(id));
      return patch ? mergeFields(id, patch.fields || {}) : find(id);
    },
    getObligations: async () => db.profiles.filter((p) => isRecurringBillProfile(p)).map((p) => ({ id: p.id, name: p.name, amount: p.fields.amount, frequency: p.fields.frequency, nextDueDate: p.fields.dueDate, linkedProfiles: ["p-self"] })),
    claimBillOccurrence: async (id: string, date: string, stamp: any, extra: any) => {
      const prior = { ...((find(id).fields || {}).occurrences || {}) };
      if (prior[date]?.status === "paid") return { status: "already-paid", occurrences: prior };
      mergeFields(id, { ...extra, occurrences: { ...prior, [date]: { ...(prior[date] || {}), ...stamp } } });
      return { status: "claimed", occurrences: prior };
    },
    updateOccurrenceOverride: async (id: string, date: string, patch: any) => {
      const occ = { ...((find(id).fields || {}).occurrences || {}) };
      const merged: any = { ...(occ[date] || {}), ...patch };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      occ[date] = merged;
      mergeFields(id, { occurrences: occ });
      return { id };
    },
    rescheduleOccurrence: async (id: string, date: string, to: string) => explicit.updateOccurrenceOverride(id, date, { movedTo: to }),
    getLiabilitySchedule: async (id: string) => {
      const p = find(id);
      if (!p) return null;
      const today = new Date().toISOString().slice(0, 10);
      const f = deriveScheduleFields(p.fields, p.type_key, today);
      const pays = db.payments.filter((x) => x.liabilityProfileId === id);
      const next = nextDueOccurrence({ id, fields: f }, pays, today);
      return {
        id, name: p.name,
        occurrences: generateSchedule({ id, fields: f }, pays, { todayISO: today, windowStart: "2026-09-01", windowEnd: "2027-06-30" }),
        nextDue: next ? { date: next.date, effectiveDate: next.effectiveDate, amount: next.amount } : null,
      };
    },
    createLiabilityPayment: async (data: any) => { const row = { id: data.id || `pay-${++db.seq}`, ...data }; db.payments.unshift(row); return row; },
    getLiabilityPayments: async (id: string) => db.payments.filter((p) => p.liabilityProfileId === id),
    getLiabilityPayment: async (id: string) => db.payments.find((p) => p.id === id),
    updateLiabilityPayment: async (id: string, patch: any) => { const r = db.payments.find((p) => p.id === id); if (r) Object.assign(r, patch); return r; },
    deleteLiabilityPayment: async (id: string) => { const n = db.payments.length; db.payments = db.payments.filter((p) => p.id !== id); return db.payments.length < n; },
    unmarkLoanPayment: async () => 0,
    adjustAccountBalance: async (id: string, input: any) => mergeFields(id, { balance: (Number(find(id).fields.balance) || 0) + (Number(input.delta) || 0) }),
    createExpense: async (data: any) => { const row = { id: `exp-${++db.seq}`, tags: [], linkedProfiles: [], ...data }; db.expenses.push(row); return row; },
    getExpenses: async () => db.expenses,
    updateExpense: async (id: string, patch: any) => { const e = db.expenses.find((x) => x.id === id); if (e) Object.assign(e, patch); return e; },
    deleteExpense: async (id: string) => { const n = db.expenses.length; db.expenses = db.expenses.filter((e) => e.id !== id); return db.expenses.length < n; },
    getTasks: async () => [],
  };
  const storage = new Proxy(explicit, { get: (t, k: string) => (k in t ? t[k] : k === "then" ? undefined : async () => []) });
  return { storage };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
let runAutopayForLiability: typeof import("../server/autopay").runAutopayForLiability;
let storage: any;

const seed = () => [
  { id: "p-self", name: "Tester", type: "self", fields: {} },
  { id: "loan-car", name: "Honda CR-V Loan", type: "liability", type_key: "auto_loan", fields: { currentBalance: 15_000, interestRate: 6, monthlyPayment: 400, dueDay: 15 } },
  { id: "bill-phone", name: "Verizon Wireless", type: "liability", type_key: "phone_plan", parentProfileId: "p-self", fields: { amount: 85, frequency: "monthly", dueDate: "2026-11-20", firstPaymentDate: "2026-08-20" } },
  { id: "acct-1", name: "Chase Checking", type: "account", type_key: "checking", fields: { accountKind: "checking", balance: 5_000 } },
];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T18:00:00Z"));
  h.db.profiles = seed(); h.db.payments = []; h.db.expenses = []; h.db.seq = 0;
  ({ executeTool } = await import("../server/ai-engine") as any);
  ({ runAutopayForLiability } = await import("../server/autopay"));
  ({ storage } = await import("../server/storage") as any);
});
afterEach(() => { vi.useRealTimers(); });

const profile = (id: string) => h.db.profiles.find((p) => p.id === id);
/** The daily job, for one liability, on one day. */
const cron = async (id: string, day: string) => runAutopayForLiability(storage, profile(id), day, "UTC");

describe("chat: the Auto Pay setting", () => {
  it("'put my car loan on autopay' switches it on for a LOAN, stamped with the day", async () => {
    const res: any = await executeTool("update_obligation", { name: "Honda CR-V", autopay: true, __userMessage: "put my Honda CR-V loan on autopay" }, "u1");
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ updated: true, action: "autopay", autopay: true, name: "Honda CR-V Loan" });
    const f = profile("loan-car").fields;
    expect(f.autopay).toBe(true);
    expect(f.autoPay).toBe(true);
    expect(f.autoRecordSince).toBe("2026-11-20");
    // The terms of the loan were not touched.
    expect(f).toMatchObject({ monthlyPayment: 400, dueDay: 15, currentBalance: 15_000 });
    expect(h.db.profiles).toHaveLength(4); // no second record
  });

  it("names the paying account, and refuses one that does not exist", async () => {
    const ok: any = await executeTool("update_obligation", { name: "Verizon", autopay: true, autopayFromAccount: "Chase" }, "u1");
    expect(ok).toMatchObject({ autopay: true, autopayFrom: "Chase Checking" });
    expect(profile("bill-phone").fields.autopayAccountId).toBe("acct-1");
    const bad: any = await executeTool("update_obligation", { name: "Verizon", autopayFromAccount: "Wells" }, "u1");
    expect(bad.error).toMatch(/couldn't find an account matching "Wells"/);
  });

  it("'turn off autopay' stops recording and keeps the history", async () => {
    await executeTool("update_obligation", { name: "Verizon", autopay: true }, "u1");
    profile("bill-phone").fields.autoRecordSince = "2026-11-01";
    expect((await cron("bill-phone", "2026-11-20"))?.ok).toBe(true);
    const res: any = await executeTool("update_obligation", { name: "Verizon", autopay: false }, "u1");
    expect(res).toMatchObject({ action: "autopay", autopay: false });
    expect(await cron("bill-phone", "2026-12-20")).toBeNull();
    expect(h.db.payments).toHaveLength(1);
    expect(h.db.expenses).toHaveLength(1);
  });

  it("the legacy changes.autopay spelling goes through the same door", async () => {
    const res: any = await executeTool("update_obligation", { name: "Verizon", changes: { autopay: true } }, "u1");
    expect(res).toMatchObject({ action: "autopay", autopay: true });
    expect(profile("bill-phone").fields.autoRecordSince).toBe("2026-11-20");
  });

  it("an unknown name is an error, not a new record", async () => {
    const res: any = await executeTool("update_obligation", { name: "Boat loan", autopay: true }, "u1");
    expect(res.error).toBeTruthy();
    expect(h.db.profiles).toHaveLength(4);
  });
});

describe("chat: one payment's status", () => {
  beforeEach(async () => {
    for (const id of ["loan-car", "bill-phone"]) Object.assign(profile(id).fields, { autopay: true, autoPay: true, autoRecordSince: "2026-11-01" });
    await cron("loan-car", "2026-11-15");
    await cron("bill-phone", "2026-11-20");
  });

  it("'my car payment didn't go through' reverses the assumed payment and answers from the stored record", async () => {
    expect(resolveLiabilityBalance(profile("loan-car"))).toBe(14_675);
    const res: any = await executeTool("update_obligation", { name: "Honda CR-V Loan", paymentStatus: "missed", occurrenceDate: "2026-11" }, "u1");
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ action: "payment_status", balance: 15_000 });
    expect(res.payment).toMatchObject({ date: "2026-11-15", status: "missed", reversed: true });
    expect(h.db.payments.filter((p) => p.liabilityProfileId === "loan-car")).toHaveLength(0);
    expect(h.db.expenses.filter((e) => e.tags.includes("liability:loan-car"))).toHaveLength(0);
    // The schedule is untouched and December is recorded as usual.
    expect(profile("loan-car").fields).toMatchObject({ monthlyPayment: 400, dueDay: 15, autopay: true });
    expect((await cron("loan-car", "2026-12-15"))?.ok).toBe(true);
  });

  it("'last' is the most recent recorded payment; 'it wasn't missed after all' reopens it", async () => {
    const missed: any = await executeTool("update_obligation", { name: "Verizon", paymentStatus: "missed" }, "u1");
    expect(missed.payment).toMatchObject({ date: "2026-11-20", status: "missed" });
    const back: any = await executeTool("update_obligation", { name: "Verizon", paymentStatus: "scheduled" }, "u1");
    expect(back.error).toBeUndefined();
    expect(back.payment.date).toBe("2026-11-20");
    expect(profile("bill-phone").fields.occurrences["2026-11-20"].status).toBeUndefined();
  });

  it("'the Verizon autopay went through' confirms the one payment", async () => {
    const res: any = await executeTool("update_obligation", { name: "Verizon", paymentStatus: "confirmed" }, "u1");
    expect(res.payment).toMatchObject({ date: "2026-11-20", status: "confirmed_paid", reversed: false });
    expect(h.db.payments.filter((p) => p.liabilityProfileId === "bill-phone")).toHaveLength(1);
    expect(h.db.expenses.find((e) => e.tags.includes("liability:bill-phone")).tags).not.toContain("autopay:assumed");
  });

  it("'I only paid $200 of the car payment' records a partial and moves the balance by its principal", async () => {
    const res: any = await executeTool("update_obligation", { name: "Honda CR-V", paymentStatus: "partial", partialAmount: 200 }, "u1");
    expect(res.payment).toMatchObject({ date: "2026-11-15", status: "partial", amount: 200 });
    expect(res.balance).toBe(14_875);
    expect(h.db.payments.filter((p) => p.liabilityProfileId === "loan-car")).toHaveLength(1);
    expect(profile("loan-car").fields.monthlyPayment).toBe(400);
  });

  it("partial without an amount, and a date with no payment, are questions, not writes", async () => {
    const noAmount: any = await executeTool("update_obligation", { name: "Honda CR-V", paymentStatus: "partial" }, "u1");
    expect(noAmount.error).toMatch(/how much was actually paid/);
    const noDate: any = await executeTool("update_obligation", { name: "Honda CR-V", paymentStatus: "missed", occurrenceDate: "2024-01" }, "u1");
    expect(noDate.error).toMatch(/couldn't find a Honda CR-V Loan payment/);
    expect(h.db.payments).toHaveLength(2);
  });
});
