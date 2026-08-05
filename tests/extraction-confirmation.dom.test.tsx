// @vitest-environment jsdom
//
// The extraction review panel that appears after a photo/document upload.
//
// Bug report 2026-08-05 (grocery receipt, $50 total): the user unticked every
// extracted row — merchant name, date, category, receipt details, profile info
// — because the ONLY thing they wanted was the $50 expense. The Confirm button
// went dead. Its gate was `fields.every(f => !f.selected)`: the checklist of
// PROFILE fields, not the list of destinations. Deselecting everything is a
// legitimate end state, so the gate now asks whether at least one destination
// action is selected.
//
// These tests press the real controls: untick every row, tick the expense, and
// assert the button is live, the review screen says exactly what is saved and
// where, and the payload that goes over the wire carries the expense ONLY.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExtractionConfirmation } from "../client/src/components/chat/ExtractionConfirmation";

const PROFILES = [
  { id: "profile-self", name: "Robert", type: "self" },
  { id: "profile-crv", name: "Robert's Honda CR-V", type: "vehicle" },
];

/** A grocery receipt: a $50 total plus the incidental data the user doesn't want. */
const receiptExtraction = () => ({
  extractionId: "doc-receipt",
  fileName: "receipt.jpg",
  documentType: "receipt",
  label: "Corner Market Receipt",
  extractedFields: [
    { key: "merchantName", label: "Merchant Name", value: "Corner Market", selected: true, isDate: false, category: "OTHER" },
    { key: "transactionDate", label: "Transaction Date", value: "2026-08-04", selected: true, isDate: true, category: "DATE" },
    { key: "category", label: "Category", value: "Groceries", selected: true, isDate: false, category: "OTHER" },
    { key: "totalAmount", label: "Total Amount", value: "50.00", selected: true, isDate: false, category: "FINANCE" },
  ],
  targetProfile: { name: "Robert", id: "profile-self", type: "self", isNew: false },
  trackerEntries: [],
});

function renderPanel(extraction: any, onConfirm = vi.fn(async () => true)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["/api/profiles"], PROFILES);
  render(
    <QueryClientProvider client={qc}>
      <ExtractionConfirmation extraction={extraction} onConfirm={onConfirm} onSkip={() => {}} />
    </QueryClientProvider>,
  );
  return { onConfirm };
}

const continueButton = () => screen.getByTestId("button-confirm-extraction") as HTMLButtonElement;
const deselectAll = () => fireEvent.click(screen.getByTestId("button-toggle-all-fields"));

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("extraction review — nothing is required except a destination", () => {
  it("keeps Continue live when every extracted field is deselected", () => {
    renderPanel(receiptExtraction());
    deselectAll();
    // "Save the original as a document" is still on — one destination is
    // enough. This is precisely what used to disable the button.
    expect(continueButton().disabled).toBe(false);
  });

  it("goes dead only when the user turns off every destination too", () => {
    renderPanel(receiptExtraction());
    deselectAll();
    fireEvent.click(screen.getByLabelText("Save selected information to a profile"));
    fireEvent.click(screen.getByLabelText("Save the original as a document"));
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByTestId("no-destination-hint").textContent).toContain("at least one place");
  });

  it("stays live with ONLY the total saved as an expense — no profile, no document", async () => {
    const { onConfirm } = renderPanel(receiptExtraction());
    deselectAll();
    fireEvent.click(screen.getByLabelText("Save the total as an expense"));
    fireEvent.click(screen.getByLabelText("Save selected information to a profile"));
    fireEvent.click(screen.getByLabelText("Save the original as a document"));
    expect(continueButton().disabled).toBe(false);

    fireEvent.click(continueButton());
    await act(async () => { fireEvent.click(screen.getByTestId("button-confirm-extraction-save")); });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const payload = (onConfirm as any).mock.calls[0][0];
    // The $50 expense, and NOTHING else. No deselected data rides along.
    expect(payload.createExpense.amount).toBe(50);
    expect(payload.confirmedFields).toEqual([]);
    expect(payload.saveToProfile).toBe(false);
    expect(payload.saveDocument).toBe(false);
    expect(payload.createCalendarEvents).toEqual([]);
    expect(payload.trackerEntries).toEqual([]);
  });

  it("creates the expense from the total, owner, category and payment date the user chose", async () => {
    const { onConfirm } = renderPanel(receiptExtraction());
    deselectAll();
    fireEvent.click(screen.getByLabelText("Save the total as an expense"));
    // The detected total seeds the draft; every part of it stays editable.
    fireEvent.change(screen.getByTestId("input-expense-amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByTestId("select-expense-category"), { target: { value: "food" } });
    fireEvent.change(screen.getByTestId("input-expense-date"), { target: { value: "2026-08-04" } });
    fireEvent.change(screen.getByTestId("select-extraction-profile"), { target: { value: "profile-crv" } });

    fireEvent.click(continueButton());
    await act(async () => { fireEvent.click(screen.getByTestId("button-confirm-extraction-save")); });

    const payload = (onConfirm as any).mock.calls[0][0];
    expect(payload.createExpense).toMatchObject({
      amount: 50,
      category: "food",
      date: "2026-08-04",
      profileId: "profile-crv",
    });
  });

  it("sends only the fields still ticked when the user keeps some of them", async () => {
    const { onConfirm } = renderPanel(receiptExtraction());
    deselectAll();
    fireEvent.click(screen.getByTestId("field-checkbox-merchantName"));
    fireEvent.click(continueButton());
    await act(async () => { fireEvent.click(screen.getByTestId("button-confirm-extraction-save")); });

    const payload = (onConfirm as any).mock.calls[0][0];
    expect(payload.confirmedFields).toEqual([{ key: "merchantName", value: "Corner Market" }]);
  });
});

describe("extraction review — the confirmation screen", () => {
  it("shows what will be saved and where before anything is sent", async () => {
    const { onConfirm } = renderPanel(receiptExtraction());
    deselectAll();
    fireEvent.click(screen.getByLabelText("Save the total as an expense"));
    fireEvent.click(screen.getByLabelText("Save selected information to a profile"));
    fireEvent.click(screen.getByLabelText("Save the original as a document"));
    fireEvent.click(continueButton());

    // Pressing Continue reviews; it does NOT save.
    expect(onConfirm).not.toHaveBeenCalled();
    const review = screen.getByTestId("extraction-review");
    expect(review.textContent).toContain("this is what will be saved");

    const expense = screen.getByTestId("review-destination-expense");
    expect(expense.textContent).toContain("Finance · Expenses");
    expect(expense.textContent).toContain("$50.00");
    expect(expense.textContent).toContain("Owner: Robert");

    // Nothing else is claimed…
    expect(screen.queryByTestId("review-destination-profile")).toBeNull();
    expect(screen.queryByTestId("review-destination-document")).toBeNull();
    // …and the rows the user dropped are named as not saved.
    const notSaved = screen.getByTestId("review-not-saved").textContent || "";
    expect(notSaved).toContain("Merchant Name");
    expect(notSaved).toContain("Transaction Date");
  });

  it("lists the profile and document destinations when those are the ones selected", () => {
    renderPanel(receiptExtraction());
    fireEvent.click(continueButton());
    const profile = screen.getByTestId("review-destination-profile");
    expect(profile.textContent).toContain("Profile · Robert");
    expect(profile.textContent).toContain("Merchant Name: Corner Market");
    expect(screen.getByTestId("review-destination-document").textContent).toContain("Corner Market Receipt");
  });

  it("Back returns to the checklist with the selection intact", () => {
    renderPanel(receiptExtraction());
    deselectAll();
    fireEvent.click(screen.getByTestId("field-checkbox-totalAmount"));
    fireEvent.click(continueButton());
    fireEvent.click(screen.getByTestId("button-review-back"));
    expect(screen.queryByTestId("extraction-review")).toBeNull();
    expect(continueButton().disabled).toBe(false);
    // The one row the user kept is still the only one ticked.
    expect((screen.getByTestId("field-checkbox-totalAmount") as HTMLElement).getAttribute("data-state")).toBe("checked");
    expect((screen.getByTestId("field-checkbox-merchantName") as HTMLElement).getAttribute("data-state")).toBe("unchecked");
  });
});
