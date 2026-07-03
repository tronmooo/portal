import { describe, it, expect } from "vitest";
import { generateSchedule, nextDueOccurrence, periodsPerYear, scheduleCounts, deriveScheduleFields } from "../shared/liability-schedule";

const TODAY = "2026-07-02";

function bill(fields: Record<string, any>) {
  return { id: "liab-1", fields: { frequency: "monthly", amount: 86.5, ...fields } };
}

describe("generateSchedule", () => {
  it("generates a monthly series across a 12-month window", () => {
    const s = generateSchedule(bill({ dueDate: "2026-07-15" }), [], { todayISO: TODAY, months: 12 });
    expect(s.length).toBe(12);
    expect(s[0].date).toBe("2026-07-15");
    expect(s[0].amount).toBe(86.5);
    expect(s[1].date).toBe("2026-08-15");
    // Every occurrence carries a stable synthetic id and is upcoming.
    expect(s[0].occurrenceId).toBe("liab-1:2026-07-15");
    expect(s.every((o) => o.status === "upcoming" || o.status === "due_today")).toBe(true);
  });

  it("marks a due-today occurrence and past-due ones correctly", () => {
    const s = generateSchedule(bill({ dueDate: "2026-06-15" }), [], {
      todayISO: TODAY, windowStart: "2026-06-01", months: 3,
    });
    expect(s.find((o) => o.date === "2026-06-15")!.status).toBe("overdue");
    const dueToday = generateSchedule(bill({ dueDate: "2026-07-02" }), [], { todayISO: TODAY, months: 2 });
    expect(dueToday[0].status).toBe("due_today");
  });

  it("treats a matching payment as paid", () => {
    const s = generateSchedule(bill({ dueDate: "2026-06-15" }), [{ id: "pay-9", paymentDate: "2026-06-15", amount: 86.5 }], {
      todayISO: TODAY, windowStart: "2026-06-01", months: 3,
    });
    const june = s.find((o) => o.date === "2026-06-15")!;
    expect(june.status).toBe("paid");
    expect(june.paymentId).toBe("pay-9");
  });

  it("honors a skip override (occurrence stays but is marked skipped)", () => {
    const s = generateSchedule(bill({ dueDate: "2026-07-15", occurrences: { "2026-08-15": { status: "skipped" } } }), [], {
      todayISO: TODAY, months: 4,
    });
    expect(s.find((o) => o.date === "2026-08-15")!.status).toBe("skipped");
    expect(s.find((o) => o.date === "2026-08-15")!.overridden).toBe(true);
  });

  it("honors a reschedule override (movedTo shifts the effective date only)", () => {
    const s = generateSchedule(bill({ dueDate: "2026-07-15", occurrences: { "2026-09-15": { movedTo: "2026-09-18" } } }), [], {
      todayISO: TODAY, months: 4,
    });
    const sep = s.find((o) => o.date === "2026-09-15")!;
    expect(sep.effectiveDate).toBe("2026-09-18");
    expect(sep.date).toBe("2026-09-15");
  });

  it("honors a per-occurrence amount override", () => {
    const s = generateSchedule(bill({ dueDate: "2026-07-15", occurrences: { "2026-07-15": { amount: 95 } } }), [], {
      todayISO: TODAY, months: 2,
    });
    expect(s[0].amount).toBe(95);
  });

  it("suppresses occurrences while paused until the resume date", () => {
    const s = generateSchedule(bill({ dueDate: "2026-07-15", paused: true, pausedUntil: "2026-10-01" }), [], {
      todayISO: TODAY, months: 6,
    });
    // Jul/Aug/Sep suppressed; Oct onward returns.
    expect(s.some((o) => o.date < "2026-10-01")).toBe(false);
    expect(s.some((o) => o.date >= "2026-10-01")).toBe(true);
  });

  it("handles weekly / quarterly-ish / yearly frequencies", () => {
    expect(generateSchedule(bill({ frequency: "weekly", dueDate: "2026-07-06" }), [], { todayISO: TODAY, months: 1 }).length).toBeGreaterThanOrEqual(4);
    expect(generateSchedule(bill({ frequency: "yearly", dueDate: "2026-08-01" }), [], { todayISO: TODAY, months: 12 }).length).toBe(1);
  });

  it("nextDueOccurrence skips paid/skipped and returns the first open one", () => {
    const next = nextDueOccurrence(
      bill({ dueDate: "2026-07-15", occurrences: { "2026-07-15": { status: "skipped" } } }),
      [],
      TODAY,
    );
    expect(next!.date).toBe("2026-08-15");
  });

  it("keeps a paid past occurrence visible after dueDate advanced past it", () => {
    // Simulates the state right after paying July: dueDate moved to Aug, and
    // July carries a paid override. July must still appear (not vanish).
    const s = generateSchedule(
      bill({ dueDate: "2026-08-15", firstPaymentDate: "2026-07-15", occurrences: { "2026-07-15": { status: "paid", paymentId: "p1" } } }),
      [{ id: "p1", paymentDate: "2026-07-15" }],
      { todayISO: TODAY, windowStart: "2026-05-01", months: 6 },
    );
    const july = s.find((o) => o.date === "2026-07-15");
    expect(july).toBeTruthy();
    expect(july!.status).toBe("paid");
  });

  it("honors a finite count — generates exactly N occurrences and reports remaining", () => {
    const b = bill({ dueDate: "2026-08-15", firstPaymentDate: "2026-08-15", count: 10, amount: 9.99 });
    const s = generateSchedule(b, [], { todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2028-12-31" });
    expect(s.length).toBe(10);
    expect(s[9].date).toBe("2027-05-15");
    const c0 = scheduleCounts(b, [], TODAY);
    expect(c0).toEqual({ totalPayments: 10, paidCount: 0, remainingPayments: 10 });
    const c1 = scheduleCounts(b, [{ id: "p", paymentDate: "2026-08-15" }], TODAY);
    expect(c1.remainingPayments).toBe(9);
  });

  it("honors recurrenceEnd as a hard stop", () => {
    const s = generateSchedule(bill({ dueDate: "2026-08-15", recurrenceEnd: "2026-11-15" }), [], { todayISO: TODAY, months: 24 });
    expect(s.map((o) => o.date)).toEqual(["2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15"]);
  });

  it("open-ended bill has null remaining", () => {
    expect(scheduleCounts(bill({ dueDate: "2026-08-15" }), [], TODAY).remainingPayments).toBeNull();
  });

  it("deriveScheduleFields turns an amortizing loan into a monthly payment series", () => {
    // Auto loan: $500/mo, 24 months remaining, due the 10th — no bill fields.
    const f = deriveScheduleFields({ monthlyPayment: 500, remainingTermMonths: 24, dueDay: 10, currentBalance: 12000 }, "auto_loan", TODAY);
    expect(f.frequency).toBe("monthly");
    expect(f.amount).toBe(500);
    expect(/-10$/.test(f.dueDate)).toBe(true);
    expect(f.count).toBe(24);
    const s = generateSchedule({ id: "loan", fields: f }, [], { todayISO: TODAY, months: 12 });
    expect(s.length).toBe(12);
    expect(s.every((o) => o.amount === 500)).toBe(true);
  });

  it("deriveScheduleFields leaves a recurring bill untouched, and a one-time debt gets a single occurrence", () => {
    const bf = deriveScheduleFields({ monthlyAmount: 9.99, frequency: "monthly", dueDate: "2026-08-15", count: 10 }, "streaming", TODAY);
    expect(bf.count).toBe(10);
    const one = deriveScheduleFields({ currentBalance: 1200, monthlyPayment: 1200, dueDate: "2026-09-01" }, "medical_debt", TODAY);
    expect(one.count).toBe(1);
  });

  it("periodsPerYear reflects frequency", () => {
    expect(periodsPerYear(bill({ frequency: "monthly" }))).toBe(12);
    expect(periodsPerYear(bill({ frequency: "yearly" }))).toBe(1);
    expect(periodsPerYear(bill({ frequency: "weekly" }))).toBe(52);
  });
});
