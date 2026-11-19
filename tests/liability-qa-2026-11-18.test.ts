// Liabilities tutorial QA, 2026-11-18 — the numbers, labels and buttons that
// disagreed with the data. (The chat-side findings are pinned in
// tests/liability-chat-one-record.test.ts.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { applyLiabilityPayment } from "../server/liability-payments";
import { splitDebtPayment } from "../shared/liability-calc";
import { liabilitySubtypeLabel, LIABILITY_SUBTYPE_LABELS } from "../shared/liability-types";
import { fieldSemantics, dateMeaningFor, ACTIONABLE_DATE_MEANINGS } from "../shared/overview-semantics";
import { composeOverview } from "../shared/overview-compose";
import { deriveScheduleFields, resolveLiabilityDueDate } from "../shared/liability-schedule";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

function fakeStorage(liability: any) {
  return {
    createLiabilityPayment: async (data: any) => ({ id: "pay-1", ...data }),
    updateProfile: async (_id: string, patch: any) => {
      liability = { ...liability, ...patch, fields: { ...liability.fields, ...patch.fields } };
      return liability;
    },
  } as any;
}

const CHASE = { id: "l-chase", name: "Chase Sapphire", type: "liability", type_key: "credit_card", fields: { balance: 3200, interestRate: 24.99, minimumPayment: 35 } };
const MORTGAGE = { id: "l-wf", name: "Wells Fargo Mortgage", type: "liability", type_key: "mortgage", fields: { balance: 312400, originalBalance: 350000, interestRate: 6.25, monthlyPayment: 2155, dueDay: 1, firstPaymentDate: "2022-07-01" } };

describe("a credit card payment comes off the balance in full", () => {
  it("$500 on a $3,200 card leaves $2,700 — no month of interest invented at payment time", async () => {
    const out = await applyLiabilityPayment(fakeStorage(CHASE), CHASE, { amount: 500 }, "America/New_York");
    expect(out.principal).toBe(500);
    expect(out.interest).toBe(0);
    expect(out.newBalance).toBe(2700);
  });

  it("interest the caller states is still recorded", async () => {
    const out = await applyLiabilityPayment(fakeStorage(CHASE), CHASE, { amount: 500, interest: 66.64 }, "UTC");
    expect(out.interest).toBe(66.64);
    expect(out.newBalance).toBe(2766.64);
  });

  it("an amortizing loan keeps the amortization split", async () => {
    const out = await applyLiabilityPayment(fakeStorage(MORTGAGE), MORTGAGE, { amount: 2155 }, "UTC");
    expect(out.interest).toBeCloseTo(1627.08, 2);
    expect(out.principal).toBeCloseTo(527.92, 2);
  });

  it("the dialog previews the same split the server books", () => {
    expect(splitDebtPayment(500, 3200, 0.2499, { typeKey: "credit_card" })).toMatchObject({ principal: 500, interest: 0, remainingBalanceAfter: 2700 });
    expect(splitDebtPayment(2155, 312400, 0.0625, { typeKey: "mortgage" }).interest).toBeCloseTo(1627.08, 2);
    expect(splitDebtPayment(100, 312400, 0.0625, { typeKey: "mortgage", extraPrincipal: true })).toMatchObject({ principal: 100, interest: 0 });
  });
});

describe("'Extra principal' is principal only", () => {
  it("the server books an extra_principal payment with no interest", async () => {
    const out = await applyLiabilityPayment(fakeStorage(MORTGAGE), MORTGAGE, { amount: 100, paymentType: "extra_principal" }, "UTC");
    expect(out.principal).toBe(100);
    expect(out.interest).toBe(0);
    expect(out.newBalance).toBe(312300);
  });

  it("the button sends the extra alone, typed as extra_principal", () => {
    const page = src("client/src/pages/liability-detail.tsx");
    expect(page).toContain('else if (preset === "extra") initial = "100.00";');
    expect(page).toContain('...(input.extraPrincipal ? { paymentType: "extra_principal" } : {})');
    expect(page).toContain('extraPrincipal: paymentDialog.preset === "extra"');
    expect(page).not.toMatch(/monthlyPayment \|\| summary\.monthlyPayment \|\| 0\) \+ 100/);
  });
});

describe("a debt's type is the same word everywhere", () => {
  it("labels the subtype from the type_key column", () => {
    expect(liabilitySubtypeLabel({ type_key: "mortgage", fields: {} })).toBe("Mortgage");
    expect(liabilitySubtypeLabel({ type_key: "auto_loan", fields: {} })).toBe("Auto loan");
    expect(liabilitySubtypeLabel({ fields: {} })).toBeNull();
    // Every subtype the chat tool can write has a label.
    for (const k of ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "heloc", "business_loan", "medical_debt", "tax_debt", "bnpl", "other"]) {
      expect(LIABILITY_SUBTYPE_LABELS[k], k).toBeTruthy();
    }
  });

  it("the list and the profile page read the one label map", () => {
    const list = src("client/src/pages/trackers.tsx");
    expect(list).toMatch(/const debtKey = String\(liabilityTypeKeyOf\(p\)/);
    expect(list).toContain("LIABILITY_SUBTYPE_LABELS[debtKey]");
    const page = src("client/src/pages/liability-detail.tsx");
    expect(page).toContain("const SUBTYPE_LABELS = LIABILITY_SUBTYPE_LABELS;");
    expect(page).not.toMatch(/SUBTYPE_LABELS(_LOCAL)?: Record<string, string> = \{\s*\n\s*mortgage:/);
  });
});

describe("a new loan is not overdue since the day it was opened", () => {
  it("the stored-date reader answers with the origin date — so the list must not use it for a loan", () => {
    expect(resolveLiabilityDueDate(MORTGAGE.fields)).toBe("2022-07-01");
    expect(deriveScheduleFields(MORTGAGE.fields, "mortgage", "2026-11-18").nextDueDate).toBe("2026-12-01");
    const list = src("client/src/pages/trackers.tsx");
    expect(list).toMatch(/const rawDue = isBillRow\s*\n\s*\? \(resolveLiabilityDueDate\(\{ \.\.\.fin, \.\.\.fields \}\) \?\? scheduledDue \?\? fin\.dueDate\)\s*\n\s*: \(scheduledDue \?\? null\);/);
  });

  it("a day of the month is a number, never a date ('Jan 1, 2001')", () => {
    for (const k of ["dueDay", "due_day", "paymentDueDay"]) {
      const sem = fieldSemantics(k, 1);
      expect(sem.displayType, k).toBe("number");
    }
    // Real due dates are still dates.
    expect(fieldSemantics("dueDate", "2026-12-01").displayType).toBe("date");
    expect(fieldSemantics("nextPaymentDate", "2026-12-01").displayType).toBe("date");
  });

  it("a first payment date is history, not an actionable deadline", () => {
    expect(ACTIONABLE_DATE_MEANINGS.has(dateMeaningFor("firstPaymentDate"))).toBe(false);
    expect(ACTIONABLE_DATE_MEANINGS.has(dateMeaningFor("lastPaidDate"))).toBe(false);
    expect(dateMeaningFor("nextPaymentDate")).toBe("payment");
    const spec = composeOverview({ entity: { ...MORTGAGE }, now: new Date("2026-11-18T12:00:00") } as any);
    const text = JSON.stringify(spec);
    expect(text).not.toMatch(/passed \d+ days? ago/);
    expect(text).not.toContain("2001");
  });
});

describe("the rate reads the same in every panel", () => {
  it("a row that stores the rate as a decimal is still shown as 6.25, not 0.1", () => {
    const spec = composeOverview({
      entity: { ...MORTGAGE, fields: { ...MORTGAGE.fields, interestRate: 0.0625 } },
      now: new Date("2026-11-18T12:00:00"),
    } as any);
    const percents: any[] = [];
    JSON.stringify(spec, (_k, v) => { if (v && typeof v === "object" && v.displayType === "percent" && v.sourceReference?.fieldKey === "interestRate") percents.push(v.value); return v; });
    expect(percents.length).toBeGreaterThan(0);
    for (const v of percents) expect(v).toBe(6.25);
  });

  it("the terms form opens with a percent and saves what was typed", () => {
    const page = src("client/src/pages/liability-detail.tsx");
    expect(page).toContain("const ratePct = readInterestRatePct(profile.fields || {});");
    expect(page).toContain("if (r != null) fields.interestRate = r;");
    expect(page).not.toContain("fields.annualInterestRate = r > 1 ? r / 100 : r");
  });
});

describe("profile page behaviour", () => {
  const page = src("client/src/pages/liability-detail.tsx");

  it("reversing a payment takes two taps (Rule 8)", () => {
    expect(page).toContain("const { confirm: confirmReverse, isArmed: isReverseArmed } = useConfirmArm();");
    expect(page).toContain("onReverse={() => confirmReverse(p.id, () => reversePaymentMutation.mutate(p))}");
    expect(page).not.toContain("onReverse={() => reversePaymentMutation.mutate(p)}");
  });

  it("deleting a liability returns to the Liabilities list, not the Info tab", () => {
    const del = page.slice(page.indexOf("const deleteProfileMutation"), page.indexOf("const deleteProfileMutation") + 900);
    expect(del).toContain('navigate("/linked?tab=liabilities")');
    expect(del).not.toContain('navigate("/profiles")');
  });

  it("the nested panel lists children (parentProfileId), which is how a nested liability is stored", () => {
    expect(page).toMatch(/p\?\.parentProfileId === liabilityId && isLiabilityTabProfile\(p\)/);
  });

  it("the Activity tab dates a day-only payment in the user's own zone", () => {
    expect(page).toContain("...activityStamp(ts),");
    const card = page.slice(page.indexOf("function ActivityTimelineCard"));
    expect(card).not.toMatch(/timestamp: new Date\(/);
  });

  it("the header refetches a balance changed from another page", () => {
    const detail = src("client/src/pages/profile-detail.tsx");
    const at = detail.indexOf('queryKey: ["/api/profiles", id, "detail"]');
    expect(at).toBeGreaterThan(-1);
    const query = detail.slice(at, detail.indexOf("});", detail.indexOf("staleTime: 30 * 1000", at)));
    expect(query).not.toMatch(/^\s*refetchOnMount: false/m);
  });
});
