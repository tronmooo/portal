// Auto Pay, scenario sweep (2026-11-20): every shape of liability and every
// way a person can interfere with a payment Auto Pay recorded. Each case runs
// the real pay pipeline over the shared storage double.
import { describe, it, expect } from "vitest";
import { fakeStorage } from "./helpers/autopay-storage";
import { runAutopayForLiability, setAutoPay, setOccurrenceStatus, reconcileBankTransaction } from "../server/autopay";
import { payBillOccurrence, unpayBillOccurrence, retractPaymentOfExpense, repriceBillPayment } from "../server/liability-payments";
import { occurrencePaymentStatus, missedPayments, wantsDueReminders } from "../shared/autopay";
import { nextLoanDueDate } from "../shared/loan-facts";
import { resolveLiabilityBalance } from "../shared/asset-value";
import { computeNetWorth } from "../shared/net-worth";

const ON = { autopay: true, autoPay: true, autoRecordSince: "2026-11-01" };
const run = async (storage: any, id: string, today: string) => runAutopayForLiability(storage, await storage.getProfile(id), today, "UTC");
const paymentsOf = (storage: any, id: string) => storage.payments.filter((p: any) => p.liabilityProfileId === id);
const expensesOf = (storage: any, id: string) => storage.expenses.filter((e: any) => e.tags.includes(`liability:${id}`));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const CARD = { id: "card", name: "Chase Sapphire", type: "liability", type_key: "credit_card", fields: { currentBalance: 2_000, interestRate: 24, monthlyPayment: 100, dueDay: 10, ...ON } };
const LOAN = { id: "loan", name: "Honda CR-V Loan", type: "liability", type_key: "auto_loan", fields: { currentBalance: 15_000, interestRate: 6, monthlyPayment: 400, dueDay: 15, ...ON } };
const BILL = { id: "bill", name: "Verizon Wireless", type: "liability", type_key: "phone_plan", parentProfileId: "me", fields: { amount: 85, frequency: "monthly", dueDate: "2026-11-10", firstPaymentDate: "2026-11-10", ...ON } };
const CHECKING = { id: "acct", name: "Checking", type: "account", type_key: "checking", fields: { accountKind: "checking", balance: 5_000 } };

describe("every kind of liability", () => {
  it("credit card: the minimum payment splits into interest (expense) and principal (balance)", async () => {
    const s = fakeStorage([CARD]);
    await run(s, "card", "2026-11-10");
    expect(s.payments[0]).toMatchObject({ amount: 100, interestPortion: 40, principalPortion: 60 });
    expect(resolveLiabilityBalance(await s.getProfile("card"))).toBe(1_940);
    expect(s.expenses.map((e: any) => e.amount)).toEqual([40]);
  });

  it("a 0% loan: the whole payment is principal and there is no expense", async () => {
    const zero = clone(LOAN); zero.fields.interestRate = 0;
    const s = fakeStorage([zero]);
    await run(s, "loan", "2026-11-15");
    expect(s.payments[0]).toMatchObject({ amount: 400, interestPortion: 0, principalPortion: 400 });
    expect(s.expenses).toHaveLength(0);
    expect(resolveLiabilityBalance(await s.getProfile("loan"))).toBe(14_600);
  });

  it("a one-time debt is recorded once and never again", async () => {
    const medical = { id: "med", name: "ER visit", type: "liability", type_key: "medical_debt", fields: { currentBalance: 500, monthlyPayment: 500, dueDate: "2026-11-12", ...ON } };
    const s = fakeStorage([medical]);
    expect(await run(s, "med", "2026-11-11")).toBeNull();
    expect((await run(s, "med", "2026-11-12"))?.ok).toBe(true);
    for (const day of ["2026-11-13", "2026-12-12", "2027-01-12"]) expect(await run(s, "med", day)).toBeNull();
    expect(s.payments).toHaveLength(1);
    expect(resolveLiabilityBalance(await s.getProfile("med"))).toBe(0);
  });

  for (const [frequency, next] of [["weekly", "2026-11-17"], ["biweekly", "2026-11-24"], ["quarterly", "2027-02-10"], ["yearly", "2027-11-10"]] as const) {
    it(`a ${frequency} bill is recorded once per cycle and moves to ${next}`, async () => {
      const bill = clone(BILL); bill.fields.frequency = frequency;
      const s = fakeStorage([bill]);
      await run(s, "bill", "2026-11-10");
      await run(s, "bill", "2026-11-11");
      expect(s.payments).toHaveLength(1);
      expect((await s.getProfile("bill")).fields.dueDate).toBe(next);
      expect(await run(s, "bill", "2026-11-16")).toBeNull();
      expect((await run(s, "bill", next))?.ok).toBe(true);
      expect(s.payments).toHaveLength(2);
    });
  }

  it("a usage-based bill records the month's real total, and next month its base", async () => {
    const usage = { id: "ai", name: "ChatGPT", type: "liability", type_key: "subscription", parentProfileId: "me", fields: { amount: 20, frequency: "monthly", dueDate: "2026-11-10", firstPaymentDate: "2026-11-10", billingModel: "usage_based", occurrences: { "2026-11-10": { charges: [{ id: "c1", kind: "usage", amount: 22 }] } }, ...ON } };
    const s = fakeStorage([usage]);
    await run(s, "ai", "2026-11-10");
    await run(s, "ai", "2026-12-10");
    expect(paymentsOf(s, "ai").map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([20, 42]);
  });

  it("a one-time amount override applies to that month only", async () => {
    const bill = clone(BILL); bill.fields.occurrences = { "2026-11-10": { amount: 95 } };
    const s = fakeStorage([bill]);
    await run(s, "bill", "2026-11-10");
    await run(s, "bill", "2026-12-10");
    expect(s.payments.map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([85, 95]);
    expect((await s.getProfile("bill")).fields.amount).toBe(85);
  });

  it("a finite plan stops after its last instalment", async () => {
    const plan = clone(BILL); plan.fields.count = 2;
    const s = fakeStorage([plan]);
    for (const day of ["2026-11-10", "2026-12-10", "2027-01-10", "2027-02-10"]) await run(s, "bill", day);
    expect(s.payments).toHaveLength(2);
  });

  it("a paused bill records nothing; resumed, it records again", async () => {
    const paused = clone(BILL); paused.fields.paused = true; paused.fields.status = "paused";
    const s = fakeStorage([paused]);
    expect(await run(s, "bill", "2026-11-10")).toBeNull();
    await s.updateProfile("bill", { fields: { paused: false, status: "upcoming" } });
    expect((await run(s, "bill", "2026-11-10"))?.ok).toBe(true);
  });

  it("due on the 31st: recorded on the last day of short months, back on the 31st after", async () => {
    const eom = clone(LOAN); eom.fields.dueDay = 31; eom.fields.interestRate = 0;
    const s = fakeStorage([eom]);
    expect(await run(s, "loan", "2026-11-29")).toBeNull();
    for (const day of ["2026-11-30", "2026-12-30", "2026-12-31", "2027-01-31", "2027-02-27", "2027-02-28"]) await run(s, "loan", day);
    expect(s.payments.map((p: any) => p.paymentDate).sort()).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("a bill due on the 31st keeps the 31st through a short month", async () => {
    const eom = clone(BILL); eom.fields.dueDate = "2026-10-31"; eom.fields.firstPaymentDate = "2026-10-31"; eom.fields.autoRecordSince = "2026-10-01";
    const s = fakeStorage([eom]);
    for (const day of ["2026-10-31", "2026-11-30", "2026-12-31"]) expect((await run(s, "bill", day))?.ok, day).toBe(true);
    expect(s.payments.map((p: any) => p.paymentDate).sort()).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
  });
});

describe("a person pays, edits or removes something Auto Pay touches", () => {
  it("a bill paid by hand before its due day is not recorded again", async () => {
    const s = fakeStorage([BILL]);
    await payBillOccurrence(s, "bill", { occurrenceDate: "2026-11-10", paymentDate: "2026-11-08", source: "occurrence_route" }, "UTC");
    expect(await run(s, "bill", "2026-11-10")).toBeNull();
    expect((await run(s, "bill", "2026-12-10"))?.ok).toBe(true);
    expect(s.payments).toHaveLength(2);
  });

  it("a loan payment made by hand a week early covers that cycle", async () => {
    const s = fakeStorage([LOAN]);
    await payBillOccurrence(s, "loan", { amount: 400, paymentDate: "2026-11-08", source: "route" }, "UTC");
    expect(await run(s, "loan", "2026-11-15")).toBeNull();
    expect((await run(s, "loan", "2026-12-15"))?.ok).toBe(true);
    expect(s.payments).toHaveLength(2);
  });

  it("an EXTRA principal payment is not the month's instalment: Auto Pay still records it", async () => {
    const s = fakeStorage([LOAN]);
    await payBillOccurrence(s, "loan", { amount: 1_000, paymentDate: "2026-11-05", paymentType: "extra_principal", source: "route" }, "UTC");
    expect(nextLoanDueDate((await s.getProfile("loan")).fields, "2026-11-06")).toBe("2026-11-15");
    expect((await run(s, "loan", "2026-11-15"))?.ok).toBe(true);
    expect(s.payments).toHaveLength(2);
    // Interest on the balance AFTER the extra payment: 14,000 × 0.5%.
    expect(s.payments.find((p: any) => p.paymentDate === "2026-11-15")).toMatchObject({ amount: 400, interestPortion: 70, principalPortion: 330 });
    expect(nextLoanDueDate((await s.getProfile("loan")).fields, "2026-11-16")).toBe("2026-12-15");
  });

  it("an extra payment AFTER the instalment does not hide next month's", async () => {
    const s = fakeStorage([LOAN]);
    await run(s, "loan", "2026-11-15");
    await payBillOccurrence(s, "loan", { amount: 500, paymentDate: "2026-11-20", paymentType: "extra_principal", source: "route" }, "UTC");
    expect(nextLoanDueDate((await s.getProfile("loan")).fields, "2026-11-21")).toBe("2026-12-15");
    expect((await run(s, "loan", "2026-12-15"))?.ok).toBe(true);
    expect(s.payments).toHaveLength(3);
  });

  it("REVERSING a payment Auto Pay recorded sticks: the next run does not put it back", async () => {
    const s = fakeStorage([LOAN, BILL]);
    const loanPay = await run(s, "loan", "2026-11-15");
    const billPay = await run(s, "bill", "2026-11-10");
    await unpayBillOccurrence(s, "loan", { paymentId: loanPay!.payment.id, source: "route" }, "UTC");
    await unpayBillOccurrence(s, "bill", { paymentId: billPay!.payment.id, source: "route" }, "UTC");
    expect(s.payments).toHaveLength(0);
    expect(s.expenses).toHaveLength(0);
    expect(resolveLiabilityBalance(await s.getProfile("loan"))).toBe(15_000);
    for (const day of ["2026-11-15", "2026-11-16", "2026-11-25"]) {
      expect(await run(s, "loan", day), `loan ${day}`).toBeNull();
      expect(await run(s, "bill", day), `bill ${day}`).toBeNull();
    }
    // It reads as missed (a decision is still owed), and next month is recorded.
    expect(missedPayments((await s.getProfile("loan")).fields, "2026-11-20")).toEqual([{ date: "2026-11-15", amount: 400 }]);
    expect(missedPayments((await s.getProfile("bill")).fields, "2026-11-20")).toEqual([{ date: "2026-11-10", amount: 85 }]);
    expect((await run(s, "loan", "2026-12-15"))?.ok).toBe(true);
    expect((await run(s, "bill", "2026-12-10"))?.ok).toBe(true);
    expect(s.payments).toHaveLength(2);
  });

  it("DELETING the expense of an auto-recorded bill payment sticks too", async () => {
    const s = fakeStorage([BILL]);
    await run(s, "bill", "2026-11-10");
    const out = await retractPaymentOfExpense(s, s.expenses[0], "UTC");
    expect(out?.ok).toBe(true);
    expect(s.payments).toHaveLength(0);
    expect(s.expenses).toHaveLength(0);
    expect(await run(s, "bill", "2026-11-11")).toBeNull();
    expect((await s.getProfile("bill")).fields.dueDate).toBe("2026-12-10");
  });

  it("reversing a payment the USER recorded just reopens it (no missed mark)", async () => {
    const manual = clone(BILL); manual.fields.autopay = false; manual.fields.autoPay = false;
    const s = fakeStorage([manual]);
    const paid = await payBillOccurrence(s, "bill", { occurrenceDate: "2026-11-10", source: "occurrence_route" }, "UTC");
    await unpayBillOccurrence(s, "bill", { paymentId: paid.payment.id, source: "route" }, "UTC");
    const f = (await s.getProfile("bill")).fields;
    expect(f.dueDate).toBe("2026-11-10");
    expect(missedPayments(f, "2026-11-12")).toEqual([]);
  });

  it("editing an assumed bill payment's amount keeps one payment, one expense, still assumed", async () => {
    const s = fakeStorage([BILL]);
    const paid = await run(s, "bill", "2026-11-10");
    await repriceBillPayment(s, paid!.payment.id, { amount: 91.5 });
    expect(s.payments.map((p: any) => p.amount)).toEqual([91.5]);
    expect(s.expenses.map((e: any) => e.amount)).toEqual([91.5]);
    const stamp = (await s.getProfile("bill")).fields.occurrences["2026-11-10"];
    expect(occurrencePaymentStatus(stamp, "2026-11-10", "2026-11-11")).toBe("assumed_paid");
    expect(await run(s, "bill", "2026-11-11")).toBeNull();
  });

  it("the paying account moves with the payment and comes back when it is missed", async () => {
    const s = fakeStorage([LOAN, CHECKING]);
    await setAutoPay(s, "loan", { accountId: "acct" }, "UTC");
    const paid = await run(s, "loan", "2026-11-15");
    expect((await s.getProfile("acct")).fields.balance).toBe(4_600);
    await setOccurrenceStatus(s, "loan", { paymentId: paid!.payment.id }, { status: "missed" }, "UTC");
    expect((await s.getProfile("acct")).fields.balance).toBe(5_000);
  });

  it("marking a FUTURE payment missed ahead of time: it is not recorded, the month after is", async () => {
    const s = fakeStorage([BILL]);
    await run(s, "bill", "2026-11-10");
    await setOccurrenceStatus(s, "bill", { occurrenceDate: "2026-12-10" }, { status: "missed" }, "UTC");
    expect(await run(s, "bill", "2026-12-10")).toBeNull();
    expect((await run(s, "bill", "2027-01-10"))?.ok).toBe(true);
    expect(s.payments).toHaveLength(2);
  });

  it("missed twice, confirmed twice, partial then confirmed: each is idempotent", async () => {
    const s = fakeStorage([BILL, LOAN]);
    const b = await run(s, "bill", "2026-11-10");
    await setOccurrenceStatus(s, "bill", { paymentId: b!.payment.id }, { status: "confirmed" }, "UTC");
    await setOccurrenceStatus(s, "bill", { occurrenceDate: "2026-11-10" }, { status: "confirmed" }, "UTC");
    expect(s.payments.filter((p: any) => p.liabilityProfileId === "bill")).toHaveLength(1);
    const l = await run(s, "loan", "2026-11-15");
    await setOccurrenceStatus(s, "loan", { paymentId: l!.payment.id }, { status: "partial", amount: 200 }, "UTC");
    await setOccurrenceStatus(s, "loan", { occurrenceDate: "2026-11-15" }, { status: "confirmed" }, "UTC");
    expect(paymentsOf(s, "loan")).toHaveLength(1);
    expect(occurrencePaymentStatus((await s.getProfile("loan")).fields.occurrences["2026-11-15"], "2026-11-15", "2026-11-16")).toBe("partial");
    await setOccurrenceStatus(s, "loan", { occurrenceDate: "2026-11-15" }, { status: "missed" }, "UTC");
    await setOccurrenceStatus(s, "loan", { occurrenceDate: "2026-11-15" }, { status: "missed" }, "UTC");
    expect(paymentsOf(s, "loan")).toHaveLength(0);
    expect(resolveLiabilityBalance(await s.getProfile("loan"))).toBe(15_000);
    expect(expensesOf(s, "loan")).toHaveLength(0);
  });

  it("partial, then the rest paid later: the occurrence stays one partial record plus a second payment", async () => {
    const s = fakeStorage([BILL]);
    const paid = await run(s, "bill", "2026-11-10");
    await setOccurrenceStatus(s, "bill", { paymentId: paid!.payment.id }, { status: "partial", amount: 40 }, "UTC");
    const rest = await payBillOccurrence(s, "bill", { occurrenceDate: "2026-11-10", amount: 45, paymentDate: "2026-11-18", source: "route" }, "UTC");
    expect(rest.ok).toBe(true);
    expect(s.payments.map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([40, 45]);
    expect(s.expenses.reduce((sum: number, e: any) => sum + e.amount, 0)).toBe(85);
    expect((await s.getProfile("bill")).fields.dueDate).toBe("2026-12-10");
  });

  it("off, then on again after a due day passed unpaid: that day is not back-filled", async () => {
    const s = fakeStorage([BILL]);
    await setAutoPay(s, "bill", { enabled: false }, "UTC");
    expect(await run(s, "bill", "2026-11-10")).toBeNull();
    await s.updateProfile("bill", { fields: { autopay: true, autoPay: true, autoRecordSince: "2026-11-14" } });
    expect(await run(s, "bill", "2026-11-14")).toBeNull();
    expect(await run(s, "bill", "2026-11-20")).toBeNull();
  });

  it("\"Remind me anyway\" is the only thing that brings reminders back", () => {
    expect(wantsDueReminders({ autopay: false })).toBe(true);
    expect(wantsDueReminders({ autopay: true })).toBe(false);
    expect(wantsDueReminders({ autopay: true, autopayReminders: true })).toBe(true);
  });
});

describe("a loan with a payment bill beside it (older accounts)", () => {
  const PAYMENT_BILL = { id: "paybill", name: "Honda CR-V Loan payment", type: "liability", type_key: "bill", parentProfileId: "me", fields: { amount: 400, frequency: "monthly", dueDate: "2026-11-15", firstPaymentDate: "2026-11-15", linkedLiabilityId: "loan", ...ON } };

  it("Auto Pay on the bill pays the loan down by the principal and can be reversed", async () => {
    const loan = clone(LOAN); loan.fields.autopay = false; loan.fields.autoPay = false;
    const s = fakeStorage([loan, PAYMENT_BILL]);
    const paid = await run(s, "paybill", "2026-11-15");
    expect(resolveLiabilityBalance(await s.getProfile("loan"))).toBe(14_675);
    await setOccurrenceStatus(s, "paybill", { paymentId: paid!.payment.id }, { status: "missed" }, "UTC");
    expect(resolveLiabilityBalance(await s.getProfile("loan"))).toBe(15_000);
    expect(s.payments).toHaveLength(0);
    expect(s.expenses).toHaveLength(0);
  });

  it("Auto Pay on BOTH the loan and its bill records ONE payment, not two", async () => {
    const s = fakeStorage([LOAN, PAYMENT_BILL]);
    const all = await s.getProfiles();
    for (const p of all) await runAutopayForLiability(s, p, "2026-11-15", "UTC");
    for (const p of await s.getProfiles()) await runAutopayForLiability(s, p, "2026-11-15", "UTC");
    expect(s.payments).toHaveLength(1);
    expect(resolveLiabilityBalance(await s.getProfile("loan"))).toBe(14_675);
  });
});

describe("the rest of the books", () => {
  it("net worth rises by exactly the principal, not the payment", async () => {
    const car = { id: "car", name: "Honda CR-V", type: "vehicle", fields: { currentValue: 24_000 } };
    const s = fakeStorage([car, LOAN]);
    const ctx: any = { mode: "everyone", selectedIds: [] };
    const before = computeNetWorth(await s.getProfiles(), ctx).netWorth;
    await run(s, "loan", "2026-11-15");
    const after = computeNetWorth(await s.getProfiles(), ctx).netWorth;
    expect(before).toBe(9_000);
    expect(after - before).toBe(325);
  });

  it("reconciling one bank debit when two liabilities share the amount picks the one it names", async () => {
    const gym = { id: "gym", name: "Planet Fitness", type: "liability", type_key: "gym_membership", parentProfileId: "me", fields: { amount: 85, frequency: "monthly", dueDate: "2026-11-10", firstPaymentDate: "2026-11-10", ...ON } };
    const s = fakeStorage([BILL, gym]);
    await run(s, "bill", "2026-11-10");
    await run(s, "gym", "2026-11-10");
    expect((await reconcileBankTransaction(s, { id: "t1", amount: 85, date: "2026-11-10" }, "UTC")).matched).toBe(false);
    const named = await reconcileBankTransaction(s, { id: "t1", amount: 85, date: "2026-11-11", description: "PLANET FITNESS CLUB FEES" }, "UTC");
    expect(named).toMatchObject({ matched: true, liabilityId: "gym" });
    const other = await reconcileBankTransaction(s, { id: "t2", amount: 85, date: "2026-11-10" }, "UTC");
    expect(other).toMatchObject({ matched: true, liabilityId: "bill" });
    expect(s.payments).toHaveLength(2);
    expect(s.expenses).toHaveLength(2);
  });

  it("the statement import confirms the assumed payment instead of adding an expense", async () => {
    const { applyImport, planImport } = await import("../server/finance-import");
    const { validateFinanceImport } = await import("../shared/finance-import-schema");
    const s = fakeStorage([BILL]);
    await run(s, "bill", "2026-11-10");
    const store: any = {
      ...s, getExpenses: s.getExpenses, createExpense: s.createExpense, getProfiles: s.getProfiles,
      getObligations: async () => [], getIncomes: async () => [], getBudgets: async () => [],
      createFinanceImport: async (row: any) => row,
    };
    const parsed = validateFinanceImport(JSON.stringify({
      version: "1.0", base_currency: "USD",
      transactions: [
        { unique_id: "t1", date: "2026-11-11", amount: 85, currency: "USD", merchant: "Verizon Wireless", category: "utilities", type: "expense", confidence: 0.9 },
        { unique_id: "t2", date: "2026-11-11", amount: 4.5, currency: "USD", merchant: "Starbucks", category: "food", type: "expense", confidence: 0.9 },
      ],
    }));
    expect(parsed.ok).toBe(true);
    const clock = { month: "2026-11", today: "2026-11-12" };
    const plan = await planImport(store, parsed.data as any, "me", clock);
    const result = await applyImport(store, parsed.data as any, "me", plan, clock, { reconcile: (txn) => reconcileBankTransaction(s, txn, "UTC") });
    expect(result.reconciled.map((r) => r.uniqueId)).toEqual(["t1"]);
    // One Verizon expense (the payment's own) and the coffee: nothing doubled.
    expect(s.expenses.map((e: any) => e.amount).sort((a: number, b: number) => a - b)).toEqual([4.5, 85]);
    expect(s.payments).toHaveLength(1);
    expect((await s.getProfile("bill")).fields.occurrences["2026-11-10"].verification).toBe("confirmed");
  });
});

describe("found on the deployed app (2026-11-20)", () => {
  it("a weekly bill with no series origin is recorded on its due day (phantom earlier cycles do not block it)", async () => {
    const weekly = { id: "wk", name: "Lawn", type: "liability", type_key: "utility", parentProfileId: "me", fields: { amount: 30, frequency: "weekly", dueDate: "2026-11-20", autopay: true, autoPay: true, autoRecordSince: "2026-11-20" } };
    const s = fakeStorage([weekly]);
    const paid = await run(s, "wk", "2026-11-20");
    expect(paid?.ok).toBe(true);
    expect(s.payments.map((p: any) => p.paymentDate)).toEqual(["2026-11-20"]);
    expect((await s.getProfile("wk")).fields.dueDate).toBe("2026-11-27");
    expect(await run(s, "wk", "2026-11-21")).toBeNull();
  });

  it("a cycle that was overdue before the switch stays the user's, and does not stall the cycles after it", async () => {
    const late = clone(BILL); late.fields.dueDate = "2026-11-05"; late.fields.firstPaymentDate = "2026-10-05"; late.fields.autoRecordSince = "2026-11-08";
    late.fields.occurrences = { "2026-10-05": { status: "paid", paymentId: "old" } };
    const s = fakeStorage([late]);
    expect(await run(s, "bill", "2026-11-20")).toBeNull();
    const dec = await run(s, "bill", "2026-12-05");
    expect(dec?.ok).toBe(true);
    expect(dec?.occurrenceDate).toBe("2026-12-05");
    const f = (await s.getProfile("bill")).fields;
    // November is still open and still the bill's due date (overdue): nothing
    // was assumed for it.
    expect(f.dueDate).toBe("2026-11-05");
    expect(f.occurrences["2026-11-05"]?.status).toBeUndefined();
    expect(await run(s, "bill", "2026-12-06")).toBeNull();
    // Settling November by hand moves the bill past the December Auto Pay recorded.
    await payBillOccurrence(s, "bill", { occurrenceDate: "2026-11-05", paymentDate: "2026-12-07", source: "occurrence_route" }, "UTC");
    expect((await s.getProfile("bill")).fields.dueDate).toBe("2027-01-05");
    expect(s.payments).toHaveLength(2);
  });

  it("the month range for principal paid ends at the first of next month (November has no 31st)", async () => {
    const { firstOfNextMonth } = await import("../server/supabase-storage");
    expect(firstOfNextMonth("2026-11")).toBe("2026-12-01");
    expect(firstOfNextMonth("2026-12")).toBe("2027-01-01");
    expect(firstOfNextMonth("2027-02")).toBe("2027-03-01");
  });

  it("a recurring bill created with a due date and no origin is given one at the storage door", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/supabase-storage.ts", "utf8");
    const create = src.slice(src.indexOf("async createProfile(data: InsertProfile)"), src.indexOf("async createProfile(data: InsertProfile)") + 3500);
    expect(create).toMatch(/isRecurringBill\(createdTypeKey\)[\s\S]{0,200}firstPaymentDate: firstDue/);
  });
});
