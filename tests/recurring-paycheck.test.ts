// tests/recurring-paycheck.test.ts
//
// "My paycheck is about $2000 a month for the next year" must be ONE chat
// turn, not a conversation. (User screenshot 2026-08-09: the model replied
// "I can only log one at a time — want me to log all 12 occurrences?"
// because log_expected_paycheck had no recurrence and log_income hardcoded
// frequency:"once".)
//
// Pins:
//   • log_expected_paycheck(frequency, count/until) writes the whole series,
//     day-of-month clamped, capped at 52 rows;
//   • log_income(frequency:'monthly') creates a RECURRING income source (the
//     Income tile reads incomes — a paycheck row alone leaves it at $0);
//   • single-paycheck and single-income behavior is unchanged.
import { describe, it, expect } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";

const USER = "recurring-paycheck-user";

const run = <T,>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

describe("log_expected_paycheck — recurring series", () => {
  it("writes 12 monthly occurrences in one call", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Acme Corp", amount: 2000, expected_date: "2026-08-25", frequency: "monthly", count: 12,
    }, USER));
    expect(res.error).toBeUndefined();
    expect(res.series).toMatchObject({ count: 12, frequency: "monthly", first: "2026-08-25", last: "2027-07-25" });
    const rows = await run(storage, () => storage.getPaychecks());
    expect(rows).toHaveLength(12);
    expect(rows.map((r: any) => r.expected_date.slice(0, 7))).toEqual([
      "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01",
      "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07",
    ]);
    // Every occurrence keeps the anchor day.
    expect(new Set(rows.map((r: any) => r.expected_date.slice(8)))).toEqual(new Set(["25"]));
  });

  it("clamps a month-end anchor instead of drifting into the next month", async () => {
    const storage = new MemStorage();
    await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Acme", amount: 1500, expected_date: "2026-08-31", frequency: "monthly", count: 4,
    }, USER));
    const dates = (await run(storage, () => storage.getPaychecks())).map((r: any) => r.expected_date).sort();
    // Aug 31 → Sep 30 (clamp) → Oct 31 (anchor day restored) → Nov 30 (clamp)
    expect(dates).toEqual(["2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30"]);
  });

  it("honors `until` as the series end", async () => {
    const storage = new MemStorage();
    await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Side gig", amount: 500, expected_date: "2026-08-14", frequency: "biweekly", until: "2026-10-01",
    }, USER));
    const dates = (await run(storage, () => storage.getPaychecks())).map((r: any) => r.expected_date).sort();
    expect(dates).toEqual(["2026-08-14", "2026-08-28", "2026-09-11", "2026-09-25"]);
  });

  it("caps a runaway series at 52 occurrences", async () => {
    const storage = new MemStorage();
    await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Acme", amount: 100, expected_date: "2026-08-01", frequency: "weekly", count: 500,
    }, USER));
    expect(await run(storage, () => storage.getPaychecks())).toHaveLength(52);
  });

  it("without frequency, still writes exactly one row (unchanged behavior)", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Acme", amount: 2000, expected_date: "2026-08-25",
    }, USER));
    expect(res.error).toBeUndefined();
    expect(res.series).toBeUndefined();
    expect(await run(storage, () => storage.getPaychecks())).toHaveLength(1);
  });

  it("rejects an unparseable date instead of writing junk", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Acme", amount: 2000, expected_date: "whenever",
    }, USER));
    expect(res.error).toMatch(/date/i);
    expect(await run(storage, () => storage.getPaychecks())).toHaveLength(0);
  });
});

describe("update_paycheck — recurring series is editable, not append-only", () => {
  async function seedSeries(storage: MemStorage) {
    await run(storage, () => executeTool("log_expected_paycheck", {
      source: "Acme Corp", amount: 2000, expected_date: "2026-09-25", frequency: "monthly", count: 3,
    }, USER));
  }

  it("edits one occurrence's amount", async () => {
    const storage = new MemStorage();
    await seedSeries(storage);
    const res = await run(storage, () => executeTool("update_paycheck", {
      source: "Acme", expected_date: "2026-10-25", changes: { amount: 2200 },
    }, USER));
    expect(res.error).toBeUndefined();
    expect(res.count).toBe(1);
    const rows = await run(storage, () => storage.getPaychecks());
    expect(rows.find((r: any) => r.expected_date === "2026-10-25")!.amount).toBe(2200);
    expect(rows.find((r: any) => r.expected_date === "2026-09-25")!.amount).toBe(2000);
  });

  it("all_future applies a raise from a date forward", async () => {
    const storage = new MemStorage();
    await seedSeries(storage);
    const res = await run(storage, () => executeTool("update_paycheck", {
      source: "Acme", expected_date: "2026-10-25", all_future: true, changes: { amount: 2200 },
    }, USER));
    expect(res.count).toBe(2);
    const amounts = Object.fromEntries((await run(storage, () => storage.getPaychecks()))
      .map((r: any) => [r.expected_date, r.amount]));
    expect(amounts).toEqual({ "2026-09-25": 2000, "2026-10-25": 2200, "2026-11-25": 2200 });
  });

  it("all_future date change shifts the whole series by the same delta", async () => {
    const storage = new MemStorage();
    await seedSeries(storage);
    // Move the Sep 25 check (and everything after) to the 1st-of-next-month
    // pattern: Sep 25 → Oct 1 is +6 days.
    const res = await run(storage, () => executeTool("update_paycheck", {
      source: "Acme", expected_date: "2026-09-25", all_future: true, changes: { expected_date: "2026-10-01" },
    }, USER));
    expect(res.count).toBe(3);
    const dates = (await run(storage, () => storage.getPaychecks())).map((r: any) => r.expected_date).sort();
    expect(dates).toEqual(["2026-10-01", "2026-10-31", "2026-12-01"]);
  });

  it("errors honestly on an unknown source", async () => {
    const storage = new MemStorage();
    await seedSeries(storage);
    const res = await run(storage, () => executeTool("update_paycheck", {
      source: "Globex", changes: { amount: 1 },
    }, USER));
    expect(res.error).toMatch(/no paycheck/i);
  });
});

describe("get_financial_overview — the Finance-tab picture in one call", () => {
  it("computes income, expenses, cash flow, upcoming, investments, net worth", async () => {
    const storage = new MemStorage();
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).slice(0, 7);
    const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 10); return d.toLocaleDateString("en-CA"); })();
    const overview = await run(storage, async () => {
      await executeTool("log_income", { amount: 2000, source: "Acme salary", frequency: "monthly" }, USER);
      await executeTool("log_income", { amount: 300, source: "Garage sale" }, USER);
      await executeTool("create_expense", { amount: 500, description: "Rent share", category: "housing" }, USER);
      await executeTool("log_expected_paycheck", { source: "Acme Corp", amount: 2000, expected_date: soon }, USER);
      await executeTool("create_obligation", { name: "Netflix", amount: 20, frequency: "monthly", nextDueDate: soon }, USER);
      await executeTool("create_profile", { type: "investment", name: "Brokerage", fields: { currentValue: 12000, totalInvested: 10000 } }, USER);
      await executeTool("create_liability", { name: "Car Loan", subtype: "auto_loan", currentBalance: 8000 }, USER);
      return executeTool("get_financial_overview", {}, USER);
    });

    expect(overview.error).toBeUndefined();
    expect(overview.month).toBe(month);
    expect(overview.income.monthly_recurring).toBe(2000);
    expect(overview.income.one_time_this_month).toBe(300);
    expect(overview.income.total_this_month).toBe(2300);
    expect(overview.expenses.total_this_month).toBe(500);
    expect(overview.net_monthly_cash_flow).toBe(1800);
    expect(overview.upcoming_income.next_30_days).toEqual([{ source: "Acme Corp", amount: 2000, date: soon }]);
    expect(overview.upcoming_bills.next_30_days.map((b: any) => b.name)).toContain("Netflix");
    expect(overview.investments).toMatchObject({ total_invested: 10000, current_value: 12000, count: 1 });
    expect(overview.net_worth.assets).toBeGreaterThanOrEqual(12000);
    expect(overview.net_worth.liabilities).toBe(8000);
    expect(overview.net_worth.net).toBe(overview.net_worth.assets - 8000);
  });
});

describe("paychecks appear on the calendar timeline", () => {
  it("query_calendar returns the series as paycheck items", async () => {
    const storage = new MemStorage();
    const items = await run(storage, async () => {
      await executeTool("log_expected_paycheck", {
        source: "Acme Corp", amount: 2000, expected_date: "2026-09-25", frequency: "monthly", count: 3,
      }, USER);
      const res = await executeTool("query_calendar", { startDate: "2026-09-01", endDate: "2026-12-31" }, USER);
      return (res.items || []).filter((i: any) => i.type === "paycheck");
    });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: "paycheck", title: "Acme Corp paycheck — $2000", allDay: true });
    expect(items.map((i: any) => i.date)).toEqual(["2026-09-25", "2026-10-25", "2026-11-25"]);
  });
});

describe("log_income — recurring income source", () => {
  it("stores the requested frequency ('my paycheck is $2000 a month')", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("log_income", {
      amount: 2000, source: "Acme salary", frequency: "monthly",
    }, USER));
    expect(res.error).toBeUndefined();
    expect(res.income.frequency).toBe("monthly");
    expect(res.message).toMatch(/monthly recurring/);
    const incomes = await run(storage, () => storage.getIncomes());
    expect(incomes).toHaveLength(1);
    expect(incomes[0].frequency).toBe("monthly");
  });

  it("defaults to a one-time entry when no frequency is given", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("log_income", { amount: 300, source: "Refund" }, USER));
    expect(res.income.frequency).toBe("once");
  });

  it("ignores an off-vocabulary frequency instead of failing the save", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("log_income", {
      amount: 300, source: "Tutoring", frequency: "fortnightly-ish",
    }, USER));
    expect(res.error).toBeUndefined();
    expect(res.income.frequency).toBe("once");
  });
});
