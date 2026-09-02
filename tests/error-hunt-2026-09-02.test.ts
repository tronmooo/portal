// Regression coverage for the 2026-09-02 error-hunting round (see
// audit/bug-ledger-2026-09-02.md, entries D54+).
import { describe, it, expect } from "vitest";
import { addDays } from "../shared/timezone";
import {
  advanceLiabilityDueDate, advanceLiabilityDueDatePatch, liabilityAnchorDay,
} from "../shared/liability-recurrence";
import { generateSchedule } from "../shared/liability-schedule";
import { localTodayISO, localDaysFromNowISO } from "../client/src/lib/dates";
import { insertExpenseSchema, insertObligationSchema } from "../shared/schema";

// D54 — a monthly bill due on the 31st drifted to the 28th after one payment
// in a short month (Jan 31 → Feb 28 → Mar 28 → Apr 28), while the calendar,
// anchored on firstPaymentDate, kept saying the 31st.
describe("D54: advancing a stored due date keeps the series day-of-month", () => {
  it("returns to the 31st after the February clamp when the origin is known", () => {
    const f = { frequency: "monthly", firstPaymentDate: "2026-01-31", dueDate: "2026-02-28" };
    expect(advanceLiabilityDueDate(f, "2026-02-28")).toBe("2026-03-31");
  });
  it("walks Jan 31 → Feb 28 → Mar 31 → Apr 30 → May 31 through the pay path's patch", () => {
    let fields: any = { frequency: "monthly", dueDate: "2026-01-31" };
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const patch = advanceLiabilityDueDatePatch(fields, fields.dueDate);
      fields = { ...fields, ...patch };
      seen.push(fields.dueDate);
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    // The first advance pinned the origin so later ones could recover the 31st.
    expect(fields.firstPaymentDate).toBe("2026-01-31");
  });
  it("never overwrites an existing origin", () => {
    const patch = advanceLiabilityDueDatePatch({ frequency: "monthly", firstPaymentDate: "2025-10-15", dueDate: "2026-01-15" }, "2026-01-15");
    expect(patch).toEqual({ dueDate: "2026-02-15", nextDueDate: "2026-02-15" });
  });
  it("honours a deliberate move to a month-end that is not a clamp", () => {
    // User moved the bill from the 15th to the 28th of February on purpose:
    // 28 < 31 but the origin (15) is EARLIER, so 28 is the user's day.
    expect(liabilityAnchorDay({ firstPaymentDate: "2025-10-15" }, "2026-02-28")).toBe(28);
    // Any non-month-end day is always the user's own day.
    expect(liabilityAnchorDay({ firstPaymentDate: "2025-10-31" }, "2026-02-14")).toBe(14);
    expect(liabilityAnchorDay({}, "2026-02-28")).toBe(28);
    expect(liabilityAnchorDay({ firstPaymentDate: "2025-10-31" }, "2026-04-30")).toBe(31);
    expect(liabilityAnchorDay({}, "not a date")).toBeUndefined();
  });
  it("leaves weekly and daily cadences alone", () => {
    expect(advanceLiabilityDueDate({ frequency: "weekly", dueDate: "2026-02-28", firstPaymentDate: "2026-01-31" }, "2026-02-28")).toBe("2026-03-07");
  });
  it("agrees with the generated schedule after a payment", () => {
    const fields: any = { frequency: "monthly", monthlyAmount: 50, firstPaymentDate: "2026-01-31", dueDate: "2026-01-31", nextDueDate: "2026-01-31" };
    const paid = { ...fields, ...advanceLiabilityDueDatePatch(fields, "2026-01-31") };
    const again = { ...paid, ...advanceLiabilityDueDatePatch(paid, paid.dueDate) };
    const sched = generateSchedule({ id: "b1", fields: again }, [], { todayISO: "2026-03-01", windowStart: "2026-03-01", windowEnd: "2026-06-30" });
    expect(sched.map((o) => o.date)).toEqual(["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
    expect(again.dueDate).toBe("2026-03-31");
  });
});

// D55 — a cleared firstPaymentDate ("") took the bill off the calendar.
describe("D55: a blank series origin does not hide the bill", () => {
  it("falls through to the due date when firstPaymentDate is an empty string", () => {
    const sched = generateSchedule(
      { id: "b2", fields: { frequency: "monthly", monthlyAmount: 20, firstPaymentDate: "", dueDate: "2026-09-10" } },
      [],
      { todayISO: "2026-09-01", windowStart: "2026-09-01", windowEnd: "2026-10-31" },
    );
    expect(sched.map((o) => o.date)).toEqual(["2026-09-10", "2026-10-10"]);
  });
});

// D56 — shared addDays() formatted a host-local noon through toISOString(),
// which is a different calendar day for hosts at ±12h or beyond.
describe("D56: addDays is a calendar step in every host zone", () => {
  it("steps across DST and month boundaries by calendar day", () => {
    expect(addDays("2026-09-02", 1)).toBe("2026-09-03");
    expect(addDays("2026-03-31", 1)).toBe("2026-04-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // US spring-forward
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // US fall-back
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("matches a direct local-calendar computation for a year of days", () => {
    let cur = "2026-01-01";
    for (let i = 0; i < 365; i++) {
      const next = addDays(cur, 1);
      const d = new Date(`${cur}T12:00:00`);
      d.setDate(d.getDate() + 1);
      expect(next).toBe(d.toLocaleDateString("en-CA"));
      cur = next;
    }
  });
});

// D57 — client form defaults used the UTC date, which is tomorrow from late
// afternoon onward for every user west of Greenwich.
describe("D57: client 'today' defaults are the browser's calendar date", () => {
  it("localTodayISO is the local date, not the UTC one", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(localTodayISO()).toBe(expected);
    expect(localDaysFromNowISO(0)).toBe(expected);
  });
  it("localDaysFromNowISO steps whole local days", () => {
    const d = new Date(); d.setDate(d.getDate() + 7);
    expect(localDaysFromNowISO(7)).toBe(d.toLocaleDateString("en-CA"));
  });
});

import { expenseAttributionName } from "../shared/expense-attribution";
import { isSettledOccurrence } from "../shared/liability-recurrence";
import { taskOccurrenceDates } from "../shared/task-occurrences";
import { nextRecurringTaskSpawn } from "../shared/recurrence";

describe("D59 (helper): the name comes from the clause that carries the amount", () => {
  it("scopes 'for Mom' to the $50 clause", () => {
    const msg = "I spent $5 on coffee and $50 on groceries for Mom";
    expect(expenseAttributionName(msg, 5)).toBeNull();
    expect(expenseAttributionName(msg, 50)).toBe("Mom");
  });
  it("matches money tokens, not digit substrings", () => {
    expect(expenseAttributionName("paid 2025 dollars in taxes for Dad, then $5 on gum", 5)).toBeNull();
    expect(expenseAttributionName("$12.50 for lunch for Sarah", 12.5)).toBe("Sarah");
    expect(expenseAttributionName("gas 40 bucks for Al", 40)).toBe("Al");
    expect(expenseAttributionName("$40 for myself", 40)).toBeNull();
  });
});

describe("D69: the next due date skips occurrences already settled", () => {
  it("advances past an early-paid next occurrence", () => {
    const f = { frequency: "monthly", dueDate: "2026-09-15", occurrences: { "2026-10-15": { status: "paid" } } };
    expect(isSettledOccurrence(f, "2026-10-15")).toBe(true);
    expect(advanceLiabilityDueDate(f, "2026-09-15")).toBe("2026-11-15");
  });
  it("skips a skipped occurrence too, and stops at the first open one", () => {
    const f = { frequency: "monthly", dueDate: "2026-09-15", occurrences: { "2026-10-15": { status: "skipped" }, "2026-11-15": { status: "paid" } } };
    expect(advanceLiabilityDueDate(f, "2026-09-15")).toBe("2026-12-15");
  });
});

describe("D70: a completed recurring task no longer projects future dates", () => {
  const win = ["2026-09-01", "2026-09-30"] as const;
  it("a done weekly task yields only its own date; the spawned clone carries the series", () => {
    const done = taskOccurrenceDates({ dueDate: "2026-09-01", tags: ["recur:weekly"], status: "done" }, ...win, { todayISO: "2026-09-02" });
    expect(done).toEqual(["2026-09-01"]);
    const clone = taskOccurrenceDates({ dueDate: "2026-09-08", tags: ["recur:weekly"], status: "todo" }, ...win, { todayISO: "2026-09-02" });
    expect(clone).toEqual(["2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"]);
  });
  it("an open weekly task still projects", () => {
    expect(taskOccurrenceDates({ dueDate: "2026-09-01", tags: ["recur:weekly"], status: "todo" }, ...win)).toHaveLength(5);
  });
});

describe("D71: the spawned next occurrence honours every cadence and the series end", () => {
  it("steps every cadence the tag grammar allows", () => {
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-01", tags: ["recur:weekly"] })?.dueDate).toBe("2026-09-08");
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-01", tags: ["recur:every-3-weeks"] })?.dueDate).toBe("2026-09-22");
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-04", tags: ["recur:weekdays"] })?.dueDate).toBe("2026-09-07"); // Fri → Mon
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-01", tags: ["recur:yearly"] })?.dueDate).toBe("2027-09-01");
    expect(nextRecurringTaskSpawn({ dueDate: "2026-01-31", tags: ["recur:monthly"] })?.dueDate).toBe("2026-02-28");
  });
  it("pins the month anchor so the clone returns to the 31st", () => {
    const feb = nextRecurringTaskSpawn({ dueDate: "2026-01-31", tags: ["recur:monthly"] })!;
    expect(feb.tags).toContain("ranchor:31");
    expect(nextRecurringTaskSpawn({ dueDate: feb.dueDate, tags: feb.tags })?.dueDate).toBe("2026-03-31");
  });
  it("ends the series at runtil / rcount and counts completions", () => {
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-10", tags: ["recur:weekly", "runtil:2026-09-15"] })).toBeNull();
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-10", tags: ["recur:weekly", "rcount:3", "rdone:2"] })).toBeNull();
    const next = nextRecurringTaskSpawn({ dueDate: "2026-09-10", tags: ["recur:weekly", "rcount:3", "rdone:1", "chore"] })!;
    expect(next.dueDate).toBe("2026-09-17");
    expect(next.tags).toEqual(expect.arrayContaining(["chore", "recur:weekly", "rcount:3", "rdone:2"]));
  });
  it("does nothing for a one-time task", () => {
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-10", tags: [] })).toBeNull();
  });
});

import { contentSecurityPolicyFor, CONTENT_SECURITY_POLICY } from "../server/security-headers";

// D79 — `npm run dev` rendered a blank page: the production CSP blocked the
// Vite/React refresh inline preamble and plain-http local connections.
describe("D79: the development CSP lets the dev server render; production is untouched", () => {
  it("production keeps the canonical policy byte for byte", () => {
    expect(contentSecurityPolicyFor("production")).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/upgrade-insecure-requests/);
  });
  it("development allows the inline preamble, local http/ws, and no https upgrade", () => {
    const dev = contentSecurityPolicyFor("development");
    expect(dev).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(dev).toMatch(/connect-src[^;]*http:\/\/127\.0\.0\.1:\*/);
    expect(dev).toMatch(/connect-src[^;]*ws:\/\/localhost:\*/);
    expect(dev).not.toMatch(/upgrade-insecure-requests/);
    // Everything else is the production policy.
    expect(dev.replace(" 'unsafe-inline'", "").replace(" http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*", "") + "; upgrade-insecure-requests").toBe(CONTENT_SECURITY_POLICY);
  });
});

import { sumMonthlyIncome } from "../shared/obligation-windows";
import { isRecurrenceTag, userTags } from "../shared/recurrence";

// D80 — the hero cash-flow tile summed incomes at face value while the Finance
// tile converted them to monthly: a $2,600 biweekly paycheck was +$2,312 on one
// tile and +$5,345 on the next.
describe("D80: one monthly-income definition for every cash-flow surface", () => {
  it("converts each income by its frequency", () => {
    expect(sumMonthlyIncome([{ amount: 2600, frequency: "biweekly" }])).toBeCloseTo(2600 * 26 / 12, 2);
    expect(sumMonthlyIncome([{ amount: 1000, frequency: "weekly" }, { amount: 500, frequency: "monthly" }, { amount: 12000, frequency: "yearly" }])).toBeCloseTo(1000 * 52 / 12 + 500 + 1000, 2);
    expect(sumMonthlyIncome([{ amount: "250", frequency: undefined }])).toBe(250);
    expect(sumMonthlyIncome(null)).toBe(0);
  });
});

// D81 — recurrence grammar tags rendered as user tag chips ("recur:weekly", "rdone:1").
describe("D81: recurrence tags are internal, not labels", () => {
  it("recognises every tag of the grammar and nothing else", () => {
    for (const t of ["recur:weekly", "runtil:2026-12-31", "rcount:3", "rdone:1", "ranchor:31", "rpaused"]) expect(isRecurrenceTag(t), t).toBe(true);
    for (const t of ["chore", "recurring", "rpaused-thing", "home"]) expect(isRecurrenceTag(t), t).toBe(false);
    expect(userTags(["chore", "recur:weekly", "rdone:2", "home"])).toEqual(["chore", "home"]);
    expect(userTags(undefined)).toEqual([]);
  });
});

// D85/D86 — the calendar-day rule on the shared insert schemas.
describe("D85/D86: schema calendar days", () => {
  it("expense date: blank is absent, a timestamp keeps its day, free text fails", () => {
    expect(insertExpenseSchema.parse({ amount: 1, description: "x" }).date).toBeUndefined();
    expect(insertExpenseSchema.parse({ amount: 1, description: "x", date: "" }).date).toBeUndefined();
    expect(insertExpenseSchema.parse({ amount: 1, description: "x", date: " 2026-09-10 " }).date).toBe("2026-09-10");
    expect(insertExpenseSchema.parse({ amount: 1, description: "x", date: "2026-09-10T23:30:00.000Z" }).date).toBe("2026-09-10");
    for (const bad of ["yesterdayish", "2026-13-45", "2026-9-1", "09/10/2026"]) {
      expect(insertExpenseSchema.safeParse({ amount: 1, description: "x", date: bad }).success, bad).toBe(false);
    }
  });
  it("bill nextDueDate is required and must be a real day; recurrenceEnd may be blank", () => {
    expect(insertObligationSchema.safeParse({ name: "b", amount: 1 }).success).toBe(false);
    expect(insertObligationSchema.safeParse({ name: "b", amount: 1, nextDueDate: "next week" }).success).toBe(false);
    expect(insertObligationSchema.safeParse({ name: "b", amount: 1, nextDueDate: "" }).success).toBe(false);
    const ok = insertObligationSchema.parse({ name: "b", amount: 1, nextDueDate: "2026-09-05T00:00:00Z", recurrenceEnd: "" });
    expect(ok.nextDueDate).toBe("2026-09-05");
    expect(ok.recurrenceEnd).toBeUndefined();
    expect(insertObligationSchema.parse({ name: "b", amount: 1, nextDueDate: "2026-09-05", recurrenceEnd: "2027-01-31" }).recurrenceEnd).toBe("2027-01-31");
    expect(insertObligationSchema.safeParse({ name: "b", amount: 1, nextDueDate: "2026-09-05", recurrenceEnd: "never" }).success).toBe(false);
  });
});
