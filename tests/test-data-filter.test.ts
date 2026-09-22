import { describe, it, expect } from "vitest";
import { isTestDataRow, isTestEntity, excludeTestData } from "../shared/test-data";
import { financialSnapshot } from "../server/ai-financial-snapshot";

describe("isTestDataRow", () => {
  it("matches the synthetic patterns that polluted the real account", () => {
    for (const s of [
      "AUDIT4C9B25_Bob_exp",
      "AUDIT24F7D7_Self_obl",
      "QAMULTI389053_asset_bob_kayak",
      "W2_1780532176_Hsub",
      "SMOKE_Spouse",
      "QA_TEST_Coffee",
      "QA Test Expense EDITED",
      "EMPTYPROBE_QA",
      "__qa_e2e__ shared expense",
      "__qa_cascade_test__ sole expense",
      "__aichat_audit_cfd4d673__ weekly groceries",
      "Test Expense QA",
      "Internet bill_QA",
      // Executive-tab leak report (2026-07-29): rows visible despite matching
      // the AUDIT/QA naming conventions.
      "AUDIT TEST TASK — please delete",
      "Buy printer paper QA778",
      "Test QA Task",
      "Test Habit QA",
      "QA Test Daily Habit",
      "QA Test Subscription",
      "QAMULTI389053_habit_self_read",
    ]) {
      expect(isTestDataRow(s), s).toBe(true);
    }
  });

  it("does NOT match real, user-entered names", () => {
    for (const s of [
      "Groceries",
      "Drugs - Bob",
      "Mike's House",
      "Ford F150 2025",
      "Quarterly taxes",
      "Coffee",
      "Rent",
      "QA Manager salary", // 'QA' as a real word, not the QA_/QA Test prefix
      "Quarterly Audit fees",
      "Audit the garage",       // AUDIT as a verb, not the AUDIT-TEST prefix
      "Test drive the new car", // starts with Test but doesn't end in QA
      "Room QA1 inspection",    // QA+digits needs 3+ digits
    ]) {
      expect(isTestDataRow(s), s).toBe(false);
    }
  });

  it("is null/undefined safe", () => {
    expect(isTestDataRow(null)).toBe(false);
    expect(isTestDataRow(undefined)).toBe(false);
    expect(isTestDataRow("")).toBe(false);
  });

  it("isTestEntity checks name OR description", () => {
    expect(isTestEntity({ name: "AUDIT24F7D7_Self_obl" })).toBe(true);
    expect(isTestEntity({ description: "__qa_e2e__ x" })).toBe(true);
    expect(isTestEntity({ name: "Bob", description: "Groceries" })).toBe(false);
    expect(isTestEntity(null)).toBe(false);
  });
});

// ─── Rule 27: test rows never enter a total unless the caller opted in ───────
describe("excludeTestData", () => {
  const rows = [
    { id: "a", description: "Groceries", amount: 40 },
    { id: "b", description: "QA_TEST_Coffee", amount: 5 },
    { id: "c", name: "AUDIT4C9B25_Bob_exp", amount: 9 },
  ];

  it("drops test-patterned rows by default", () => {
    expect(excludeTestData(rows).map((r) => r.id)).toEqual(["a"]);
    expect(excludeTestData(rows, false).map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps them only when includeTestData is on, and is safe on nothing", () => {
    expect(excludeTestData(rows, true)).toBe(rows as any);
    expect(excludeTestData(null)).toEqual([]);
    expect(excludeTestData(undefined, true)).toEqual([]);
  });

  it("keeps the AI's financial snapshot free of test rows", () => {
    const ym = new Date().toISOString().slice(0, 7);
    const input = {
      allProfiles: [{ id: "self", type: "self", name: "Me", fields: {} }],
      obligations: [
        { name: "Netflix", amount: 12, frequency: "monthly", status: "active" },
        { name: "QA Test Subscription", amount: 100, frequency: "monthly", status: "active" },
      ],
      expenses: [
        { description: "Groceries", amount: 40, date: `${ym}-02` },
        { description: "__qa_e2e__ shared expense", amount: 500, date: `${ym}-03` },
      ],
      timezone: "UTC",
    };
    const clean = financialSnapshot(input);
    expect(clean.monthlySubs).toBe(12);
    expect(clean.thisMonthSpend).toBe(40);
    const withTest = financialSnapshot({ ...input, includeTestData: true });
    expect(withTest.monthlySubs).toBe(112);
    expect(withTest.thisMonthSpend).toBe(540);
  });
});
