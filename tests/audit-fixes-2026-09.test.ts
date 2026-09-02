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

import { parseBankCsv, parseCsvRow, normalizeCsvDate, expenseDedupeKey } from "../server/bank-csv";
describe("bank CSV import parsing", () => {
  const T = "2026-09-01";
  it("negative amounts are debits (expenses); positives are credits and skipped", () => {
    const r: any = parseBankCsv(['Date,Description,Amount', '09/01/2026,"AMAZON, INC",-42.50', '08/31/2026,PAYROLL DEPOSIT,2500.00', '2026-08-30,SHELL,(60.00)'].join("\n"), T);
    expect(r.signConvention).toBe("negative-debits");
    expect(r.rows.map((x: any) => [x.date, x.description, x.amount])).toEqual([["2026-09-01", "AMAZON, INC", 42.5], ["2026-08-30", "SHELL", 60]]);
    expect(r.skippedCredits).toBe(1);
  });
  it("a file with only positive amounts treats them as spending", () => {
    const r: any = parseBankCsv("Date,Memo,Amount\n2026-09-01,Coffee,5.25", T);
    expect(r.signConvention).toBe("positive-debits");
    expect(r.rows[0].amount).toBe(5.25);
  });
  it("separate Debit / Credit columns", () => {
    const r: any = parseBankCsv("Date,Description,Debit,Credit\n2026-09-01,Coffee,5.25,\n2026-09-01,Refund,,12.00", T);
    expect(r.signConvention).toBe("debit-column");
    expect(r.rows.map((x: any) => x.amount)).toEqual([5.25]);
    expect(r.skippedCredits).toBe(1);
  });
  it("quoted fields keep commas and escaped quotes", () => {
    expect(parseCsvRow('a,"b, c","say ""hi""",d')).toEqual(["a", "b, c", 'say "hi"', "d"]);
  });
  it("dates: ISO passes through untouched, US M/D/YYYY normalizes, garbage falls back to today", () => {
    expect(normalizeCsvDate("2026-08-30", T)).toBe("2026-08-30");
    expect(normalizeCsvDate("9/1/2026", T)).toBe("2026-09-01");
    expect(normalizeCsvDate("not a date", T)).toBe(T);
  });
  it("dedupe key is day + cents + case-insensitive text", () => {
    expect(expenseDedupeKey({ date: "2026-09-01", amount: 42.5, description: "Amazon, Inc" })).toBe(expenseDedupeKey({ date: "2026-09-01T00:00:00Z", amount: 42.5, description: "AMAZON, INC " }));
  });
});

import { payBillOccurrence } from "../server/liability-payments";
describe("payBillOccurrence: concurrent payers settle one occurrence once", () => {
  function makeStorage(opts: { claimResult: "claimed" | "already-paid" }) {
    const bill: any = { id: "L1", name: "Water", type: "liability", type_key: "utility", parentProfileId: "self", fields: { frequency: "monthly", dueDate: "2026-09-01", nextDueDate: "2026-09-01", monthlyAmount: 40, category: "utilities" } };
    const payments: any[] = [{ id: "winner-1", liabilityProfileId: "L1", paymentDate: "2026-09-01", amount: 40 }];
    const expenses: any[] = [];
    const claims: any[] = [];
    const storage: any = {
      getProfile: async (id: string) => (id === "L1" ? bill : null),
      getProfiles: async () => [bill],
      updateProfile: async (_id: string, patch: any) => { bill.fields = { ...bill.fields, ...(patch.fields || {}) }; return bill; },
      createLiabilityPayment: async (d: any) => { const row = { id: d.id || "new-id", ...d }; payments.push(row); return row; },
      getLiabilityPayments: async () => payments,
      createExpense: async (e: any) => { const row = { id: `e${expenses.length + 1}`, ...e }; expenses.push(row); return row; },
      claimBillOccurrence: async (id: string, date: string, stamp: any, extra: any) => {
        claims.push({ id, date, stamp, extra });
        if (opts.claimResult === "already-paid") return { status: "already-paid", occurrences: { [date]: { status: "paid", paymentId: "winner-1" } } };
        bill.fields = { ...bill.fields, ...extra, occurrences: { [date]: stamp } };
        return { status: "claimed", occurrences: {} };
      },
    };
    return { storage, payments, expenses, claims, bill };
  }
  it("winner: claims first, ledger row carries the stamped id, one expense, due date advanced", async () => {
    const s = makeStorage({ claimResult: "claimed" });
    const r = await payBillOccurrence(s.storage, "L1", { source: "route" }, "America/Los_Angeles");
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeFalsy();
    expect(s.claims.length).toBe(1);
    expect(r.payment.id).toBe(s.claims[0].stamp.paymentId);
    expect(s.expenses.length).toBe(1);
    expect(r.dueDateAdvanced).toBe(true);
    expect(s.bill.fields.dueDate).toBe("2026-10-01");
  });
  it("loser: no ledger row, no expense, answers with the winner's payment", async () => {
    const s = makeStorage({ claimResult: "already-paid" });
    const before = s.payments.length;
    const r = await payBillOccurrence(s.storage, "L1", { source: "route" }, "America/Los_Angeles");
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.payment?.id).toBe("winner-1");
    expect(s.payments.length).toBe(before);
    expect(s.expenses.length).toBe(0);
  });
});

import { componentAmountIds } from "../shared/extraction-actions";
describe("componentAmountIds: undated line items join the dated total", () => {
  const fact = (id: string, value: string, date?: string): any => ({ id, label: id, value, roles: ["financial"], financialKind: "charge", date, subject: { entityRef: "e1", confidence: 0.9 } });
  it("a receipt whose only dated fact is the total still marks the line items as components", () => {
    const r = componentAmountIds([fact("f1", "8.99"), fact("f2", "5.49"), fact("f3", "14.48", "2026-08-29")]);
    expect(r.total).toBe(14.48);
    expect([...r.componentFactIds].sort()).toEqual(["f1", "f2"]);
  });
  it("two dated purchases stay separate totals", () => {
    const r = componentAmountIds([fact("a1", "10", "2026-08-01"), fact("a2", "5", "2026-08-01"), fact("a3", "15", "2026-08-01"), fact("b1", "20", "2026-08-02"), fact("b2", "7", "2026-08-02"), fact("b3", "27", "2026-08-02")]);
    expect([...r.componentFactIds].sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });
});

import { detectTrackable, notTrackableReason } from "../shared/trackable-values";
describe("trackable detection: card last-4 is an identifier, not a measurement", () => {
  it("last4 = 1111 on a receipt is never a tracker candidate", () => {
    expect(notTrackableReason({ key: "last4", label: "Last4", value: "1111", roles: ["financial"] } as any)).toBe("identifier");
    expect(detectTrackable({ key: "last4", label: "Last4", value: 1111, roles: ["financial"] } as any)).toBeNull();
    expect(notTrackableReason({ key: "cardEndingIn", label: "Card ending in", value: "4242" } as any)).toBe("identifier");
  });
  it("a real measurement still qualifies", () => {
    expect(notTrackableReason({ key: "weight", label: "Weight", value: "180 lbs" } as any)).toBeNull();
  });
});

describe("payBillOccurrence: an implicit pay seconds after a posted payment is the same tap", () => {
  it("folds into the just-posted payment instead of paying the next occurrence", async () => {
    const bill: any = { id: "L1", name: "Water", type: "liability", type_key: "utility", fields: { frequency: "monthly", dueDate: "2026-10-01", nextDueDate: "2026-10-01", monthlyAmount: 40, occurrences: { "2026-09-01": { status: "paid", paymentId: "p-sep", amount: 40, postedAt: new Date(Date.now() - 1500).toISOString() } } } };
    const payments: any[] = [{ id: "p-sep", liabilityProfileId: "L1", paymentDate: "2026-09-01", amount: 40 }];
    const storage: any = { getProfile: async () => bill, getProfiles: async () => [bill], updateProfile: async () => bill, createLiabilityPayment: async (d: any) => { payments.push(d); return d; }, getLiabilityPayments: async () => payments, createExpense: async (e: any) => e, claimBillOccurrence: async () => { throw new Error("must not be reached"); } };
    const r = await payBillOccurrence(storage, "L1", { source: "route" }, "America/Los_Angeles");
    expect(r.deduped).toBe(true);
    expect(r.payment?.id).toBe("p-sep");
    expect(payments.length).toBe(1);
  });
  it("an explicit occurrence is an explicit intent and still pays", async () => {
    const bill: any = { id: "L1", name: "Water", type: "liability", type_key: "utility", fields: { frequency: "monthly", dueDate: "2026-10-01", nextDueDate: "2026-10-01", monthlyAmount: 40, occurrences: { "2026-09-01": { status: "paid", paymentId: "p-sep", amount: 40, postedAt: new Date(Date.now() - 1500).toISOString() } } } };
    const payments: any[] = [];
    const storage: any = { getProfile: async () => bill, getProfiles: async () => [bill], updateProfile: async () => bill, createLiabilityPayment: async (d: any) => { payments.push(d); return d; }, getLiabilityPayments: async () => payments, createExpense: async (e: any) => e };
    const r = await payBillOccurrence(storage, "L1", { source: "route", occurrenceDate: "2026-10-01" }, "America/Los_Angeles");
    expect(r.deduped).toBeFalsy();
    expect(payments.length).toBe(1);
  });
});

import { recordActionLog, buildTurnVerifyContext } from "../server/ai-envelope";
describe("AI undo: a bill payment's reverse plan is the real inverse", () => {
  it("pay_obligation records an unpay_bill plan carrying the payment id", async () => {
    const rows: any[] = [];
    const storage: any = { createAiActionLog: async (row: any) => { rows.push(row); return { id: "log-1", ...row }; }, getProfiles: async () => [] };
    const ctx = buildTurnVerifyContext(storage);
    await recordActionLog(ctx, "pay_obligation", "update_entity", { name: "Water" }, { entity: { id: "L1", type: "obligation", name: "Water" }, paid: { amount: 40, occurrence: "2026-09-01", paymentId: "pay-1" } }, [{ id: "L1", nextDueDate: "2026-09-01" }]);
    expect(rows.length).toBe(1);
    expect(rows[0].reversible).toBe(true);
    expect(rows[0].reversePlan).toEqual({ op: "unpay_bill", liabilityId: "L1", paymentId: "pay-1" });
  });
});

// ── D30 (root cause): a loan with no due date must not be scheduled "today" ──
// deriveScheduleFields fell back to `todayISO` when a loan had neither a due
// date nor a due day, so the calendar timeline, the liability schedule and the
// assistant all presented the loan as due today — every day, re-anchored on
// the clock. The only defensible anchors are an explicit date, a due day, or
// the last recorded payment plus one cycle. Otherwise: no schedule at all.
describe("deriveScheduleFields: no due date is no due date", () => {
  const TODAY = "2026-09-02";
  it("a loan with only a balance and monthly payment gets no occurrences and no next due", async () => {
    const { deriveScheduleFields, generateSchedule, nextDueOccurrence } = await import("../shared/liability-schedule");
    const f = deriveScheduleFields({ currentBalance: 350000, interestRate: 6.5, monthlyPayment: 2200 }, "mortgage", TODAY);
    expect(f.dueDate).toBeUndefined();
    expect(f.nextDueDate).toBeUndefined();
    expect(f.firstPaymentDate).toBeUndefined();
    expect(f.amount).toBe(2200);
    expect(generateSchedule({ id: "l", fields: f }, [], { todayISO: TODAY, months: 12 })).toEqual([]);
    expect(nextDueOccurrence({ id: "l", fields: f }, [], TODAY)).toBeNull();
  });
  it("a due day still anchors the series, and an explicit date wins over it", async () => {
    const { deriveScheduleFields } = await import("../shared/liability-schedule");
    const byDay = deriveScheduleFields({ monthlyPayment: 500, dueDay: 10 }, "auto_loan", TODAY);
    expect(byDay.dueDate).toBe("2026-09-10");
    const explicit = deriveScheduleFields({ monthlyPayment: 500, dueDay: 10, nextPaymentDate: "2026-09-20" }, "auto_loan", TODAY);
    expect(explicit.dueDate).toBe("2026-09-20");
  });
  it("with no date but a recorded last payment, the next due is one cycle after it", async () => {
    const { deriveScheduleFields } = await import("../shared/liability-schedule");
    const f = deriveScheduleFields({ monthlyPayment: 500, lastPaidDate: "2026-08-15" }, "auto_loan", TODAY);
    expect(f.dueDate).toBe("2026-09-15");
    expect(f.firstPaymentDate).toBe("2026-09-15");
  });
});

// ── D36: the capture classifier's question must not contradict the reply ──
describe("shouldAppendClarifyingQuestion", () => {
  const base = { question: "What item should be moved to today?", confidence: 0.4, projectionsCount: 0, actionsCount: 0 };
  it("appends only when the turn went nowhere and the assistant asked nothing", async () => {
    const { shouldAppendClarifyingQuestion } = await import("../shared/chat-clarify");
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "I couldn't tell what you meant." })).toBe(true);
    // the assistant executed something: its summary stands alone
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "Updated Lunch at Panera to $45, dated today.", actionsCount: 1 })).toBe(false);
    // the assistant already asked (a confirmation prompt)
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "Are you sure you'd like to delete the Lunch at Panera expense ($45)?" })).toBe(false);
    // routed, confident, or no question at all
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "Hmm.", projectionsCount: 1 })).toBe(false);
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "Hmm.", confidence: 0.9 })).toBe(false);
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "Hmm.", question: "" })).toBe(false);
    // the same question already in the reply
    expect(shouldAppendClarifyingQuestion({ ...base, reply: "What item should be moved to today? I found nothing." })).toBe(false);
  });
});

// ── D37: global search never returned events or documents ──
describe("search covers events and documents", () => {
  it("finds an event by title/location and a document by name, tagged with _type", async () => {
    const { MemStorage } = await import("../server/storage");
    const s = new MemStorage();
    const ev = await s.createEvent({ title: "Dentist appointment", date: "2026-09-20", category: "health", location: "Bright Smiles" } as any);
    const doc = await s.createDocument({ name: "Passport scan", type: "passport", category: "identity" } as any);
    await s.createTask({ title: "Book dentist", priority: "low", status: "todo" } as any);
    const hits = await s.search("dentist");
    expect(hits.some((h: any) => h._type === "event" && h.id === ev.id)).toBe(true);
    expect(hits.some((h: any) => h._type === "task")).toBe(true);
    expect((await s.search("bright smiles")).some((h: any) => h._type === "event" && h.id === ev.id)).toBe(true);
    expect((await s.search("passport")).some((h: any) => h._type === "document" && h.id === doc.id)).toBe(true);
  });
});

// ── D38: a correction of the previous turn is not a stale replay ──
describe("stale-replay gate vs corrections", () => {
  it("a correction that names nothing new is a back-reference, not replay", async () => {
    const { isStaleTurnReplay, toolOperation } = await import("../shared/ai-tool-routing");
    const { hasBackReference } = await import("../shared/ai-intent");
    const prior = ["I spent $38 on lunch at Panera yesterday"];
    for (const msg of [
      "oops, it was actually $45 not $38",
      "actually it was $45",
      "I meant $45",
      "make it $45",
      "that should be 182",
      "whoops, my bad — it cost 45 dollars",
    ]) {
      expect(hasBackReference(msg), msg).toBe(true);
      expect(isStaleTurnReplay({ description: "Lunch at Panera" }, msg, prior), msg).toBe(false);
    }
    // The engine also exempts update-class tools from the gate entirely.
    expect(toolOperation("update_expense")).toBe("update");
    expect(toolOperation("create_expense")).toBe("create");
    // …and a genuine replay is still caught.
    expect(isStaleTurnReplay({ name: "Walk the Dog" }, "Create an asset for my Dodge Ram 2025", ["Create a habit to walk the dog"])).toBe(true);
  });
});

// ── D40: the assistant's "upcoming events" are next occurrences, not base dates ──
describe("upcomingEventOccurrences", () => {
  it("lists a past-anchored daily series by its next date, drops past one-time events, sorts by date", async () => {
    const { upcomingEventOccurrences } = await import("../shared/event-upcoming");
    const today = "2026-09-02";
    const rows = [
      { id: "a", title: "Standup", date: "2026-08-23", recurrence: "daily", time: "09:00", tags: [] },
      { id: "b", title: "Old party", date: "2026-08-30", recurrence: "none" },
      { id: "c", title: "Dentist", date: "2026-09-04", recurrence: "none", time: "14:00" },
      { id: "d", title: "Yoga", date: "2026-08-05", recurrence: "weekly", tags: [`rd:skip:2026-09-02`] },
    ];
    const out = upcomingEventOccurrences(rows as any, today);
    expect(out.map((o) => `${o.title}@${o.date}`)).toEqual(["Standup@2026-09-02", "Dentist@2026-09-04", "Yoga@2026-09-09"]);
    expect(out[0].recurrence).toBe("Every day");
    expect(out[1].recurrence).toBeNull();
  });
});

// ── D42: a paraphrased title must still find the record ──
describe("rankByName paraphrase matching (safeMatchEntity step 4)", () => {
  it("'call the plumber' finds 'Call plumber TKab12' and nothing else", async () => {
    const { rankByName } = await import("../shared/entity-resolution");
    const items = [{ id: "1", title: "Call plumber TKab12" }, { id: "2", title: "Buy groceries" }, { id: "3", title: "Plumb the new sink" }];
    const r = rankByName(items, "call the plumber", (t) => t.title);
    expect(r.map((t) => t.id)).toEqual(["1"]);
    expect(rankByName(items, "panera lunch", (t) => t.title)).toEqual([]);
  });
});

// ── D45: a report about the profile the habit list is scoped to is that profile's completion ──
describe("matchHabitForCompletionReport with a named subject", () => {
  it("'Smoke Child flossed today' checks the child's habit when scoped to the child; other third parties still veto", async () => {
    const { matchHabitForCompletionReport, stripNamedSubject } = await import("../shared/habit-completion-intent");
    const habits = [{ id: "h1", name: "Floss" }];
    expect(stripNamedSubject("Smoke Child flossed today", ["Smoke Child"])).toBe("flossed today");
    expect(stripNamedSubject("Smoke Child's floss done", ["Smoke Child"])).toBe("floss done");
    expect(matchHabitForCompletionReport(habits, "Smoke Child flossed today", undefined, { subjectNames: ["Smoke Child"] })?.habit.id).toBe("h1");
    // unscoped: a third person's action never touches the user's habit
    expect(matchHabitForCompletionReport(habits, "Smoke Child flossed today")).toBeNull();
    // scoped to the child, but the sentence is about someone else
    expect(matchHabitForCompletionReport(habits, "John flossed today", undefined, { subjectNames: ["Smoke Child"] })).toBeNull();
  });
});

// ── D48: bulk-delete date bounds apply to the record's own date ──
describe("deriveBulkSet date bounds", () => {
  it("on_date keeps only that day's expenses; before_date reads the expense date, not createdAt", async () => {
    const { deriveBulkSet, entityDate } = await import("../server/bulk-actions");
    const rows = [
      { id: "a", description: "Snack A", date: "2026-09-02", createdAt: "2026-09-02T10:00:00Z" },
      { id: "b", description: "Snack B", date: "2026-09-02", createdAt: "2026-09-02T11:00:00Z" },
      { id: "c", description: "Snack C", date: "2026-09-01", createdAt: "2026-09-02T12:00:00Z" }, // typed today, about yesterday
    ];
    const storage: any = { getExpenses: async () => rows, getProfiles: async () => [] };
    const on = await deriveBulkSet(storage, { operation: "delete", entity_types: ["expense"], on_date: "2026-09-02" } as any);
    expect(on.idsByType.expense.sort()).toEqual(["a", "b"]);
    const before = await deriveBulkSet(storage, { operation: "delete", entity_types: ["expense"], before_date: "2026-09-02" } as any);
    expect(before.idsByType.expense).toEqual(["c"]);
    const after = await deriveBulkSet(storage, { operation: "delete", entity_types: ["expense"], after_date: "2026-09-02" } as any);
    expect(after.idsByType.expense.sort()).toEqual(["a", "b"]);
    expect(entityDate("task", { dueDate: "2026-09-05", createdAt: "2026-09-01T00:00:00Z" })).toBe("2026-09-05");
    expect(entityDate("task", { createdAt: "2026-09-01T00:00:00Z" })).toBe("2026-09-01");
  });
});
