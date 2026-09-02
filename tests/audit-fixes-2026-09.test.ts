// Regression coverage for the 2026-09 audit fixes:
//   - date-only due dates compared as calendar days (a bill due TODAY is not overdue)
//   - one upcoming-bill predicate for the KPI tile and the popup (status rule included)
//   - CSRF exemptions match the mount-stripped path Express actually hands the middleware
import { describe, it, expect, vi } from "vitest";
import { localDayOf, getUserToday, addDays } from "../shared/timezone";
import { isUpcomingBill, toMonthlyAmount, UPCOMING_BILL_WINDOW_DAYS } from "../shared/obligation-windows";
import { csrfOriginCheck } from "../server/security-headers";
import { generateSmartInsights } from "../server/insights-engine";

const TZ = "America/Los_Angeles";

describe("localDayOf", () => {
  it("returns a bare YYYY-MM-DD unchanged", () => {
    expect(localDayOf("2026-09-02", TZ)).toBe("2026-09-02");
  });
  it("maps an instant to the calendar day in the given zone", () => {
    // 03:00 UTC on Sep 3 is still Sep 2 in Los Angeles.
    expect(localDayOf("2026-09-03T03:00:00Z", TZ)).toBe("2026-09-02");
    expect(localDayOf(new Date("2026-09-03T03:00:00Z"), "UTC")).toBe("2026-09-03");
  });
  it("returns null for empty or invalid input", () => {
    expect(localDayOf(null, TZ)).toBeNull();
    expect(localDayOf("not a date", TZ)).toBeNull();
  });
});

describe("isUpcomingBill", () => {
  const now = new Date("2026-09-02T18:00:00Z");
  const due = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  it("includes bills due today, overdue bills, and bills inside the window", () => {
    expect(isUpcomingBill({ nextDueDate: due(0) }, now)).toBe(true);
    expect(isUpcomingBill({ nextDueDate: due(-5) }, now)).toBe(true);
    expect(isUpcomingBill({ nextDueDate: due(UPCOMING_BILL_WINDOW_DAYS - 1) }, now)).toBe(true);
  });
  it("excludes bills beyond the window", () => {
    expect(isUpcomingBill({ nextDueDate: due(UPCOMING_BILL_WINDOW_DAYS + 2) }, now)).toBe(false);
  });
  it("excludes paused and cancelled bills — the popup never listed them, the tile counted them", () => {
    expect(isUpcomingBill({ nextDueDate: due(3), status: "paused" }, now)).toBe(false);
    expect(isUpcomingBill({ nextDueDate: due(3), status: "cancelled" }, now)).toBe(false);
    expect(isUpcomingBill({ nextDueDate: due(3), status: "active" }, now)).toBe(true);
  });
  it("uses exact monthly multipliers, including biweekly", () => {
    expect(toMonthlyAmount(100, "biweekly")).toBeCloseTo(100 * 26 / 12, 6);
    expect(toMonthlyAmount(100, "weekly")).toBeCloseTo(100 * 52 / 12, 6);
  });
});

describe("csrfOriginCheck (mounted under /api, so req.path has no /api prefix)", () => {
  function run(path: string, headers: Record<string, string>) {
    const req: any = { method: "POST", path, headers };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res: any = { status, json };
    const next = vi.fn();
    csrfOriginCheck(req, res, next);
    return { next, status };
  }
  it("exempts auth routes even when reached from a foreign referer (webmail reset link)", () => {
    const { next, status } = run("/auth/reset-password", { referer: "https://mail.google.com/mail/u/0/" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
  it("still exempts the unstripped form", () => {
    const { next } = run("/api/auth/reset-password", { origin: "https://evil.example" });
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("blocks a cross-origin mutation on a data route", () => {
    const { next, status } = run("/expenses", { origin: "https://evil.example" });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
  it("allows same-origin mutations", () => {
    const { next } = run("/expenses", { origin: "https://portol.me" });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("insights: due today is not overdue", () => {
  const empty = { profiles: [], trackers: [], expenses: [], habits: [], journal: [], documents: [], goals: [], events: [] };
  const today = getUserToday(TZ);
  it("reports a bill due today as due this week, never as overdue", () => {
    const obligations: any[] = [
      { id: "ob-today", name: "Rent", amount: 100, frequency: "monthly", status: "active", nextDueDate: today },
      { id: "ob-late", name: "Water", amount: 50, frequency: "monthly", status: "active", nextDueDate: addDays(today, -3) },
    ];
    const insights = generateSmartInsights({ ...empty, tasks: [], obligations } as any, TZ);
    const dueThisWeek = insights.find(i => i.type === "obligation_due");
    expect(dueThisWeek?.data?.obligations).toContain("ob-today");
    const overdue = insights.find(i => /overdue/i.test(i.title) && Array.isArray(i.data?.obligations));
    expect(overdue?.data?.obligations).toEqual(["ob-late"]);
  });
  it("does not list a task due today as overdue", () => {
    const tasks: any[] = [
      { id: "t-today", title: "Call the bank", status: "todo", dueDate: today },
      { id: "t-late", title: "File taxes", status: "todo", dueDate: addDays(today, -1) },
    ];
    const insights = generateSmartInsights({ ...empty, tasks, obligations: [] } as any, TZ);
    const overdue = insights.find(i => i.type === "reminder" && /overdue/i.test(i.title));
    expect(overdue?.data?.taskIds).toEqual(["t-late"]);
  });
});

// ── Round 2: shared calendar / finance math ──────────────────────────────────
import { expandRecurrenceDates, nextOccurrence } from "../shared/recurring-dates";
import { generateSchedule, periodsPerYear } from "../shared/liability-schedule";
import { buildAmortization, summarizeLiability } from "../shared/liability-calc";
import { computeNetWorth } from "../shared/net-worth";
import { computeAssetRollup } from "../shared/asset-rollup";
import { frequencyToRecurrence } from "../shared/calendar-adapters";
import { monthlyEquivalent } from "../shared/overview-compose";
import { nextAnnual } from "../shared/calendar-occurrences";
import { isAssetProfile } from "../shared/asset-value";

describe("recurrence expansion reaches windows far from the base date", () => {
  it("an old daily series still produces occurrences in a window years later", () => {
    expect(expandRecurrenceDates("2024-01-01", "daily", { windowStart: "2026-09-02", windowEnd: "2026-09-04" }))
      .toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(nextOccurrence({ date: "2020-01-01", recurrence: "daily" } as any, "2026-09-02")).toBe("2026-09-02");
  });
  it("weekly and weekday series keep their cadence when fast-forwarded", () => {
    expect(expandRecurrenceDates("2024-01-01", "weekly", { windowStart: "2026-09-02", windowEnd: "2026-09-20" }))
      .toEqual(["2026-09-07", "2026-09-14"]); // 2024-01-01 was a Monday
    expect(expandRecurrenceDates("2024-01-01", "weekdays", { windowStart: "2026-09-04", windowEnd: "2026-09-08" }))
      .toEqual(["2026-09-04", "2026-09-07", "2026-09-08"]); // Fri, Mon, Tue
  });
  it("a day-31 monthly series stays clamped to month end after fast-forward", () => {
    expect(expandRecurrenceDates("2020-01-31", "monthly", { windowStart: "2026-09-02", windowEnd: "2026-11-30" }))
      .toEqual(["2026-09-30", "2026-10-31", "2026-11-30"]);
  });
  it("a recent series is unchanged", () => {
    expect(expandRecurrenceDates("2026-09-01", "daily", { windowStart: "2026-09-01", windowEnd: "2026-09-03" }))
      .toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });
});

describe("liability schedule honours non-monthly cadences", () => {
  const opts = { todayISO: "2026-01-01", windowStart: "2026-01-01", windowEnd: "2026-12-31" } as any;
  it("quarterly bill yields four occurrences a year, not one", () => {
    const dates = generateSchedule({ id: "L1", fields: { frequency: "quarterly", dueDate: "2026-01-15", monthlyAmount: 300 } } as any, [], opts)
      .map((o: any) => o.date ?? o.dueDate);
    expect(dates).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });
  it("periodsPerYear knows quarterly, annual and one-off", () => {
    expect(periodsPerYear({ fields: { frequency: "quarterly" } } as any)).toBe(4);
    expect(periodsPerYear({ fields: { frequency: "annually" } } as any)).toBe(1);
    expect(periodsPerYear({ fields: { frequency: "once" } } as any)).toBe(1);
  });
});

describe("amortization", () => {
  it("clamps month-end due dates instead of overflowing", () => {
    const rows = buildAmortization({ currentBalance: 10000, annualInterestRate: 6, monthlyPayment: 500, firstPaymentDate: "2026-01-31" } as any).rows;
    expect(rows.slice(0, 4).map(r => r.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
  it("flags a payment that never covers interest instead of reporting a 1-month payoff", () => {
    const s = summarizeLiability({ currentBalance: 10000, annualRate: 24, monthlyPayment: 100 });
    expect(s.neverAmortizes).toBe(true);
    expect(s.remainingMonths).toBe(0);
  });
});

describe("balance keys are one-sided", () => {
  it("a loan profile's balance is debt, not an asset", () => {
    const nw = computeNetWorth([{ id: "a", name: "Car loan", type: "loan", fields: { balance: 20000 } }] as any, { mode: "everyone", selectedIds: [] } as any);
    expect([nw.assets, nw.liabilities, nw.netWorth]).toEqual([0, 20000, -20000]);
    // A loan may still carry the financed asset's own value.
    expect(isAssetProfile({ type: "loan", fields: { currentValue: 1000 } })).toBe(true);
  });
  it("a checking account's balance is its value, not a loan against it", () => {
    const r: any = computeAssetRollup({ id: "p", name: "Checking", type: "account", fields: { balance: 5000 } } as any, []);
    expect([r.baseValue, r.baseLoans, r.netValue]).toEqual([5000, 0, 5000]);
    const h: any = computeAssetRollup({ id: "h", name: "House", type: "property", fields: { currentValue: 500000, loan: { balance: 300000 } } } as any, []);
    expect([h.baseValue, h.baseLoans, h.netValue]).toEqual([500000, 300000, 200000]);
  });
});

describe("frequency vocabulary agrees across engines", () => {
  it("calendar adapter maps the multi-month and fortnightly spellings", () => {
    expect(["semiannual", "every-2-weeks", "fortnightly", "bimonthly", "once"].map(frequencyToRecurrence))
      .toEqual(["semiannual", "biweekly", "biweekly", "bimonthly", "none"]);
  });
  it("toMonthlyAmount handles the same spellings, and one-offs are not monthly", () => {
    expect(toMonthlyAmount(600, "semiannually")).toBe(100);
    expect(toMonthlyAmount(100, "bimonthly")).toBe(50);
    expect(toMonthlyAmount(100, "semimonthly")).toBe(200);
    expect(toMonthlyAmount(100, "once")).toBe(0);
  });
  it("monthlyEquivalent tells semi-monthly from semi-annual", () => {
    expect(monthlyEquivalent(1000, "semi-monthly")).toBe(2000);
    expect(monthlyEquivalent(600, "semiannual")).toBe(100);
  });
  it("nextAnnual handles a base date years in the future", () => {
    expect(nextAnnual("2030-05-01", "2026-09-02")).toBe("2030-05-01");
  });
});

// ── Round 3: found by driving the deployed app ──────────────────────────────
import { eventOccursOn } from "../shared/recurring-dates";
import { isActiveObligation } from "../shared/obligation-windows";
import { sanitizeTrackerEntryValues } from "../server/tracker-entry-guard";

describe("eventOccursOn", () => {
  it("a one-off matches only its own date", () => {
    expect(eventOccursOn({ date: "2026-09-01", recurrence: "none" }, "2026-09-01")).toBe(true);
    expect(eventOccursOn({ date: "2026-09-01", recurrence: "none" }, "2026-09-02")).toBe(false);
  });
  it("a daily series created long ago occurs today (the dashboard's Today list showed it only on its creation day)", () => {
    expect(eventOccursOn({ date: "2024-01-08", recurrence: "daily" }, "2026-09-01")).toBe(true);
    expect(eventOccursOn({ date: "2024-01-08", recurrence: "weekly" }, "2026-09-07")).toBe(true);  // both Mondays
    expect(eventOccursOn({ date: "2024-01-08", recurrence: "weekly" }, "2026-09-08")).toBe(false);
    expect(eventOccursOn({ date: "2020-01-31", recurrence: "monthly" }, "2026-09-30")).toBe(true);
  });
  it("honours skips, pauses and the recurrence end", () => {
    expect(eventOccursOn({ date: "2024-01-08", recurrence: "daily", tags: ["rd:skip:2026-09-01"] } as any, "2026-09-01")).toBe(false);
    expect(eventOccursOn({ date: "2024-01-08", recurrence: "daily", tags: ["rd:paused"] } as any, "2026-09-01")).toBe(false);
    expect(eventOccursOn({ date: "2024-01-08", recurrence: "daily", recurrenceEnd: "2026-08-31" }, "2026-09-01")).toBe(false);
  });
});

describe("isActiveObligation", () => {
  it("excludes paused and cancelled, includes everything else", () => {
    expect(isActiveObligation({ status: "paused" })).toBe(false);
    expect(isActiveObligation({ status: "cancelled" })).toBe(false);
    expect(isActiveObligation({ status: "active" })).toBe(true);
    expect(isActiveObligation({})).toBe(true);
  });
});

describe("tracker entry guard: numeric-by-name keys", () => {
  it("rejects a non-numeric value under a well-known numeric key even when the tracker does not declare it", () => {
    const r = sanitizeTrackerEntryValues([{ name: "value", type: "number" }], { weight: "abc" });
    expect(r.error).toMatch(/weight/);
  });
  it("still coerces a numeric string with a unit suffix", () => {
    const r = sanitizeTrackerEntryValues([{ name: "value", type: "number" }], { weight: "176 lbs" });
    expect(r.error).toBeUndefined();
    expect(r.values.weight).toBe(176);
  });
  it("leaves free-text keys alone", () => {
    const r = sanitizeTrackerEntryValues([{ name: "mood", type: "text" }], { mood: "great" });
    expect(r.error).toBeUndefined();
    expect(r.values.mood).toBe("great");
  });
});

describe("liability schedule: re-anchored series keeps history and the new grid", () => {
  const opts = { todayISO: "2026-09-01", windowStart: "2026-08-01", windowEnd: "2026-12-31" } as any;
  it("an off-grid paid override before the anchor is history, and the series walks from the anchor", () => {
    // Bill was due on the 4th, 08-04 was paid, then the user edited the due date to the 13th.
    const dates = generateSchedule({ id: "L1", fields: {
      frequency: "monthly", firstPaymentDate: "2026-09-13", dueDate: "2026-09-13", monthlyAmount: 30,
      occurrences: { "2026-08-04": { status: "paid" } },
    } } as any, [], opts).map((o: any) => [o.date, o.status]);
    expect(dates.map(d => d[0])).toEqual(["2026-08-04", "2026-09-13", "2026-10-13", "2026-11-13", "2026-12-13"]);
    expect(dates[0][1]).toBe("paid");
  });
  it("an on-grid paid override still reads as before", () => {
    const dates = generateSchedule({ id: "L2", fields: {
      frequency: "monthly", firstPaymentDate: "2026-09-04", dueDate: "2026-09-04", monthlyAmount: 30,
      occurrences: { "2026-08-04": { status: "paid" } },
    } } as any, [], opts).map((o: any) => o.date);
    expect(dates).toEqual(["2026-08-04", "2026-09-04", "2026-10-04", "2026-11-04", "2026-12-04"]);
  });
});

import { normalizeTrackerEntry } from "../server/tracker-normalize";
describe("tracker normalize: sibling unit keys", () => {
  const lbs = { name: "Weight", category: "health", unit: "lbs", fields: [{ name: "value", type: "number", isPrimary: true }] } as any;
  it("converts { value: 80, unit: 'kg' } into the tracker's pounds and drops the unit key", () => {
    const r = normalizeTrackerEntry(lbs, { value: 80, unit: "kg" });
    expect(r.values.value).toBeCloseTo(176.37, 1);
    expect("unit" in r.values).toBe(false);
  });
  it("handles a per-key unit and leaves other keys alone", () => {
    const r = normalizeTrackerEntry({ ...lbs, fields: [{ name: "weight", type: "number", unit: "lbs" }, { name: "notes", type: "text" }] }, { weight: 80, weightUnit: "kg", notes: "morning" });
    expect(r.values.weight).toBeCloseTo(176.37, 1);
    expect(r.values.notes).toBe("morning");
    expect("weightUnit" in r.values).toBe(false);
  });
  it("same unit as the tracker: value unchanged, redundant key dropped", () => {
    const r = normalizeTrackerEntry(lbs, { value: 180, unit: "lbs" });
    expect(r.values.value).toBe(180);
    expect("unit" in r.values).toBe(false);
  });
  it("does not apply a bare unit sibling when the entry carries several numbers", () => {
    const run = { name: "Running", category: "fitness", unit: "mi", fields: [{ name: "distance", type: "number", unit: "mi" }, { name: "duration", type: "number", unit: "min" }] } as any;
    const r = normalizeTrackerEntry(run, { distance: 5, duration: 30, unit: "km" });
    expect(r.values.distance).toBe(5); // ambiguous — left alone rather than guessed
  });
});
