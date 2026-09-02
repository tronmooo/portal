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

// D88 — scope membership ignored ancestry: a bill linked to the user's car
// (parent: Self) vanished from the Self view's bills list and cash flow.
import { passesProfileFilter } from "../shared/profile-filter";
import { ownerCandidatesForProfile, withAncestorOwnerIds, isInScope } from "../shared/scope";
describe("D88: an item linked to something you own is in your scope", () => {
  const SELF = { id: "self", type: "self" };
  const LINDA = { id: "linda", type: "person" };
  const CAR = { id: "car", type: "vehicle", parentProfileId: "self" };
  const LINDA_CAR = { id: "lcar", type: "vehicle", parentProfileId: "linda" };
  const POLICY = { id: "policy", type: "liability", parentProfileId: "lcar" };
  const ALL = [SELF, LINDA, CAR, LINDA_CAR, POLICY];
  it("passesProfileFilter walks the parent chain of each linked profile", () => {
    expect(passesProfileFilter(["car"], { selectedIds: ["self"], allProfiles: ALL })).toBe(true);
    expect(passesProfileFilter(["car"], { selectedIds: ["linda"], allProfiles: ALL })).toBe(false);
    // two levels: Linda's car's insurance policy is Linda's
    expect(passesProfileFilter(["policy"], { selectedIds: ["linda"], allProfiles: ALL })).toBe(true);
    expect(passesProfileFilter(["policy"], { selectedIds: ["self"], allProfiles: ALL })).toBe(false);
    // unchanged: an unlinked item is Self's, a person-linked one is theirs
    expect(passesProfileFilter([], { selectedIds: ["self"], allProfiles: ALL })).toBe(true);
    expect(passesProfileFilter(["linda"], { selectedIds: ["self"], allProfiles: ALL })).toBe(false);
    // a lite profile list without parents degrades to the old direct rule
    expect(passesProfileFilter(["car"], { selectedIds: ["self"], allProfiles: [{ id: "self", type: "self" }, { id: "car", type: "vehicle" }] })).toBe(false);
  });
  it("ownerCandidatesForProfile includes every ancestor when given the profile list", () => {
    expect(ownerCandidatesForProfile(POLICY, null, null, ALL)).toEqual(["policy", "lcar", "linda"]);
    expect(ownerCandidatesForProfile(POLICY, null, null)).toEqual(["policy", "lcar"]);
    expect(isInScope(ownerCandidatesForProfile(POLICY, null, null, ALL), { selectedIds: ["linda"], selfIds: new Set() }, "out_of_scope")).toBe(true);
  });
  it("withAncestorOwnerIds is cycle-safe and keeps unknown ids", () => {
    const loop = [{ id: "a", parentProfileId: "b" }, { id: "b", parentProfileId: "a" }];
    expect(withAncestorOwnerIds(["a"], loop)).toEqual(["a", "b"]);
    expect(withAncestorOwnerIds(["ghost", "a"], loop)).toEqual(["ghost", "a", "b"]);
    expect(withAncestorOwnerIds(["x"], [])).toEqual(["x"]);
  });
});

// D93 — a habit's scheduled time could not be cleared with "" (400), unlike
// a task's dueTime; storage already stores "" as null.
import { insertHabitSchema } from "../shared/schema";
describe("D93: habit scheduledTime accepts '' as clear", () => {
  it("accepts '', null and HH:MM; rejects 9am", () => {
    for (const v of ["", null, "07:30"]) expect(insertHabitSchema.partial().safeParse({ scheduledTime: v }).success, String(v)).toBe(true);
    expect(insertHabitSchema.partial().safeParse({ scheduledTime: "9am" }).success).toBe(false);
  });
});

// D94 — goal deadlines took any string (create and edit).
import { insertGoalSchema } from "../shared/schema";
describe("D94: a goal deadline is a real calendar day or blank", () => {
  const base = { title: "g", type: "custom" as const, target: 1, unit: "x" };
  it("accepts a day, a timestamp's day and blank; rejects free text and impossible days", () => {
    expect(insertGoalSchema.parse({ ...base, deadline: "2026-12-31" }).deadline).toBe("2026-12-31");
    expect(insertGoalSchema.parse({ ...base, deadline: "2026-12-31T08:00:00.000Z" }).deadline).toBe("2026-12-31");
    expect(insertGoalSchema.parse({ ...base, deadline: "" }).deadline).toBeUndefined();
    expect(insertGoalSchema.parse({ ...base }).deadline).toBeUndefined();
    for (const bad of ["next month", "someday", "2026-13-45", "2026-02-30"]) {
      expect(insertGoalSchema.safeParse({ ...base, deadline: bad }).success, bad).toBe(false);
      expect(insertGoalSchema.partial().safeParse({ deadline: bad }).success, `partial ${bad}`).toBe(false);
    }
  });
});

// D95 — income `date` was the last free-text day field on a money record.
import { insertIncomeSchema } from "../shared/schema";
describe("D95: an income date is a real calendar day or blank", () => {
  const base = { description: "Pay", amount: 100, frequency: "monthly" as const };
  it("keeps a day, blanks '', rejects free text", () => {
    expect(insertIncomeSchema.parse({ ...base, date: "2026-09-15" }).date).toBe("2026-09-15");
    expect(insertIncomeSchema.parse({ ...base, date: "" }).date).toBeUndefined();
    for (const bad of ["next friday", "2026-13-45"]) {
      expect(insertIncomeSchema.safeParse({ ...base, date: bad }).success, bad).toBe(false);
      expect(insertIncomeSchema.partial().safeParse({ date: bad }).success, `partial ${bad}`).toBe(false);
    }
  });
});

// D96 — the Cash Flow Trend painted today's income across all six months.
import { sumMonthlyIncomeForMonth } from "../shared/obligation-windows";
describe("D96: income counts only from its first pay month", () => {
  const incomes = [
    { amount: 2600, frequency: "biweekly", date: "2026-08-28" },
    { amount: 300, frequency: "monthly" }, // undated: always
  ];
  it("excludes an income from months before its date and includes it from that month on", () => {
    expect(sumMonthlyIncomeForMonth(incomes, "2026-04")).toBeCloseTo(300, 6);
    expect(sumMonthlyIncomeForMonth(incomes, "2026-07")).toBeCloseTo(300, 6);
    expect(sumMonthlyIncomeForMonth(incomes, "2026-08")).toBeCloseTo(300 + 2600 * 26 / 12, 6);
    expect(sumMonthlyIncomeForMonth(incomes, "2026-09")).toBeCloseTo(300 + 2600 * 26 / 12, 6);
    expect(sumMonthlyIncomeForMonth([], "2026-09")).toBe(0);
  });
});

// D101–D102 — bill lifecycle words the calendar and the totals disagreed on.
import { generateSchedule } from "../shared/liability-schedule";
import { isActiveObligation, isUpcomingBill } from "../shared/obligation-windows";
describe("D101: a bill paused or cancelled through its status draws no future occurrences", () => {
  const fields = (extra: any) => ({ amount: 40, frequency: "monthly", dueDate: "2026-09-07", firstPaymentDate: "2026-09-07", ...extra });
  const opts = { todayISO: "2026-09-02", windowStart: "2026-09-02", windowEnd: "2026-11-30" };
  it("status paused behaves like fields.paused; cancelled ignores pausedUntil", () => {
    expect(generateSchedule({ id: "b", fields: fields({}) }, [], opts).length).toBeGreaterThanOrEqual(3);
    expect(generateSchedule({ id: "b", fields: fields({ status: "paused" }) }, [], opts).filter(o => o.status !== "paid" && o.status !== "skipped")).toHaveLength(0);
    expect(generateSchedule({ id: "b", fields: fields({ paused: true }) }, [], opts).filter(o => o.status !== "paid" && o.status !== "skipped")).toHaveLength(0);
    expect(generateSchedule({ id: "b", fields: fields({ status: "cancelled", pausedUntil: "2026-09-20" }) }, [], opts).filter(o => o.status !== "paid" && o.status !== "skipped")).toHaveLength(0);
    // a pause with an end date resumes after it
    const resumed = generateSchedule({ id: "b", fields: fields({ status: "paused", pausedUntil: "2026-10-01" }) }, [], opts).filter(o => o.status !== "paid" && o.status !== "skipped");
    expect(resumed.length).toBeGreaterThanOrEqual(1);
    expect(resumed.every(o => o.date >= "2026-10-01")).toBe(true);
  });
});
describe("D102: a finite series past its end is not active", () => {
  it("drops out of the monthly total and the upcoming list; an open-ended or in-range series stays", () => {
    expect(isActiveObligation({ status: "active", nextDueDate: "2026-09-04", recurrenceEnd: "2026-09-01" })).toBe(false);
    expect(isUpcomingBill({ status: "active", nextDueDate: "2026-09-04", recurrenceEnd: "2026-09-01" }, new Date("2026-09-02T12:00:00Z"))).toBe(false);
    expect(isActiveObligation({ status: "active", nextDueDate: "2026-09-04", recurrenceEnd: "2026-09-04" })).toBe(true);
    expect(isActiveObligation({ status: "active", nextDueDate: "2026-09-04" })).toBe(true);
    expect(isActiveObligation({ status: "active", nextDueDate: "2026-09-04", recurrenceEnd: "never" })).toBe(true);
    expect(isActiveObligation({ status: "paused", nextDueDate: "2026-09-04" })).toBe(false);
  });
});

// D103 (root) — "once" fell into the generic cadence and advanced by a day.
import { advanceLiabilityDueDate, advanceLiabilityDueDatePatch, isOneTimeFrequency } from "../shared/liability-recurrence";
describe("D103: a one-time bill never advances its due date", () => {
  it("keeps the date on pay for every spelling of once; a monthly bill still advances", () => {
    for (const f of ["once", "one-time", "one_time", "single", "One Time"]) {
      expect(isOneTimeFrequency(f), f).toBe(true);
      expect(advanceLiabilityDueDate({ frequency: f, dueDate: "2026-09-05" }, "2026-09-02"), f).toBe("2026-09-05");
      expect(advanceLiabilityDueDatePatch({ frequency: f, dueDate: "2026-09-05" }, "2026-09-05").dueDate, f).toBe("2026-09-05");
    }
    expect(isOneTimeFrequency("monthly")).toBe(false);
    expect(advanceLiabilityDueDate({ frequency: "monthly", dueDate: "2026-09-05" }, "2026-09-02")).toBe("2026-10-05");
  });
});

// D107 — a weekly habit's streak broke on every off-day.
import { calculateStreak } from "../shared/streak";
import { isHabitDueOn } from "../shared/habit-schedule";
describe("D107: streaks follow the habit's schedule", () => {
  const mwf = { frequency: "weekly", targetDays: [1, 3, 5] }; // Mon/Wed/Fri
  const sched = (d: string) => isHabitDueOn(mwf, d);
  it("Mon/Wed/Fri check-ins are a streak of scheduled days; off-days neither count nor break", () => {
    // 2026-08-31 Mon, 09-02 Wed, 09-04 Fri; today Sat 09-05
    const r = calculateStreak(["2026-08-31", "2026-09-02", "2026-09-04"], { today: "2026-09-05", isScheduled: sched });
    expect(r).toEqual({ current: 3, longest: 3 });
    // an off-day check-in (Tue) is ignored, not counted
    expect(calculateStreak(["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-04"], { today: "2026-09-05", isScheduled: sched }).current).toBe(3);
  });
  it("today (scheduled, not yet done) keeps the run alive; a missed scheduled day ends it", () => {
    // today Fri 09-04 not yet checked: Mon + Wed still count
    expect(calculateStreak(["2026-08-31", "2026-09-02"], { today: "2026-09-04", isScheduled: sched }).current).toBe(2);
    // missed Wed: only Fri counts
    expect(calculateStreak(["2026-08-31", "2026-09-04"], { today: "2026-09-05", isScheduled: sched })).toEqual({ current: 1, longest: 1 });
    // last check-in a week ago with scheduled days missed since → 0 current, longest kept
    expect(calculateStreak(["2026-08-24", "2026-08-26"], { today: "2026-09-05", isScheduled: sched })).toEqual({ current: 0, longest: 2 });
  });
  it("without a schedule the daily rule is unchanged", () => {
    expect(calculateStreak(["2026-09-03", "2026-09-04"], { today: "2026-09-05" })).toEqual({ current: 2, longest: 2 });
    expect(calculateStreak(["2026-09-01", "2026-09-04"], { today: "2026-09-05" })).toEqual({ current: 1, longest: 1 });
  });
});

// D111 — the last regex-only day gates: habit start/end, payment dates,
// the account adjustment date (which was stored as-is).
import { insertLiabilityPaymentSchema } from "../shared/schema";
import { applyBalanceAdjustment } from "../shared/finance-accounts";
describe("D111: every day field is a real calendar day", () => {
  it("habit start/end and payment dates reject impossible days", () => {
    expect(insertHabitSchema.partial().safeParse({ startDate: "2026-02-30" }).success).toBe(false);
    expect(insertHabitSchema.partial().safeParse({ endDate: "2026-09-31" }).success).toBe(false);
    expect(insertHabitSchema.partial().safeParse({ startDate: "2026-09-01", endDate: "" }).success).toBe(true);
    const base = { liabilityProfileId: "33333333-3333-4333-8333-333333333333", amount: 10 };
    expect(insertLiabilityPaymentSchema.safeParse({ ...base, paymentDate: "2026-13-45" }).success).toBe(false);
    expect(insertLiabilityPaymentSchema.safeParse({ ...base, paymentDate: "2026-09-02T10:00:00Z" }).success).toBe(true);
  });
  it("a balance adjustment with an unreadable date falls back to today instead of storing it", () => {
    const acct = { id: "a", type: "account", fields: { balance: 100, accountKind: "checking" } };
    expect(applyBalanceAdjustment(acct, { delta: 5, date: "2026-13-45" }, "2026-09-02").fields.balanceAsOf).toBe("2026-09-02");
    expect(applyBalanceAdjustment(acct, { delta: 5, date: "2026-09-01" }, "2026-09-02").fields.balanceAsOf).toBe("2026-09-01");
  });
});

// D115 — money fields on profiles took anything.
import { validateProfileMoneyFields } from "../shared/quick-add";
describe("D115: profile money fields are finite, bounded numbers", () => {
  it("normalises '$14,500', rejects words, negatives (except balances) and absurd sizes", () => {
    const f: any = { estimatedValue: "$14,500", balance: "-120.5", name: "Civic" };
    expect(validateProfileMoneyFields(f)).toBeNull();
    expect(f.estimatedValue).toBe(14500); expect(f.balance).toBe(-120.5);
    expect(validateProfileMoneyFields({ currentBalance: "eight thousand" })).toMatch(/must be a number/);
    expect(validateProfileMoneyFields({ estimatedValue: -5 })).toMatch(/cannot be negative/);
    expect(validateProfileMoneyFields({ estimatedValue: 1e12 })).toMatch(/too large/);
    expect(validateProfileMoneyFields({ estimatedValue: "" , monthlyPayment: null })).toBeNull();
    expect(validateProfileMoneyFields(undefined)).toBeNull();
  });
});

// D120 — only expenses widened a person's selection with the assets they
// co-own (asset_party_links); bills, tasks, events, documents and the
// timeline used the bare selection, so the co-owned car's insurance was
// missing under the co-owner while its fuel showed.
import { passesProfileFilter, effectiveSelection, pushdownSelection } from "../shared/profile-filter";
describe("D120: co-ownership widens every scoped list, not just expenses", () => {
  const SELF_P = { id: "self", type: "self" };
  const LINDA_P = { id: "linda", type: "person" };
  const CAR_P = { id: "car-1", type: "vehicle", parentProfileId: "self" };
  const allProfiles = [SELF_P, LINDA_P, CAR_P];
  const links = [{ assetProfileId: "car-1", partyProfileId: "linda" }];

  it("an item linked to the car passes for a co-owner party", () => {
    expect(passesProfileFilter(["car-1"], { selectedIds: ["linda"], allProfiles, assetPartyLinks: links })).toBe(true);
  });
  it("without the party link the co-owner does not see the car's items", () => {
    expect(passesProfileFilter(["car-1"], { selectedIds: ["linda"], allProfiles })).toBe(false);
    expect(passesProfileFilter(["car-1"], { selectedIds: ["linda"], allProfiles, assetPartyLinks: [] })).toBe(false);
  });
  it("the owner still sees the car through the parent chain and the widening never leaks a person's own items", () => {
    expect(passesProfileFilter(["car-1"], { selectedIds: ["self"], allProfiles, assetPartyLinks: links })).toBe(true);
    expect(passesProfileFilter(["self"], { selectedIds: ["linda"], allProfiles, assetPartyLinks: links })).toBe(false);
  });
  it("effectiveSelection adds only co-owned assets and leaves an empty selection empty", () => {
    expect(effectiveSelection({ selectedIds: ["linda"], allProfiles, assetPartyLinks: links }).sort()).toEqual(["car-1", "linda"]);
    expect(effectiveSelection({ selectedIds: ["linda"], allProfiles })).toEqual(["linda"]);
    expect(effectiveSelection({ selectedIds: [], allProfiles, assetPartyLinks: links })).toEqual([]);
    // A person is never treated as an asset even if a link names them.
    expect(effectiveSelection({ selectedIds: ["linda"], allProfiles, assetPartyLinks: [{ assetProfileId: "self", partyProfileId: "linda" }] })).toEqual(["linda"]);
  });
});

describe("D120: pushdownSelection is the containment-side form of the same rule", () => {
  const profiles = [
    { id: "self", type: "self" },
    { id: "mike", type: "person" },
    { id: "linda", type: "person" },
    { id: "car-1", type: "vehicle", parentProfileId: "self" },
    { id: "dog-1", type: "pet", parentProfileId: "mike" },
    { id: "policy-1", type: "document", parentProfileId: "dog-1" },
  ];
  const links = [{ assetProfileId: "car-1", partyProfileId: "linda" }];
  it("adds every descendant of the selection and the co-owned assets", () => {
    expect(pushdownSelection({ selectedIds: ["mike"], allProfiles: profiles }).sort()).toEqual(["dog-1", "mike", "policy-1"]);
    expect(pushdownSelection({ selectedIds: ["linda"], allProfiles: profiles, assetPartyLinks: links }).sort()).toEqual(["car-1", "linda"]);
    expect(pushdownSelection({ selectedIds: [], allProfiles: profiles })).toEqual([]);
  });
  it("agrees with passesProfileFilter on every linked row", () => {
    const rows = [["car-1"], ["dog-1"], ["policy-1"], ["self"], ["mike"], ["linda"], ["car-1", "mike"]];
    for (const selected of [["mike"], ["linda"], ["self"], ["linda", "mike"]]) {
      const ctx = { selectedIds: selected, allProfiles: profiles, assetPartyLinks: links };
      const push = new Set(pushdownSelection(ctx));
      for (const linked of rows) {
        expect(linked.some((id) => push.has(id)), `${selected} / ${linked}`).toBe(passesProfileFilter(linked, ctx));
      }
    }
  });
  it("survives a parent cycle", () => {
    const cyc = [{ id: "a", type: "person", parentProfileId: "b" }, { id: "b", type: "pet", parentProfileId: "a" }];
    expect(pushdownSelection({ selectedIds: ["a"], allProfiles: cyc }).sort()).toEqual(["a", "b"]);
  });
});
