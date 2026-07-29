import { describe, it, expect } from "vitest";
import { isTestDataRow, isTestEntity } from "../shared/test-data";

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
      // Audit 2026-07-29 (Tier 5): these reached today's agenda, the calendar
      // and Important Dates on a real account — no pattern covered them.
      "[QA-TASK] chat-created",
      "[QA-REM] Call the plumber",
      "[QA-EDGE] double click test",
      "QA_AUDIT_call mom",
      "ProbeA500",
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
      // Guards for the 2026-07-29 additions. Hiding a real row is worse than
      // showing a synthetic one, so each new pattern stays boundaried.
      "[Draft] Renew passport", // bracket tag, but not a QA one
      "[Urgent] Call the plumber",
      "QA audit of the roof",   // needs the QA_AUDIT / "QA AUDIT" token, not prose
      "Probe the drain",        // PROBE needs 2+ trailing digits
      "Probe A",
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
