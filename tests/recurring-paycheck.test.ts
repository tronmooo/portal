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
