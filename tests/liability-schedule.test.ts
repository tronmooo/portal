import { describe, it, expect } from "vitest";
import { generateSchedule, nextDueOccurrence, periodsPerYear } from "../shared/liability-schedule";

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

  it("periodsPerYear reflects frequency", () => {
    expect(periodsPerYear(bill({ frequency: "monthly" }))).toBe(12);
    expect(periodsPerYear(bill({ frequency: "yearly" }))).toBe(1);
    expect(periodsPerYear(bill({ frequency: "weekly" }))).toBe(52);
  });
});
