// Liabilities tutorial 2026-11-20 — the term, the paused tile, the payoff
// date, the stale summary and the auto-saving form's Undo.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loanStoredTermMonths } from "../shared/loan-facts";
import { deriveScheduleFields } from "../shared/liability-schedule";
import { profileValueFingerprint, summaryIsStale } from "../shared/profile-summary-fingerprint";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const TODAY = "2026-11-20";

describe("a loan's original term is not its months left", () => {
  const loan = { balance: 9000, monthlyPayment: 300, termMonths: 36, firstPaymentDate: "2026-03-10", dueDay: 10 };

  it("36 months from March 2026 has 27 payments left in late November, not 36", () => {
    // Paid Mar…Nov (9); the next is Dec 10.
    expect(loanStoredTermMonths(loan, TODAY)).toBe(27);
    expect(deriveScheduleFields(loan, "auto_loan", TODAY).count).toBe(27);
  });

  it("a loan that has not started yet still has its whole term", () => {
    expect(loanStoredTermMonths({ ...loan, firstPaymentDate: "2027-01-10" }, TODAY)).toBe(36);
  });

  it("a loan past its term has nothing left", () => {
    expect(loanStoredTermMonths({ ...loan, termMonths: 6 }, TODAY)).toBe(0);
  });

  it("an explicit 'months left' is the user's answer and wins", () => {
    expect(loanStoredTermMonths({ ...loan, remainingTermMonths: 20 }, TODAY)).toBe(20);
  });

  it("with no first payment there is nothing to count down from", () => {
    expect(loanStoredTermMonths({ termMonths: 36 }, TODAY)).toBe(36);
    expect(loanStoredTermMonths({ remainingTermMonths: 360, firstPaymentDate: "2022-07-01" }, TODAY)).toBe(360);
    expect(loanStoredTermMonths({}, TODAY)).toBe(0);
  });

  it("the chat stores the stated term as the original term", () => {
    const engine = src("server/ai-engine.ts");
    expect(engine).toContain("if (input.termMonths != null) fields.termMonths = Number(input.termMonths);");
    expect(engine).toContain("if (input.termMonths == null && started && !saidLeft) fields.termMonths = Number(input.remainingTermMonths);");
  });
});

describe("the AI summary knows about a payment", () => {
  const before = { type: "liability", fields: { balance: 21499.5, lastPaidDate: "2026-11-18" } };

  it("a payment that moves the balance makes the summary stale", () => {
    const fp = profileValueFingerprint(before);
    expect(summaryIsStale({ fingerprint: fp }, { ...before, fields: { balance: 21399.5, lastPaidDate: "2026-11-20" } })).toBe(true);
    expect(summaryIsStale({ fingerprint: fp }, before)).toBe(false);
  });

  it("a later payment that leaves the balance equal still does", () => {
    const fp = profileValueFingerprint(before);
    expect(summaryIsStale({ fingerprint: fp }, { ...before, fields: { ...before.fields, lastPaidDate: "2026-11-20" } })).toBe(true);
  });

  it("the liability page compares fingerprints and asks again; the summary is written from the ledger", () => {
    const page = src("client/src/pages/liability-detail.tsx");
    expect(page).toContain("<AISummaryCard profileId={profile.id} valueFingerprint={profileValueFingerprint(profile)} />");
    expect(page).toContain("const summaryStale = !!aiSummary?.fingerprint && !!valueFingerprint && aiSummary.fingerprint !== valueFingerprint;");
    expect(src("server/routes.ts")).toContain("profileData.recentPayments = (recent || []).slice(0, 6)");
  });
});

describe("the liability page says what is true", () => {
  const page = src("client/src/pages/liability-detail.tsx");

  it("a paused bill's status reads Paused, not Upcoming", () => {
    expect(page).toContain("const billHeldLabel: string | null = recurringBill && isPausedBillFields(f2)");
    expect(page.split('seriesComplete ? "Complete" : billHeldLabel ?? BILL_STATUS_META[billStatusEff].label').length - 1).toBe(2);
    expect(page).not.toContain('seriesComplete ? "Complete" : BILL_STATUS_META[billStatusEff].label');
  });

  it("the payoff date shows a four-digit year ('Oct 2031', not 'Oct 31')", () => {
    const outlook = src("client/src/components/liability/PayoffOutlook.tsx");
    expect(outlook).toContain('{ month: "short", year: "numeric" }');
    expect(outlook).not.toContain('year: "2-digit"');
    expect(new Date(2031, 9, 12).toLocaleDateString("en-US", { month: "short", year: "numeric" })).toBe("Oct 2031");
  });

  it("an auto-saved edit can be undone, and shows in the header at once", () => {
    expect(page).toContain('data-testid="button-undo-terms-edits"');
    expect(page).toContain('data-testid="button-undo-bill-edits"');
    expect(page).toContain("const o = termsAutosave.opened;");
    // The saved fields go into the detail cache before the refetch.
    expect(page.split("patchDetailFields(fields);").length - 1).toBe(2);
    // Done waits for the save before the form closes.
    expect(page).toContain("const closeTermsEditor = async () => { await termsAutosave.flush(); setEditingTerms(false); };");
  });
});

import { splitPrimaryNameField } from "../shared/registry-fields";

describe("Add Liability asks for the name once", () => {
  const card = [
    { key: "card_name", label: "Card Name", type: "text", required: true, placeholder: "e.g. Chase Sapphire Reserve" },
    { key: "issuer", label: "Issuer", type: "text" },
    { key: "current_balance", label: "Current Balance", type: "currency", required: true },
  ];

  it("the type's own name field is taken out of the form", () => {
    const { nameField, rest } = splitPrimaryNameField(card);
    expect(nameField?.key).toBe("card_name");
    expect(rest.map((f) => f.key)).toEqual(["issuer", "current_balance"]);
  });

  it("a different fact that happens to end in _name stays", () => {
    const loan = [{ key: "lender_name", type: "text", required: true }, { key: "provider_name", type: "text" }];
    expect(splitPrimaryNameField(loan).nameField).toBeNull();
    expect(splitPrimaryNameField(loan).rest).toHaveLength(2);
    expect(splitPrimaryNameField(null).rest).toEqual([]);
  });

  it("the dialog builds, validates and saves from the schema without it", () => {
    const dialog = src("client/src/components/CreateProfileDialog.tsx");
    expect(dialog).toContain("splitPrimaryNameField(selectedTypeDef?.field_schema");
    expect(dialog).toContain("fieldSchema={formSchema as any}");
    expect(dialog).toContain("missingRequiredFields(formSchema as any, fields)");
    expect(dialog).not.toContain("fieldSchema={selectedTypeDef.field_schema}");
  });
});
