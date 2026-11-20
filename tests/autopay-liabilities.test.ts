// Auto Pay, end to end over the real pay pipeline: a car loan, a mortgage, a
// phone bill and a subscription.
//
// What must hold (CLAUDE.md "Auto Pay rules"):
//   A1  a payment is recorded ON its due day, once, however often the job runs
//   A2  what Auto Pay records is ASSUMED until a person or a bank confirms it
//   A3  one occurrence can be marked missed / delayed / partial without
//       touching the recurring schedule, and a reversal puts everything back
//   A4  a loan payment's principal lowers the balance; only interest and fees
//       are an expense
//   A5  a bank transaction that IS an assumed payment confirms it — it never
//       becomes a second expense
//   A6  Auto Pay bills stay out of "needs attention"; a missed payment is the
//       exception that shows
import { describe, it, expect } from "vitest";
import { runAutopayForLiability, setAutoPay, setOccurrenceStatus, reconcileBankTransaction } from "../server/autopay";
import { payBillOccurrence } from "../server/liability-payments";
import {
  ASSUMED_EXPENSE_TAG, autopayDueOccurrence, isQuietAutoPayBill, matchAssumedPayment, missedPayments,
  occurrencePaymentStatus, stampOfPayment,
} from "../shared/autopay";
import { generateSchedule, deriveScheduleFields } from "../shared/liability-schedule";
import { nextLoanDueDate } from "../shared/loan-facts";
import { resolveLiabilityBalance } from "../shared/asset-value";
import { computeAttention } from "../shared/attention";

/** Storage double: the surface the pay pipeline and the Auto Pay operations use. */
function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map((p) => [p.id, JSON.parse(JSON.stringify(p))]));
  const expenses: any[] = [];
  let payments: any[] = [];
  let seq = 0;
  const mergeFields = (id: string, patch: Record<string, any>) => {
    const p = profiles.get(id);
    const fields = { ...(p.fields || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined) delete fields[k]; else fields[k] = v;
    }
    profiles.set(id, { ...p, fields });
    return profiles.get(id);
  };
  const storage: any = {
    get expenses() { return expenses.filter((e) => !e.deletedAt); },
    get payments() { return payments; },
    getProfile: async (id: string) => profiles.get(id),
    getProfiles: async () => [...profiles.values()],
    updateProfile: async (id: string, patch: any) => (profiles.has(id) ? mergeFields(id, patch.fields || {}) : undefined),
    // The compare-and-set claim the real storage has: the occurrence is
    // stamped BEFORE the ledger row, and a second claimant is told so.
    claimBillOccurrence: async (id: string, date: string, stamp: any, extra: any) => {
      const p = profiles.get(id);
      const prior = { ...((p.fields || {}).occurrences || {}) };
      if (prior[date]?.status === "paid") return { status: "already-paid", occurrences: prior };
      mergeFields(id, { ...extra, occurrences: { ...prior, [date]: { ...(prior[date] || {}), ...stamp } } });
      return { status: "claimed", occurrences: prior };
    },
    updateOccurrenceOverride: async (id: string, date: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return null;
      const occ = { ...((p.fields || {}).occurrences || {}) };
      const merged: any = { ...(occ[date] || {}), ...patch };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      occ[date] = merged;
      mergeFields(id, { occurrences: occ });
      return { id, occurrences: occ };
    },
    rescheduleOccurrence: async (id: string, date: string, newDate: string) =>
      storage.updateOccurrenceOverride(id, date, { movedTo: newDate }),
    createLiabilityPayment: async (data: any) => {
      const row = { id: data.id || `pay-${++seq}`, ...data };
      payments = [row, ...payments];
      return row;
    },
    getLiabilityPayments: async (id: string) => payments.filter((p) => p.liabilityProfileId === id),
    getLiabilityPayment: async (id: string) => payments.find((p) => p.id === id),
    updateLiabilityPayment: async (id: string, patch: any) => {
      const row = payments.find((p) => p.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteLiabilityPayment: async (id: string) => {
      const before = payments.length;
      payments = payments.filter((p) => p.id !== id);
      return payments.length < before;
    },
    unmarkLoanPayment: async () => 0,
    adjustAccountBalance: async (id: string, input: any) => {
      const p = profiles.get(id);
      return mergeFields(id, { balance: (Number(p.fields.balance) || 0) + (Number(input.delta) || 0) });
    },
    createExpense: async (data: any) => {
      const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data };
      expenses.push(row);
      return row;
    },
    getExpenses: async () => expenses.filter((e) => !e.deletedAt),
    updateExpense: async (id: string, patch: any) => {
      const e = expenses.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
      return e;
    },
    deleteExpense: async (id: string) => {
      const e = expenses.find((x) => x.id === id);
      if (!e) return false;
      e.deletedAt = "now";
      return true;
    },
  };
  return storage;
}

const CAR_LOAN = {
  id: "loan-car", name: "Honda CR-V Loan", type: "liability", type_key: "auto_loan",
  fields: { currentBalance: 15_000, interestRate: 6, monthlyPayment: 400, dueDay: 15, autopay: true, autoPay: true, autoRecordSince: "2026-11-01" },
};
const MORTGAGE = {
  id: "loan-home", name: "Wells Fargo Mortgage", type: "liability", type_key: "mortgage",
  fields: { currentBalance: 300_000, interestRate: 6.25, monthlyPayment: 2_100, dueDay: 1, autopay: true, autoPay: true, autoRecordSince: "2026-11-01" },
};
const PHONE = {
  id: "bill-phone", name: "Verizon Wireless", type: "liability", type_key: "phone_plan", parentProfileId: "me",
  fields: { amount: 85, frequency: "monthly", dueDate: "2026-11-20", firstPaymentDate: "2026-08-20", autopay: true, autoPay: true, autoRecordSince: "2026-11-01" },
};
const NETFLIX = {
  id: "bill-sub", name: "Netflix", type: "liability", type_key: "subscription", parentProfileId: "me",
  fields: { amount: 15.99, frequency: "monthly", dueDate: "2026-11-18", firstPaymentDate: "2026-08-18", autopay: true, autoPay: true, autoRecordSince: "2026-11-01" },
};
const CHECKING = { id: "acct-1", name: "Checking", type: "account", type_key: "checking", fields: { accountKind: "checking", balance: 5_000 } };

/** What the daily job does for one liability on one day. */
async function runDay(storage: any, id: string, today: string) {
  return runAutopayForLiability(storage, await storage.getProfile(id), today, "UTC");
}

describe("A1 — recorded on the due day, exactly once", () => {
  it("records nothing before the due day and one payment on it", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    expect(await runDay(storage, "loan-car", "2026-11-14")).toBeNull();
    expect(storage.payments).toHaveLength(0);

    const paid = await runDay(storage, "loan-car", "2026-11-15");
    expect(paid?.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0].amount).toBe(400);
    expect(storage.payments[0].paymentDate).toBe("2026-11-15");
  });

  it("a retry, a second run the same day and the next day's run add nothing", async () => {
    const storage = fakeStorage([CAR_LOAN, PHONE]);
    for (const day of ["2026-11-15", "2026-11-15", "2026-11-16", "2026-11-20", "2026-11-20", "2026-11-21"]) {
      await runDay(storage, "loan-car", day);
      await runDay(storage, "bill-phone", day);
    }
    expect(storage.payments.filter((p: any) => p.liabilityProfileId === "loan-car")).toHaveLength(1);
    expect(storage.payments.filter((p: any) => p.liabilityProfileId === "bill-phone")).toHaveLength(1);
    expect(storage.expenses).toHaveLength(2); // the loan's interest + the phone bill
  });

  it("a run that was missed catches up, dated on the due day", async () => {
    const storage = fakeStorage([NETFLIX]);
    const paid = await runDay(storage, "bill-sub", "2026-11-21");
    expect(paid?.ok).toBe(true);
    expect(storage.payments[0].paymentDate).toBe("2026-11-18");
    expect(storage.expenses[0].date).toBe("2026-11-18");
  });

  it("the next cycle is recorded when it comes due", async () => {
    const storage = fakeStorage([CAR_LOAN, PHONE]);
    await runDay(storage, "loan-car", "2026-11-15");
    await runDay(storage, "bill-phone", "2026-11-20");
    expect((await storage.getProfile("bill-phone")).fields.dueDate).toBe("2026-12-20");
    expect(nextLoanDueDate((await storage.getProfile("loan-car")).fields, "2026-11-16")).toBe("2026-12-15");
    await runDay(storage, "loan-car", "2026-12-15");
    await runDay(storage, "bill-phone", "2026-12-20");
    expect(storage.payments).toHaveLength(4);
  });

  it("switching Auto Pay on does not back-fill a bill that was already overdue", async () => {
    const overdue = JSON.parse(JSON.stringify(PHONE));
    overdue.fields.dueDate = "2026-11-05";
    overdue.fields.autopay = false; overdue.fields.autoPay = false; delete overdue.fields.autoRecordSince;
    const storage = fakeStorage([overdue]);
    await setAutoPay(storage, "bill-phone", { enabled: true }, "UTC");
    const f = (await storage.getProfile("bill-phone")).fields;
    expect(f.autopay).toBe(true);
    expect(f.autoPay).toBe(true);
    expect(f.autoRecordSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The Nov 5 occurrence predates the switch: it stays the user's to settle.
    expect(autopayDueOccurrence({ ...overdue, fields: { ...f, autoRecordSince: "2026-11-10" } }, "2026-11-12")).toBeNull();
  });

  it("turning Auto Pay off stops future recording and keeps the history", async () => {
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    await setAutoPay(storage, "bill-phone", { enabled: false }, "UTC");
    expect(await runDay(storage, "bill-phone", "2026-12-20")).toBeNull();
    expect(storage.payments).toHaveLength(1);
    expect(storage.expenses).toHaveLength(1);
    const bill = await storage.getProfile("bill-phone");
    expect(bill.fields.dueDate).toBe("2026-12-20"); // the recurring bill is untouched
    expect(bill.fields.occurrences["2026-11-20"].status).toBe("paid");
  });
});

describe("A2 — assumed until confirmed", () => {
  it("an Auto Pay payment is stamped assumed; a payment a person records is confirmed", async () => {
    const storage = fakeStorage([PHONE, NETFLIX]);
    await runDay(storage, "bill-phone", "2026-11-20");
    await payBillOccurrence(storage, "bill-sub", { occurrenceDate: "2026-11-18", source: "occurrence_route" }, "UTC");
    const phone = (await storage.getProfile("bill-phone")).fields.occurrences["2026-11-20"];
    const sub = (await storage.getProfile("bill-sub")).fields.occurrences["2026-11-18"];
    expect(occurrencePaymentStatus(phone, "2026-11-20", "2026-11-22")).toBe("assumed_paid");
    expect(occurrencePaymentStatus(sub, "2026-11-18", "2026-11-22")).toBe("confirmed_paid");
    expect(storage.expenses.find((e: any) => e.description.startsWith("Verizon")).tags).toContain(ASSUMED_EXPENSE_TAG);
    expect(storage.expenses.find((e: any) => e.description.startsWith("Netflix")).tags).not.toContain(ASSUMED_EXPENSE_TAG);
  });

  it("confirming keeps the one payment and the one expense, and drops the assumed mark", async () => {
    const storage = fakeStorage([PHONE]);
    const paid = await runDay(storage, "bill-phone", "2026-11-20");
    const done = await setOccurrenceStatus(storage, "bill-phone", { paymentId: paid!.payment.id }, { status: "confirmed" }, "UTC");
    expect(done.ok).toBe(true);
    expect(done.paymentId).toBe(paid!.payment.id);
    expect(storage.payments).toHaveLength(1);
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0].tags).not.toContain(ASSUMED_EXPENSE_TAG);
    const stamp = (await storage.getProfile("bill-phone")).fields.occurrences["2026-11-20"];
    expect(occurrencePaymentStatus(stamp, "2026-11-20", "2026-11-22")).toBe("confirmed_paid");
  });

  it("the schedule reports scheduled / assumed / missed per occurrence", async () => {
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    const bill = await storage.getProfile("bill-phone");
    const rows = generateSchedule({ id: bill.id, fields: bill.fields }, storage.payments, { todayISO: "2026-11-22", windowStart: "2026-11-01", windowEnd: "2027-01-31" });
    expect(rows.find((r) => r.date === "2026-11-20")?.paymentStatus).toBe("assumed_paid");
    expect(rows.find((r) => r.date === "2026-12-20")?.paymentStatus).toBe("scheduled");
  });
});

describe("A3 — one occurrence corrected, the schedule untouched", () => {
  it("missed: the assumed loan payment is reversed and the balance restored; later months carry on", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    const paid = await runDay(storage, "loan-car", "2026-11-15");
    expect(resolveLiabilityBalance(await storage.getProfile("loan-car"))).toBe(14_675);
    expect(storage.expenses).toHaveLength(1);

    const missed = await setOccurrenceStatus(storage, "loan-car", { paymentId: paid!.payment.id }, { status: "missed" }, "UTC");
    expect(missed).toMatchObject({ ok: true, reversed: true, occurrenceDate: "2026-11-15" });
    const loan = await storage.getProfile("loan-car");
    expect(storage.payments).toHaveLength(0);
    expect(storage.expenses).toHaveLength(0);
    expect(resolveLiabilityBalance(loan)).toBe(15_000);
    expect(loan.fields.occurrences["2026-11-15"].status).toBe("missed");
    // The recurring terms did not move.
    expect(loan.fields.monthlyPayment).toBe(400);
    expect(loan.fields.dueDay).toBe(15);
    expect(loan.fields.autopay).toBe(true);

    // The job does not record the missed payment again…
    expect(await runDay(storage, "loan-car", "2026-11-16")).toBeNull();
    expect(await runDay(storage, "loan-car", "2026-11-30")).toBeNull();
    // …and December is recorded as usual.
    const december = await runDay(storage, "loan-car", "2026-12-15");
    expect(december?.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0].paymentDate).toBe("2026-12-15");
    expect(missedPayments((await storage.getProfile("loan-car")).fields, "2026-12-01")).toEqual([{ date: "2026-11-15", amount: 400 }]);
  });

  it("missed on a bill: expense deleted, the series moves to next month, nothing re-recorded", async () => {
    const storage = fakeStorage([PHONE, CHECKING]);
    await setAutoPay(storage, "bill-phone", { accountId: "acct-1" }, "UTC");
    await runDay(storage, "bill-phone", "2026-11-20");
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(4_915);
    const done = await setOccurrenceStatus(storage, "bill-phone", { occurrenceDate: "2026-11-20" }, { status: "missed" }, "UTC");
    expect(done.ok).toBe(true);
    expect(storage.payments).toHaveLength(0);
    expect(storage.expenses).toHaveLength(0);
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(5_000);
    const bill = await storage.getProfile("bill-phone");
    expect(bill.fields.dueDate).toBe("2026-12-20");
    expect(bill.fields.amount).toBe(85);
    expect(await runDay(storage, "bill-phone", "2026-11-21")).toBeNull();
    expect((await runDay(storage, "bill-phone", "2026-12-20"))?.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
  });

  it("a missed payment paid late is one confirmed payment and no longer an exception", async () => {
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    await setOccurrenceStatus(storage, "bill-phone", { occurrenceDate: "2026-11-20" }, { status: "missed" }, "UTC");
    const late = await payBillOccurrence(storage, "bill-phone", { occurrenceDate: "2026-11-20", paymentDate: "2026-11-27", source: "occurrence_route" }, "UTC");
    expect(late.ok).toBe(true);
    const bill = await storage.getProfile("bill-phone");
    expect(occurrencePaymentStatus(bill.fields.occurrences["2026-11-20"], "2026-11-20", "2026-11-28")).toBe("confirmed_paid");
    expect(missedPayments(bill.fields, "2026-11-28")).toEqual([]);
    expect(bill.fields.dueDate).toBe("2026-12-20");
    expect(storage.payments).toHaveLength(1);
    expect(storage.expenses).toHaveLength(1);
  });

  it("partial: one payment at the amount actually paid, the scheduled amount remembered", async () => {
    const storage = fakeStorage([NETFLIX]);
    const paid = await runDay(storage, "bill-sub", "2026-11-18");
    const done = await setOccurrenceStatus(storage, "bill-sub", { paymentId: paid!.payment.id }, { status: "partial", amount: 10 }, "UTC");
    expect(done.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0].amount).toBe(10);
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0].amount).toBe(10);
    const bill = await storage.getProfile("bill-sub");
    const stamp = bill.fields.occurrences["2026-11-18"];
    expect(occurrencePaymentStatus(stamp, "2026-11-18", "2026-11-19")).toBe("partial");
    expect(stamp.expectedAmount).toBe(15.99);
    // The recurring amount is still $15.99 and December is still scheduled.
    expect(bill.fields.amount).toBe(15.99);
    expect(bill.fields.dueDate).toBe("2026-12-18");
  });

  it("partial on a loan: the balance moves by the principal of what was actually paid", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    const paid = await runDay(storage, "loan-car", "2026-11-15");
    await setOccurrenceStatus(storage, "loan-car", { paymentId: paid!.payment.id }, { status: "partial", amount: 200 }, "UTC");
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0]).toMatchObject({ amount: 200, interestPortion: 75, principalPortion: 125 });
    expect(resolveLiabilityBalance(await storage.getProfile("loan-car"))).toBe(14_875);
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0].amount).toBe(75);
  });

  it("delayed: that one occurrence is recorded on its new day; the series keeps its day", async () => {
    const storage = fakeStorage([NETFLIX]);
    const done = await setOccurrenceStatus(storage, "bill-sub", { occurrenceDate: "2026-11-18" }, { status: "delayed", movedTo: "2026-11-25" }, "UTC");
    expect(done.ok).toBe(true);
    const moved = (await storage.getProfile("bill-sub")).fields.occurrences["2026-11-18"];
    expect(occurrencePaymentStatus(moved, "2026-11-25", "2026-11-19")).toBe("delayed");
    expect(await runDay(storage, "bill-sub", "2026-11-18")).toBeNull();
    expect(await runDay(storage, "bill-sub", "2026-11-24")).toBeNull();
    expect((await runDay(storage, "bill-sub", "2026-11-25"))?.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0].paymentDate).toBe("2026-11-25");
    expect((await storage.getProfile("bill-sub")).fields.dueDate).toBe("2026-12-18");
  });

  it("delaying a payment that was already assumed reverses it first", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    const paid = await runDay(storage, "loan-car", "2026-11-15");
    await setOccurrenceStatus(storage, "loan-car", { paymentId: paid!.payment.id }, { status: "delayed", movedTo: "2026-11-22" }, "UTC");
    expect(storage.payments).toHaveLength(0);
    expect(resolveLiabilityBalance(await storage.getProfile("loan-car"))).toBe(15_000);
    expect(await runDay(storage, "loan-car", "2026-11-21")).toBeNull();
    expect((await runDay(storage, "loan-car", "2026-11-22"))?.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
  });

  it("back to scheduled: a missed mark is undone and Auto Pay records it again", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await runDay(storage, "loan-car", "2026-11-15");
    await setOccurrenceStatus(storage, "loan-car", { occurrenceDate: "2026-11-15" }, { status: "missed" }, "UTC");
    await setOccurrenceStatus(storage, "loan-car", { occurrenceDate: "2026-11-15" }, { status: "scheduled" }, "UTC");
    expect((await runDay(storage, "loan-car", "2026-11-17"))?.ok).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0].paymentDate).toBe("2026-11-15");
  });
});

describe("A4 — principal lowers the debt; interest and fees are the expense", () => {
  it("car loan: $400 = $75 interest (expense) + $325 principal (balance)", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await runDay(storage, "loan-car", "2026-11-15");
    expect(storage.payments[0]).toMatchObject({ amount: 400, interestPortion: 75, principalPortion: 325 });
    expect(resolveLiabilityBalance(await storage.getProfile("loan-car"))).toBe(14_675);
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0]).toMatchObject({ amount: 75, category: "debt", date: "2026-11-15" });
    // The cost expense is retracted by its own key; it must not claim to BE
    // the payment (editing it would re-price the payment).
    expect(storage.expenses[0].tags).toContain(`payment-cost:${storage.payments[0].id}`);
    expect(storage.expenses[0].tags.some((t: string) => t.startsWith("payment:"))).toBe(false);
  });

  it("mortgage: the expense is the month's interest, not the whole payment", async () => {
    const storage = fakeStorage([MORTGAGE]);
    await runDay(storage, "loan-home", "2026-12-01");
    expect(storage.payments[0]).toMatchObject({ amount: 2_100, interestPortion: 1_562.5, principalPortion: 537.5 });
    expect(resolveLiabilityBalance(await storage.getProfile("loan-home"))).toBe(299_462.5);
    expect(storage.expenses.map((e: any) => e.amount)).toEqual([1_562.5]);
  });

  it("an ordinary bill's whole payment is the expense", async () => {
    const storage = fakeStorage([PHONE, NETFLIX]);
    await runDay(storage, "bill-sub", "2026-11-18");
    await runDay(storage, "bill-phone", "2026-11-20");
    expect(storage.expenses.map((e: any) => e.amount).sort((a: number, b: number) => a - b)).toEqual([15.99, 85]);
  });

  it("the last instalment pays what is left, not a full payment", async () => {
    const nearlyDone = JSON.parse(JSON.stringify(CAR_LOAN));
    nearlyDone.fields.currentBalance = 100;
    nearlyDone.fields.originalBalance = 20_000;
    const storage = fakeStorage([nearlyDone]);
    await runDay(storage, "loan-car", "2026-11-15");
    expect(storage.payments[0].amount).toBe(100.5);
    expect(resolveLiabilityBalance(await storage.getProfile("loan-car"))).toBe(0);
    // Paid off: nothing more is recorded.
    expect(await runDay(storage, "loan-car", "2026-12-15")).toBeNull();
  });

  it("a loan with no payment amount records nothing (no invented figure)", async () => {
    const noAmount = JSON.parse(JSON.stringify(CAR_LOAN));
    delete noAmount.fields.monthlyPayment;
    const storage = fakeStorage([noAmount]);
    expect(await runDay(storage, "loan-car", "2026-11-15")).toBeNull();
  });

  it("a manual loan payment splits the same way and logs the same interest expense", async () => {
    const manual = JSON.parse(JSON.stringify(CAR_LOAN));
    manual.fields.autopay = false; manual.fields.autoPay = false;
    const storage = fakeStorage([manual]);
    await payBillOccurrence(storage, "loan-car", { amount: 400, paymentDate: "2026-11-15", source: "route" }, "UTC");
    expect(storage.payments[0]).toMatchObject({ interestPortion: 75, principalPortion: 325 });
    expect(storage.expenses.map((e: any) => e.amount)).toEqual([75]);
    expect(storage.expenses[0].tags).not.toContain(ASSUMED_EXPENSE_TAG);
  });
});

describe("A5 — a bank transaction confirms the assumed payment; it is not a second expense", () => {
  it("matches by amount and date, confirms, and writes no new payment or expense", async () => {
    const storage = fakeStorage([PHONE, NETFLIX]);
    const paid = await runDay(storage, "bill-phone", "2026-11-20");
    const out = await reconcileBankTransaction(storage, { id: "txn_1", amount: -85, date: "2026-11-21", description: "VERIZON WIRELESS PMT" }, "UTC");
    expect(out).toMatchObject({ matched: true, paymentId: paid!.payment.id, liabilityId: "bill-phone" });
    expect(storage.payments).toHaveLength(1);
    expect(storage.expenses).toHaveLength(1);
    const stamp = (await storage.getProfile("bill-phone")).fields.occurrences["2026-11-20"];
    expect(stamp).toMatchObject({ verification: "confirmed", confirmedVia: "bank", bankTransactionId: "txn_1" });
    expect(storage.expenses[0].tags).not.toContain(ASSUMED_EXPENSE_TAG);
  });

  it("the same transaction replayed changes nothing", async () => {
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    await reconcileBankTransaction(storage, { id: "txn_1", amount: 85, date: "2026-11-20" }, "UTC");
    const again = await reconcileBankTransaction(storage, { id: "txn_1", amount: 85, date: "2026-11-20" }, "UTC");
    expect(again).toMatchObject({ matched: true, alreadyMatched: true });
    expect(storage.payments).toHaveLength(1);
    expect(storage.expenses).toHaveLength(1);
  });

  it("a slightly different posted amount re-prices the one payment", async () => {
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    const out = await reconcileBankTransaction(storage, { id: "txn_2", amount: 87.12, date: "2026-11-20", description: "Verizon" }, "UTC");
    expect(out.matched).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.payments[0].amount).toBe(87.12);
    expect(storage.expenses.map((e: any) => e.amount)).toEqual([87.12]);
  });

  it("a loan payment confirmed by the bank stays one payment with one interest expense", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await runDay(storage, "loan-car", "2026-11-15");
    const out = await reconcileBankTransaction(storage, { id: "txn_3", amount: 400, date: "2026-11-16", description: "HONDA FINANCIAL" }, "UTC");
    expect(out.matched).toBe(true);
    expect(storage.payments).toHaveLength(1);
    expect(storage.expenses.map((e: any) => e.amount)).toEqual([75]);
    expect(resolveLiabilityBalance(await storage.getProfile("loan-car"))).toBe(14_675);
  });

  it("an unrelated transaction matches nothing; a confirmed payment is not matched twice", async () => {
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    expect((await reconcileBankTransaction(storage, { id: "t9", amount: 42, date: "2026-11-20", description: "Coffee" }, "UTC")).matched).toBe(false);
    expect((await reconcileBankTransaction(storage, { id: "t10", amount: 85, date: "2026-12-15" }, "UTC")).matched).toBe(false);
    await reconcileBankTransaction(storage, { id: "t11", amount: 85, date: "2026-11-20" }, "UTC");
    expect((await reconcileBankTransaction(storage, { id: "t12", amount: 85, date: "2026-11-20" }, "UTC")).matched).toBe(false);
  });

  it("two liabilities that fit equally well and no name in the description: nothing is guessed", () => {
    const c = (liabilityId: string, liabilityName: string) => ({ paymentId: `p-${liabilityId}`, liabilityId, liabilityName, occurrenceDate: "2026-11-20", amount: 50, paymentDate: "2026-11-20" });
    const candidates = [c("a", "Gym"), c("b", "Storage Unit")];
    expect(matchAssumedPayment(candidates, { amount: 50, date: "2026-11-20" })).toBeNull();
    expect(matchAssumedPayment(candidates, { amount: 50, date: "2026-11-20", description: "PUBLIC STORAGE #114" })?.liabilityId).toBe("b");
  });
});

describe("A6 — quiet by default, loud on an exception", () => {
  it("an upcoming Auto Pay bill is not attention; a manual one is; an overdue Auto Pay bill is", () => {
    expect(isQuietAutoPayBill({ autopay: true }, 2)).toBe(true);
    expect(isQuietAutoPayBill({ autopay: true }, 0)).toBe(true);
    expect(isQuietAutoPayBill({ autopay: true }, -1)).toBe(false);
    expect(isQuietAutoPayBill({ autopay: true, autopayReminders: true }, 2)).toBe(false);
    expect(isQuietAutoPayBill({ autopay: false }, 2)).toBe(false);

    const bills = [
      { id: "auto", name: "Verizon Wireless", amount: 85, dueDate: "2026-11-20", daysUntil: 1, autopay: true },
      { id: "manual", name: "Water", amount: 40, dueDate: "2026-11-20", daysUntil: 1, autopay: false },
      { id: "late", name: "Netflix", amount: 15.99, dueDate: "2026-11-18", daysUntil: -1, autopay: true },
    ];
    const titles = computeAttention({ today: "2026-11-19", bills } as any).items.map((i: any) => i.title);
    expect(titles).toContain("Water");
    expect(titles).toContain("Netflix");
    expect(titles).not.toContain("Verizon Wireless");
  });

  it("the loan's schedule shows the missed month and the next one as scheduled", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await runDay(storage, "loan-car", "2026-11-15");
    await setOccurrenceStatus(storage, "loan-car", { occurrenceDate: "2026-11-15" }, { status: "missed" }, "UTC");
    const loan = await storage.getProfile("loan-car");
    const f = deriveScheduleFields(loan.fields, "auto_loan", "2026-11-20");
    const rows = generateSchedule({ id: loan.id, fields: f }, [], { todayISO: "2026-11-20", windowStart: "2026-11-01", windowEnd: "2027-01-31" });
    expect(rows.find((r) => r.date === "2026-11-15")).toMatchObject({ status: "missed", paymentStatus: "missed" });
    expect(rows.find((r) => r.date === "2026-12-15")).toMatchObject({ status: "upcoming", paymentStatus: "scheduled" });
    expect(stampOfPayment(loan.fields, "nope")).toBeNull();
  });
});

describe("Calendar — the payment dates stay; a missed one says so", () => {
  it("a phone bill keeps every due date on the calendar, and the missed month is flagged, not hidden", async () => {
    const { seriesFromLiabilityProfiles } = await import("../shared/calendar-adapters");
    const { generateSeriesOccurrences } = await import("../shared/calendar-occurrences");
    const storage = fakeStorage([PHONE]);
    await runDay(storage, "bill-phone", "2026-11-20");
    await setOccurrenceStatus(storage, "bill-phone", { occurrenceDate: "2026-11-20" }, { status: "missed" }, "UTC");
    const [series] = seriesFromLiabilityProfiles([await storage.getProfile("bill-phone")]);
    expect(series.missedDates).toEqual(["2026-11-20"]);
    expect(series.skippedDates ?? []).toEqual([]);
    const occ = generateSeriesOccurrences(series, { todayISO: "2026-11-25", lookbackDays: 30, horizonDays: 90 });
    const byDate = Object.fromEntries(occ.map((o: any) => [o.date, o]));
    expect(Object.keys(byDate)).toEqual(expect.arrayContaining(["2026-11-20", "2026-12-20", "2027-01-20"]));
    expect(byDate["2026-11-20"].missed).toBe(true);
    expect(byDate["2026-12-20"].missed).toBeUndefined();
    expect(byDate["2026-12-20"].status).toBe("upcoming");

    // Paid late: it is no longer a missed payment anywhere on the calendar.
    await payBillOccurrence(storage, "bill-phone", { occurrenceDate: "2026-11-20", paymentDate: "2026-11-25", source: "occurrence_route" }, "UTC");
    const [after] = seriesFromLiabilityProfiles([await storage.getProfile("bill-phone")]);
    expect(after.missedDates ?? []).toEqual([]);
    expect(after.completedDates).toContain("2026-11-20");
    const again = generateSeriesOccurrences(after, { todayISO: "2026-11-25", lookbackDays: 30, horizonDays: 30 });
    expect(again.some((o: any) => o.missed)).toBe(false);
  });
});

describe("Every door that returns payments carries their status", () => {
  it("withPaymentStatuses labels assumed, confirmed and partial rows from the stamps", async () => {
    const { withPaymentStatuses } = await import("../server/autopay");
    const storage = fakeStorage([CAR_LOAN, PHONE, NETFLIX]);
    await runDay(storage, "loan-car", "2026-11-15");
    await payBillOccurrence(storage, "bill-phone", { occurrenceDate: "2026-11-20", source: "occurrence_route" }, "UTC");
    const sub = await runDay(storage, "bill-sub", "2026-11-18");
    await setOccurrenceStatus(storage, "bill-sub", { paymentId: sub!.payment.id }, { status: "partial", amount: 10 }, "UTC");
    const rows = await withPaymentStatuses(storage, storage.payments, "2026-11-21");
    const of = (id: string) => rows.find((r: any) => r.liabilityProfileId === id);
    expect(of("loan-car")).toMatchObject({ status: "assumed_paid", autopay: true, occurrenceDate: "2026-11-15" });
    expect(of("bill-phone")).toMatchObject({ status: "confirmed_paid", autopay: false });
    expect(of("bill-sub")).toMatchObject({ status: "partial", expectedAmount: 15.99 });
  });

  // Found on the deployed app (2026-11-20): the liability page is SEEDED from
  // the profile bundle, which returned bare rows, so the history showed no
  // "Assumed paid" badge and no per-payment controls while the standalone
  // endpoint had them.
  it("the payments endpoint AND the profile bundle both answer through it", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("server/routes.ts", "utf8");
    const reads = src.match(/storage\.getLiabilityPayments\((?:req\.params\.id|profileId)\)[\s\S]{0,400}?withPaymentStatuses\(/g) || [];
    expect(reads.length).toBe(2);
  });
});

describe("A late or delayed loan payment does not swallow the next cycle", () => {
  it("a payment delayed to the 22nd is the next due date, and December is still recorded", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await setOccurrenceStatus(storage, "loan-car", { occurrenceDate: "2026-11-15" }, { status: "delayed", movedTo: "2026-11-22" }, "UTC");
    // The list and the page ask this: the moved payment is what is due next.
    expect(nextLoanDueDate((await storage.getProfile("loan-car")).fields, "2026-11-16")).toBe("2026-11-22");
    expect((await runDay(storage, "loan-car", "2026-11-22"))?.ok).toBe(true);
    const f = (await storage.getProfile("loan-car")).fields;
    expect(f.lastPaidDate).toBe("2026-11-22");
    // Paid a week into the December cycle, for NOVEMBER: December is still due.
    expect(nextLoanDueDate(f, "2026-11-23")).toBe("2026-12-15");
    expect(await runDay(storage, "loan-car", "2026-12-14")).toBeNull();
    expect((await runDay(storage, "loan-car", "2026-12-15"))?.ok).toBe(true);
    expect(storage.payments).toHaveLength(2);
  });

  it("a missed payment paid late by hand leaves next month for Auto Pay", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await runDay(storage, "loan-car", "2026-11-15");
    await setOccurrenceStatus(storage, "loan-car", { occurrenceDate: "2026-11-15" }, { status: "missed" }, "UTC");
    await payBillOccurrence(storage, "loan-car", { occurrenceDate: "2026-11-15", amount: 400, paymentDate: "2026-11-27", source: "occurrence_route" }, "UTC");
    expect(nextLoanDueDate((await storage.getProfile("loan-car")).fields, "2026-11-28")).toBe("2026-12-15");
    expect((await runDay(storage, "loan-car", "2026-12-15"))?.ok).toBe(true);
    expect(storage.payments).toHaveLength(2);
  });

  it("a payment made ahead for the coming cycle still counts as that cycle's", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    await runDay(storage, "loan-car", "2026-11-15");
    // December's instalment sent by hand on Dec 3, no occurrence named.
    await payBillOccurrence(storage, "loan-car", { amount: 400, paymentDate: "2026-12-03", source: "route" }, "UTC");
    expect(await runDay(storage, "loan-car", "2026-12-15")).toBeNull();
    expect(storage.payments).toHaveLength(2);
  });
});
