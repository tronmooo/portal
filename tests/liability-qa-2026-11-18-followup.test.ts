// Liabilities tutorial QA, 2026-11-18 — the findings still open after the
// first round of fixes: a day
// of the month printed as "Jan 1, 2001", a first-payment date treated as a
// deadline, and a delete that landed on the Info tab.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fieldSemantics, dateMeaningFor, ACTIONABLE_DATE_MEANINGS } from "../shared/overview-semantics";
import { composeOverview } from "../shared/overview-compose";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const MORTGAGE = { id: "l-wf", name: "Wells Fargo Mortgage", type: "liability", type_key: "mortgage", fields: { balance: 312400, originalBalance: 350000, interestRate: 6.25, monthlyPayment: 2155, dueDay: 1, firstPaymentDate: "2022-07-01" } };

describe("a loan's Overview does not invent dates", () => {
  it("a day of the month is a number, never a date ('Jan 1, 2001')", () => {
    for (const k of ["dueDay", "due_day", "paymentDueDay"]) expect(fieldSemantics(k, 1).displayType, k).toBe("number");
    expect(fieldSemantics("dueDate", "2026-12-01").displayType).toBe("date");
    expect(fieldSemantics("nextPaymentDate", "2026-12-01").displayType).toBe("date");
  });

  it("a first payment date is history, not an actionable deadline", () => {
    expect(ACTIONABLE_DATE_MEANINGS.has(dateMeaningFor("firstPaymentDate"))).toBe(false);
    expect(ACTIONABLE_DATE_MEANINGS.has(dateMeaningFor("lastPaidDate"))).toBe(false);
    expect(dateMeaningFor("nextPaymentDate")).toBe("payment");
    const text = JSON.stringify(composeOverview({ entity: { ...MORTGAGE }, now: new Date("2026-11-18T12:00:00") } as any));
    expect(text).not.toMatch(/passed \d+ days? ago/);
    expect(text).not.toContain("2001");
  });
});

describe("deleting a liability", () => {
  it("returns to the Liabilities list, not the Info tab", () => {
    const page = src("client/src/pages/liability-detail.tsx");
    const at = page.indexOf("const deleteProfileMutation");
    expect(at).toBeGreaterThan(-1);
    // the whole mutation, however long its success message is
    const del = page.slice(at, page.indexOf("\n  });", at));
    expect(del).toContain('navigate("/linked?tab=liabilities")');
    expect(del).not.toContain('navigate("/profiles")');
  });
});
