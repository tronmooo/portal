// The rule that decides whether the extraction review's Continue/Save button
// is live, and the review screen that lists what will be saved and where.
//
// Bug report 2026-08-05: a receipt showing a $50 total. The user unticked every
// extracted row — merchant name, date, category, receipt details, profile info
// — because the only thing they wanted was the expense. Confirm went dead: the
// gate asked "is at least one extracted field ticked?", which is the
// PROFILE-extraction checklist, not the list of things to do.
//
// The gate asks this module instead: is at least one DESTINATION selected?
import { describe, it, expect } from "vitest";
import {
  buildSavePlan,
  selectedSaveActions,
  hasSelectedSaveAction,
  parseAmount,
  formatFieldValue,
} from "../shared/extraction-save-plan";

const receiptFields = [
  { key: "merchantName", value: "Corner Market" },
  { key: "transactionDate", value: "2026-08-04" },
  { key: "totalAmount", value: 50 },
];

describe("save plan — the Continue/Save gate", () => {
  it("stays live with EVERY extracted field deselected, when the total is saved as an expense", () => {
    // Exactly the reported case: nothing ticked in the checklist, one
    // destination chosen. This must be a complete, savable request.
    const plan = buildSavePlan({
      extractionId: "doc-1",
      confirmedFields: [],
      targetProfileId: "profile-self",
      saveToProfile: false,
      saveDocument: false,
      createExpense: { amount: 50, category: "food", date: "2026-08-04" },
    }, { profileName: "Robert" });

    expect(plan.canSave).toBe(true);
    expect(plan.actions).toEqual(["expense"]);
    // …and nothing else is written. No profile, no document.
    expect(plan.destinations.map((d) => d.id)).not.toContain("profile");
    expect(plan.destinations.map((d) => d.id)).not.toContain("document");
  });

  it("is dead ONLY when no destination at all is selected", () => {
    const nothing = buildSavePlan({
      extractionId: "doc-1",
      confirmedFields: [],
      saveToProfile: false,
      saveDocument: false,
    });
    expect(nothing.canSave).toBe(false);
    expect(nothing.actions).toEqual([]);
  });

  it("is live for a profile-only save, a document-only save, and any combination", () => {
    const profileOnly = buildSavePlan({
      confirmedFields: receiptFields,
      targetProfileId: "p1",
      saveToProfile: true,
      saveDocument: false,
    });
    expect(profileOnly.actions).toEqual(["profile"]);

    const documentOnly = buildSavePlan({
      confirmedFields: [],
      saveToProfile: false,
      saveDocument: true,
    });
    expect(documentOnly.actions).toEqual(["document"]);

    const everything = buildSavePlan({
      confirmedFields: receiptFields,
      targetProfileId: "p1",
      saveToProfile: true,
      saveDocument: true,
      createExpense: { amount: 50, category: "food", date: "2026-08-04" },
    });
    expect(everything.actions).toEqual(["profile", "document", "expense"]);
    expect(everything.canSave).toBe(true);
  });

  it("does not count an expense that has no usable amount — and says why", () => {
    const plan = buildSavePlan({
      confirmedFields: [],
      saveToProfile: false,
      saveDocument: false,
      createExpense: { amount: "", category: "general" },
    });
    expect(plan.canSave).toBe(false);
    expect(plan.blockers.join(" ")).toContain("amount greater than 0");
  });

  it("ticked fields alone are still enough — the legacy path keeps working", () => {
    // No flags at all: an older client posting only confirmedFields.
    expect(hasSelectedSaveAction({ confirmedFields: receiptFields })).toBe(true);
    expect(selectedSaveActions({ confirmedFields: receiptFields })).toContain("profile");
  });
});

describe("save plan — the review screen", () => {
  it("names every destination and the exact values going to it", () => {
    const plan = buildSavePlan({
      extractionId: "doc-1",
      confirmedFields: [{ key: "merchantName", value: "Corner Market" }],
      targetProfileId: "profile-crv",
      saveToProfile: true,
      saveDocument: true,
      createExpense: {
        amount: 50,
        category: "food",
        date: "2026-08-04",
        vendor: "Corner Market",
        description: "Groceries",
      },
    }, {
      profileName: "Robert",
      documentLabel: "Corner Market Receipt",
      fieldLabels: { merchantName: "Merchant Name" },
      deselectedLabels: ["Transaction Date", "Total Amount"],
    });

    const profile = plan.destinations.find((d) => d.id === "profile")!;
    expect(profile.where).toBe("Profile · Robert");
    expect(profile.items).toEqual(["Merchant Name: Corner Market"]);

    const doc = plan.destinations.find((d) => d.id === "document")!;
    expect(doc.items.join(" | ")).toContain("Corner Market Receipt");
    expect(doc.items.join(" | ")).toContain("Linked to Robert");

    const expense = plan.destinations.find((d) => d.id === "expense")!;
    expect(expense.where).toBe("Finance · Expenses");
    expect(expense.summary).toContain("$50.00");
    // The four things the user chose: total, category, payment date, owner.
    expect(expense.items).toContain("Amount: $50.00");
    expect(expense.items).toContain("Category: Food");
    expect(expense.items).toContain("Date: 2026-08-04");
    expect(expense.items).toContain("Owner: Robert");

    // Deselected rows are stated as NOT saved rather than quietly dropped.
    expect(plan.notSaved).toEqual(["Transaction Date", "Total Amount"]);
  });

  it("shows a $50-only save as one destination with one line", () => {
    const plan = buildSavePlan({
      confirmedFields: [],
      saveToProfile: false,
      saveDocument: false,
      createExpense: { amount: "50.00", category: "general", date: "2026-08-04" },
    }, { profileName: "Robert" });

    expect(plan.destinations).toHaveLength(1);
    expect(plan.destinations[0].id).toBe("expense");
    expect(plan.destinations[0].summary).toBe("A $50.00 expense is created");
  });

  it("lists calendar events, tracker entries and recurring bills as their own destinations", () => {
    const plan = buildSavePlan({
      confirmedFields: [],
      saveToProfile: false,
      saveDocument: false,
      createCalendarEvents: [{ field: "expirationDate", date: "2027-01-01", title: "⚠️ Expiration Date" }],
      trackerEntries: [{ trackerName: "Weight", values: { value: 180 }, unit: "lbs" }],
      createObligation: { name: "Progressive", amount: 155, frequency: "monthly", nextDueDate: "2026-09-01" },
    });
    expect(plan.actions.sort()).toEqual(["calendar", "obligation", "tracker"]);
    expect(plan.destinations.find((d) => d.id === "tracker")!.items[0]).toBe("Weight: 180 lbs");
    expect(plan.destinations.find((d) => d.id === "calendar")!.items[0]).toContain("2027-01-01");
  });
});

describe("save plan — value helpers", () => {
  it("reads amounts typed with a currency symbol or commas", () => {
    expect(parseAmount("$1,234.56")).toBeCloseTo(1234.56);
    expect(parseAmount(50)).toBe(50);
    expect(parseAmount("abc")).toBe(null);
  });

  it("unwraps {value, confidence} so the review shows the value, not [object Object]", () => {
    expect(formatFieldValue({ value: 69063, confidence: 0.98 })).toBe("69063");
    expect(formatFieldValue("")).toBe("—");
  });
});
