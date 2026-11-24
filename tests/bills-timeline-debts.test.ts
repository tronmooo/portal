// Bills & Payments lists a loan's or card's payments, on the days the Calendar
// draws them (QA 2026-11-24, second pass: "Nothing due in the next 30 days"
// on the Money card and in Bills & Payments, while the Calendar listed the
// demo auto loan's payment on December 20 — 26 days away).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { debtPaymentRows, isCalendarDebtProfile, mergeBillsTimelines } from "../shared/debt-payments-timeline";
import { buildBillsTimeline } from "../shared/bills-timeline";
import { deriveScheduleFields, generateSchedule } from "../shared/liability-schedule";
import { MemStorage, requestStorageContext } from "../server/storage";

const TODAY = "2026-11-24";
const LOAN = {
  id: "loan-1", name: "Demo Auto Loan", type: "liability", type_key: "auto_loan",
  fields: { balance: 18400, interestRate: 6.9, _interestRateUnit: "percent", monthlyPayment: 412.5, dueDay: 20 },
};
const rows = (debts: any[], payments = new Map<string, any[]>(), profiles: any[] = debts) =>
  debtPaymentRows(debts, profiles, payments, TODAY);

describe("a debt's next payment is in Bills & Payments", () => {
  it("names the payment the Calendar draws, 26 days out", () => {
    const { upcoming, past } = rows([LOAN]);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({ billId: "loan-1", name: "Demo Auto Loan", date: "2026-12-20", daysUntil: 26, amount: 412.5, linkedLiabilityId: "loan-1", state: "upcoming", kind: "payment" });
    expect(past).toEqual([]);
    // The Calendar's own computation for the same record agrees.
    const sf = deriveScheduleFields(LOAN.fields, LOAN.type_key, TODAY);
    const cal = generateSchedule({ id: LOAN.id, fields: sf } as any, [], { todayISO: TODAY, windowStart: "2026-12-01", windowEnd: "2026-12-31" });
    expect(cal.map((o) => o.effectiveDate)).toEqual(["2026-12-20"]);
  });

  it("a cycle already paid moves to the next one, and the payment is under Past", () => {
    const paid = new Map([["loan-1", [{ id: "p1", paymentDate: "2026-12-20", amount: 412.5 }, { id: "p0", paymentDate: "2026-11-20", amount: 412.5 }]]]);
    const { upcoming, past } = debtPaymentRows([LOAN], [LOAN], paid, TODAY, { upcomingDays: 60 });
    expect(upcoming.map((r) => r.date)).toEqual(["2027-01-20"]);
    expect(past.map((r) => [r.date, r.state])).toEqual([["2026-11-20", "paid"]]);
  });

  it("a debt with no payment amount or no due day adds nothing (no invented date)", () => {
    expect(rows([{ ...LOAN, fields: { balance: 18400, dueDay: 20 } }]).upcoming).toEqual([]);
    expect(rows([{ ...LOAN, fields: { balance: 18400, monthlyPayment: 412.5 } }]).upcoming).toEqual([]);
  });

  it("is not a recurring bill (those come from the bills walk) and not a paired loan's second row", () => {
    const bill = { id: "b1", name: "Phone", type: "liability", type_key: "phone_plan", fields: { amount: 80, frequency: "monthly", dueDate: "2026-12-01" } };
    expect(isCalendarDebtProfile(bill)).toBe(false);
    expect(isCalendarDebtProfile(LOAN)).toBe(true);
    expect(rows([bill]).upcoming).toEqual([]);
    const paymentBill = { id: "b2", name: "Demo Auto Loan payment", type: "liability", type_key: "bill", fields: { amount: 412.5, frequency: "monthly", dueDate: "2026-12-20" } };
    expect(isCalendarDebtProfile(paymentBill)).toBe(false);
    expect(rows([LOAN], new Map(), [LOAN, paymentBill]).upcoming).toEqual([]);
  });

  it("merges with the bills, soonest first", () => {
    const bills = buildBillsTimeline([{ id: "b1", name: "Phone", amount: 80, frequency: "monthly", nextDueDate: "2026-12-01" }], TODAY);
    const merged = mergeBillsTimelines(bills, rows([LOAN]));
    expect(merged.upcoming.map((r) => r.name)).toEqual(["Phone", "Demo Auto Loan"]);
  });
});

describe("both storages put it in the dashboard snapshot", () => {
  it("MemStorage", async () => {
    const storage = new MemStorage();
    const snap: any = await requestStorageContext.run(storage as any, async () => {
      await storage.createProfile({ type: "liability", name: "Demo Auto Loan", fields: LOAN.fields, typeKey: "auto_loan" } as any);
      return storage.getDashboardEnhanced();
    });
    const up = snap.financeSnapshot.billsTimeline.upcoming;
    expect(up.map((r: any) => r.name)).toContain("Demo Auto Loan");
  });
  it("SupabaseStorage reads the debts and merges them into billsTimeline", () => {
    const src = readFileSync(resolve(__dirname, "../server/supabase-storage.ts"), "utf8");
    expect(src).toContain("billsTimeline: mergeBillsTimelines(buildBillsTimeline(allObligations as any[], today), debtTimelineEnh)");
    expect(src).toContain("return debtPaymentRows(debts, allProfiles as any[], byDebt, today);");
  });
  it("the Executive Money card lists the timeline it opens", () => {
    const src = readFileSync(resolve(__dirname, "../client/src/components/dashboard/ExecutiveBriefing.tsx"), "utf8");
    expect(src).toMatch(/const billsDueSoon = dedupeBills\(hideTest\(billsTimeline\.upcoming/);
  });
});
