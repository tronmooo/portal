import { describe, it, expect } from "vitest";
import {
  parseAmount,
  buildExpensePayload,
  buildIncomePayload,
  buildBillPayload,
  buildNotePayload,
  buildTimedTaskPayload,
} from "../shared/quick-add";

describe("parseAmount", () => {
  it("strips currency formatting", () => {
    expect(parseAmount("$1,234.50")).toBe(1234.5);
    expect(parseAmount("50")).toBe(50);
    expect(parseAmount(42)).toBe(42);
  });
  it("returns NaN for empty/garbage", () => {
    expect(Number.isNaN(parseAmount(""))).toBe(true);
    expect(Number.isNaN(parseAmount(null))).toBe(true);
    expect(Number.isNaN(parseAmount("abc"))).toBe(true);
  });
});

describe("buildExpensePayload", () => {
  it("builds a valid body and attaches the owner profile", () => {
    const r = buildExpensePayload({ description: " Coffee ", amount: "$12.50", category: "food", vendor: " Starbucks " }, "bob");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toMatchObject({ description: "Coffee", amount: 12.5, category: "food", vendor: "Starbucks", linkedProfiles: ["bob"] });
    }
  });
  it("defaults category and omits linkedProfiles when no owner", () => {
    const r = buildExpensePayload({ description: "X", amount: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.category).toBe("general");
      expect("linkedProfiles" in r.body).toBe(false);
    }
  });
  it("rejects empty description and non-positive amount", () => {
    expect(buildExpensePayload({ description: "", amount: 5 }).ok).toBe(false);
    expect(buildExpensePayload({ description: "X", amount: 0 }).ok).toBe(false);
    expect(buildExpensePayload({ description: "X", amount: -3 }).ok).toBe(false);
  });
});

describe("buildIncomePayload", () => {
  it("defaults frequency/category and links the owner", () => {
    const r = buildIncomePayload({ description: "Salary", amount: 3000 }, "alice");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toMatchObject({ description: "Salary", amount: 3000, frequency: "monthly", category: "salary", linkedProfiles: ["alice"] });
  });
  it("rejects bad amount", () => {
    expect(buildIncomePayload({ description: "Salary", amount: "" }).ok).toBe(false);
  });
});

describe("buildBillPayload", () => {
  it("builds an obligation body with autopay default false", () => {
    const r = buildBillPayload({ name: "Netflix", amount: 20, frequency: "monthly", nextDueDate: "2026-07-01" }, "bob");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toMatchObject({ name: "Netflix", amount: 20, frequency: "monthly", nextDueDate: "2026-07-01", autopay: false, linkedProfiles: ["bob"] });
  });
  it("rejects empty name", () => {
    expect(buildBillPayload({ name: "  ", amount: 20 }).ok).toBe(false);
  });
});

describe("buildNotePayload", () => {
  it("trims content, defaults mood, and rejects empty", () => {
    const r = buildNotePayload({ content: " hello " }, "bob");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toMatchObject({ content: "hello", mood: "neutral", linkedProfiles: ["bob"] });
    expect(buildNotePayload({ content: "   " }).ok).toBe(false);
  });
});

// The quick-add tile that used to write a reminder writes a TIMED TASK.
// Reminders were retired 2026-08-09 — Portol has events and tasks, and a task
// carries its own clock time — so the datetime the dialog collects has to reach
// the task as a due DATE plus a due TIME, not as one opaque string.
describe("buildTimedTaskPayload", () => {
  it("splits the datetime into dueDate + dueTime and links the owner", () => {
    const r = buildTimedTaskPayload({ title: "Call mom", at: "2026-07-01T09:00" }, "bob");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toMatchObject({
      title: "Call mom", dueDate: "2026-07-01", dueTime: "09:00", linkedProfiles: ["bob"],
    });
  });
  it("leaves a date-only value as an all-day task", () => {
    const r = buildTimedTaskPayload({ title: "Buy milk", at: "2026-07-01" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.dueDate).toBe("2026-07-01");
      expect(r.body.dueTime).toBeUndefined();
    }
  });
  it("rejects empty title", () => {
    expect(buildTimedTaskPayload({ title: "" }).ok).toBe(false);
  });
});
