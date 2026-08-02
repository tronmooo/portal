import { describe, it, expect } from "vitest";
import { deriveLoanTerms } from "../shared/loan-terms";
import { buildAmortization } from "../shared/liability-calc";
import { isDebtLiability, isAmortizable, isRecurringBill, recoveredDebtSubtype } from "../shared/liability-types";
import { isNetWorthLiabilityProfile } from "../shared/asset-value";
import { deriveScheduleFields } from "../shared/liability-schedule";
import { seriesFromLiabilityProfiles } from "../shared/calendar-adapters";

// The reported case, kept verbatim as the anchor for every assertion below:
//
//   "a recurring auto-loan liability for my 2025 Dodge Ram 1500, financed
//    through Capital Auto Finance, original loan amount $54,800, current
//    remaining balance $49,275, 6.49% APR, monthly payment $912.40 due on the
//    last day of every month, a 72-month term beginning March 31, 2025, and an
//    estimated payoff date of February 28, 2031"
//
// What came back was a bill: no principal, no original amount, no term, no
// amortization schedule, and a next due date of Aug 30 for a payment due the
// last day of the month.
const RAM = {
  termMonths: 72,
  loanStartDate: "2025-03-31",
  payoffDate: "2031-02-28",
  dueDay: 31,
};
const TODAY = "2026-08-02"; // the day the report came in

describe("deriveLoanTerms — the Dodge Ram auto loan", () => {
  it("keeps every stated term instead of dropping the ones with no home", () => {
    const t = deriveLoanTerms(RAM, TODAY);
    expect(t.termMonths).toBe(72);
    expect(t.loanStartDate).toBe("2025-03-31");
    expect(t.firstPaymentDate).toBe("2025-03-31");
    expect(t.payoffDate).toBe("2031-02-28");
    expect(t.dueDay).toBe(31);
  });

  it("puts the next payment on Aug 31, not Aug 30", () => {
    // The old path built `new Date(2026, 7, 31)` in server-local time and
    // formatted it in America/Los_Angeles, landing a day early.
    expect(deriveLoanTerms(RAM, TODAY).nextDueDate).toBe("2026-08-31");
  });

  it("derives the payoff date from the term when it wasn't stated", () => {
    // 72 payments starting Mar 31 2025 → the 72nd is 71 months later.
    const t = deriveLoanTerms({ ...RAM, payoffDate: undefined }, TODAY);
    expect(t.payoffDate).toBe("2031-02-28");
  });

  it("derives the term from the two endpoints when it wasn't stated", () => {
    const t = deriveLoanTerms({ ...RAM, termMonths: undefined }, TODAY);
    expect(t.termMonths).toBe(72);
  });

  it("counts payments already made off the contract term", () => {
    // Mar 2025 through Jul 2026 inclusive is 17 payments; Aug 31 is still ahead.
    expect(deriveLoanTerms(RAM, TODAY).remainingTermMonths).toBe(72 - 17);
  });

  it("ends the calendar series at payoff rather than recurring forever", () => {
    expect(deriveLoanTerms(RAM, TODAY).recurrenceEnd).toBe("2031-02-28");
  });

  it("stops producing a next due date once the loan is paid off", () => {
    expect(deriveLoanTerms(RAM, "2031-06-01").nextDueDate).toBeUndefined();
  });
});

describe("deriveLoanTerms — month-end handling", () => {
  it("clamps day 31 into short months without rolling into the next one", () => {
    // Feb 2027 has 28 days; the payment is due the 28th, not Mar 3.
    expect(deriveLoanTerms(RAM, "2027-02-01").nextDueDate).toBe("2027-02-28");
    expect(deriveLoanTerms(RAM, "2027-04-01").nextDueDate).toBe("2027-04-30");
  });

  it("does not let a clamped month drag the series off the 31st", () => {
    // April clamps to the 30th; May must return to the 31st. Stepping off the
    // previous occurrence instead of the anchor gave May 30.
    expect(deriveLoanTerms(RAM, "2027-05-01").nextDueDate).toBe("2027-05-31");
  });

  it("reads a last-day-of-month first payment as a last-day due day", () => {
    // A first payment on Sep 30 means the last day, not "the 30th" — which
    // would silently move the 31-day months to the 30th.
    const t = deriveLoanTerms({ termMonths: 12, loanStartDate: "2026-09-30" }, "2026-09-01");
    expect(t.dueDay).toBe(31);
    expect(t.payoffDate).toBe("2027-08-31");
  });

  it("leaves a mid-month due day exactly where it is", () => {
    const t = deriveLoanTerms({ termMonths: 60, loanStartDate: "2026-03-15" }, TODAY);
    expect(t.dueDay).toBe(15);
    expect(t.nextDueDate).toBe("2026-08-15");
  });

  it("today's own payment is still due today", () => {
    expect(deriveLoanTerms(RAM, "2026-08-31").nextDueDate).toBe("2026-08-31");
    expect(deriveLoanTerms(RAM, "2026-09-01").nextDueDate).toBe("2026-09-30");
  });
});

describe("deriveLoanTerms — partial input", () => {
  it("invents nothing from nothing", () => {
    expect(deriveLoanTerms({}, TODAY)).toEqual({});
  });

  it("a bare due day still yields the next occurrence", () => {
    expect(deriveLoanTerms({ dueDay: 15 }, TODAY).nextDueDate).toBe("2026-08-15");
    expect(deriveLoanTerms({ dueDay: 1 }, TODAY).nextDueDate).toBe("2026-09-01");
  });

  it("a stated remaining term wins over the computed one", () => {
    expect(deriveLoanTerms({ ...RAM, remainingTermMonths: 40 }, TODAY).remainingTermMonths).toBe(40);
  });

  it("an explicit next payment date wins over the computed one", () => {
    expect(deriveLoanTerms({ ...RAM, nextPaymentDate: "2026-09-15" }, TODAY).nextDueDate).toBe("2026-09-15");
  });

  it("ignores fat-fingered years the way the detail page does", () => {
    expect(deriveLoanTerms({ loanStartDate: "12024-03-31", termMonths: 72 }, TODAY).loanStartDate)
      .toBeUndefined();
  });
});

describe("buildAmortization — a payment due the last day of the month", () => {
  const rows = buildAmortization({
    currentBalance: 49275,
    annualInterestRate: 6.49,
    monthlyPayment: 912.4,
    firstPaymentDate: "2026-08-31",
    dueDay: 31,
  }).rows;

  it("produces a schedule at all", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("never overflows a short month into the 1st", () => {
    // setUTCMonth on Mar 31 gave May 1 — April has no 31st — and every later
    // row inherited the drift.
    for (const r of rows) expect(r.dueDate.slice(8)).not.toBe("01");
  });

  it("clamps short months and returns to the 31st afterwards", () => {
    const by = new Map(rows.map((r) => [r.dueDate.slice(0, 7), r.dueDate]));
    expect(by.get("2026-09")).toBe("2026-09-30");
    expect(by.get("2026-10")).toBe("2026-10-31");
    expect(by.get("2027-02")).toBe("2027-02-28");
    expect(by.get("2027-03")).toBe("2027-03-31");
    expect(by.get("2028-02")).toBe("2028-02-29"); // leap year
  });

  it("amortizes the balance down to zero", () => {
    // $49,275 at 6.49% paying $912.40 takes 65 payments — the contract has 55
    // left. The stated figures simply don't reconcile (72 months on $54,800 at
    // 6.49% wants ~$923/mo, not $912.40), which is why the Details card shows
    // the contract payoff date and the projected one as two separate rows
    // rather than quietly picking one.
    expect(rows.length).toBe(65);
    expect(rows[rows.length - 1].remainingBalance).toBeLessThan(0.01);
  });

  it("still honours an explicit anchor over the start date's own day", () => {
    const r = buildAmortization({
      currentBalance: 10000,
      annualInterestRate: 5,
      monthlyPayment: 500,
      firstPaymentDate: "2026-02-28",
      dueDay: 31,
    }).rows;
    expect(r[1].dueDate).toBe("2026-03-31");
  });
});

describe("isDebtLiability — the guard that keeps a loan a loan", () => {
  it("recognises an explicit debt subtype", () => {
    expect(isDebtLiability({ type: "liability", type_key: "auto_loan" })).toBe(true);
    expect(isDebtLiability({ type: "liability", type_key: "credit_card" })).toBe(true);
    expect(isDebtLiability({ type: "liability", type_key: "medical_debt" })).toBe(true);
  });

  it("treats recurring service bills as bills even with stray money on them", () => {
    expect(isDebtLiability({ type: "liability", type_key: "streaming", fields: { currentBalance: 20 } })).toBe(false);
    expect(isDebtLiability({ type: "liability", type_key: "phone_plan" })).toBe(false);
    expect(isDebtLiability({ type: "liability", type_key: "utility" })).toBe(false);
  });

  it("recognises legacy debt that predates subtypes, by its terms", () => {
    expect(isDebtLiability({ type: "liability", fields: { currentBalance: 49275 } })).toBe(true);
    expect(isDebtLiability({ type: "loan", fields: { annualInterestRate: 0.0649 } })).toBe(true);
    expect(isDebtLiability({ type: "liability", fields: { originalBalance: 54800 } })).toBe(true);
  });

  it("a subtype-less profile with no terms is not debt", () => {
    expect(isDebtLiability({ type: "liability", fields: { monthlyAmount: 90.5 } })).toBe(false);
    expect(isDebtLiability(null)).toBe(false);
    expect(isDebtLiability({ type: "vehicle", fields: { currentBalance: 100 } })).toBe(false);
  });
});

describe("deriveScheduleFields — bounding an amortizing series", () => {
  it("bounds the series by the CONTRACT term, counted from the first payment", () => {
    // generateSchedule counts occurrences from the anchor (the original first
    // payment), so using remainingTermMonths truncated the series by every
    // payment already made — a 72-month loan ended in 2029 instead of 2031.
    const f = deriveScheduleFields(
      { ...RAM, remainingTermMonths: 55, monthlyPayment: 912.4, firstPaymentDate: "2025-03-31" },
      "auto_loan",
      TODAY,
    );
    expect(f.count).toBe(72);
  });

  it("falls back to the remaining term when no contract term is on file", () => {
    const f = deriveScheduleFields(
      { remainingTermMonths: 55, monthlyPayment: 912.4, firstPaymentDate: "2025-03-31" },
      "auto_loan",
      TODAY,
    );
    expect(f.count).toBe(55);
  });

  it("carries the loan's payment amount into the schedule", () => {
    const f = deriveScheduleFields({ ...RAM, monthlyPayment: 912.4 }, "auto_loan", TODAY);
    expect(f.amount).toBe(912.4);
    expect(f.frequency).toBe("monthly");
  });
});

describe("the loan reaches the calendar without a second record", () => {
  // create_liability used to spawn an obligation named "<loan> payment" purely
  // so the payment appeared on the calendar — the very record that demoted the
  // loan. It isn't needed: a liability profile carrying the fields derived
  // above is already a calendar series in its own right.
  const profile = {
    id: "loan-1",
    type: "liability",
    type_key: "auto_loan",
    name: "Dodge Ram 2025 Auto Loan",
    fields: { monthlyPayment: 912.4, ...deriveLoanTerms(RAM, TODAY) },
  };

  it("emits one series for the loan itself", () => {
    const series = seriesFromLiabilityProfiles([profile]);
    expect(series).toHaveLength(1);
    expect(series[0].kind).toBe("liability");
    expect(series[0].title).toBe("Dodge Ram 2025 Auto Loan");
  });

  it("starts on the next payment and recurs monthly", () => {
    const [s] = seriesFromLiabilityProfiles([profile]);
    expect(s.baseDate).toBe("2026-08-31");
    expect(s.recurrence).toBe("monthly");
    expect(s.amount).toBe(912.4);
  });

  it("ends the series at the payoff date instead of running forever", () => {
    expect(seriesFromLiabilityProfiles([profile])[0].recurrenceEnd).toBe("2031-02-28");
  });
});

describe("recoveredDebtSubtype — reading a loan that is already stored as a bill", () => {
  // The guard stops NEW demotions; it cannot repair rows the bug already
  // rewrote. Those still render the bill layout — no principal, no original
  // amount, no APR, no schedule — and stay out of net worth until something
  // saves over them. The read path recovers them instead.
  const DEMOTED = {
    name: "Dodge Ram 2025 Auto Loan",
    type: "liability",
    type_key: "bill", // ← what the upsert wrote
    fields: {
      lender: "Capital Auto Finance",
      currentBalance: 49275,
      originalBalance: 54800,
      annualInterestRate: 0.0649,
      monthlyPayment: 912.4,
      // The bill payload's leftovers, still on the row.
      monthlyAmount: 912.4, amount: 912.4, source: "obligation",
      frequency: "monthly", status: "upcoming",
      firstPaymentDate: "2026-08-30", dueDate: "2026-08-30",
    },
  };

  it("reads the row back as the auto loan it is", () => {
    expect(recoveredDebtSubtype(DEMOTED)).toBe("auto_loan");
  });

  it("puts it back in the amortizing family, so the schedule renders", () => {
    expect(isAmortizable(recoveredDebtSubtype(DEMOTED))).toBe(true);
    expect(isRecurringBill(recoveredDebtSubtype(DEMOTED))).toBe(false);
  });

  it("counts the balance toward net worth again", () => {
    // $49,275 of debt silently left the total when the row became a "bill".
    expect(isNetWorthLiabilityProfile(DEMOTED)).toBe(true);
  });

  it("infers the subtype from the name for other debts", () => {
    const as = (name: string) => recoveredDebtSubtype({ ...DEMOTED, name });
    expect(as("123 Maple St Mortgage")).toBe("mortgage");
    expect(as("Sallie Mae Student Loan")).toBe("student_loan");
    expect(as("Chase Sapphire Visa")).toBe("credit_card");
    expect(as("HELOC on the house")).toBe("heloc");
  });

  it("falls back to a plain loan when the name says nothing", () => {
    expect(recoveredDebtSubtype({ ...DEMOTED, name: "Thing", fields: { ...DEMOTED.fields, lender: "" } }))
      .toBe("loan");
  });

  it("prefers a subtype stashed in the fields blob", () => {
    expect(recoveredDebtSubtype({ ...DEMOTED, fields: { ...DEMOTED.fields, subtype: "personal_loan" } }))
      .toBe("personal_loan");
  });
});

describe("recoveredDebtSubtype — genuine bills are left alone", () => {
  const bill = (name: string, fields: Record<string, any>) =>
    ({ name, type: "liability", type_key: "phone_plan", fields });

  it("does not promote a recurring bill that merely has an amount and a due date", () => {
    // Exactly the shape createObligation writes for a real bill.
    expect(recoveredDebtSubtype(bill("Verizon Wireless", {
      monthlyAmount: 90.5, amount: 90.5, frequency: "monthly",
      dueDate: "2026-08-15", nextDueDate: "2026-08-15",
      firstPaymentDate: "2026-08-15", autopay: false,
      category: "utilities", status: "upcoming", source: "obligation",
    }))).toBeNull();
  });

  it("does not promote a finite-term bill", () => {
    expect(recoveredDebtSubtype(bill("Gym Membership", {
      monthlyAmount: 45, count: 12, recurrenceEnd: "2027-07-01",
    }))).toBeNull();
  });

  it("does not promote a bill whose name happens to mention a car", () => {
    // Name hints only pick the subtype; they never trigger recovery on their own.
    expect(recoveredDebtSubtype(bill("Car Wash Subscription", { monthlyAmount: 30 }))).toBeNull();
  });

  it("leaves rows that are already read correctly untouched", () => {
    expect(recoveredDebtSubtype({ ...({} as any), name: "X", type: "liability", type_key: "auto_loan", fields: { annualInterestRate: 0.05 } })).toBeNull();
    expect(recoveredDebtSubtype({ name: "X", type: "vehicle", fields: { annualInterestRate: 0.05 } })).toBeNull();
  });
});
