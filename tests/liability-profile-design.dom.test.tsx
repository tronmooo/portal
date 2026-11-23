// @vitest-environment jsdom
//
// The liability profile, to the owner's design (2026-11-23, "let's make it
// look more like this"): one header card with the four headline figures, six
// tabs with the quick-add buttons, and an Overview that is the asset's (owner,
// later that day, with a picture of the Asset details list: "make the
// liabilities look exactly like this"): ONE Liability details list (label,
// value, pencil) holding the characteristics, then Balance & Payoff, then the
// AI Summary. The page it replaced opened on two cards reading
// "SOURCE obligation" and "OBLIGATION ID 2b6ad3c2-…".
//
// Renders the real page over stubbed requests, so what is asserted is what
// the user sees and what a tap sends.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import { LiabilityProfilePage } from "../client/src/pages/liability-detail";
import { queryClient } from "../client/src/lib/queryClient";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELF = { id: "11111111-1111-4111-8111-111111111111", name: "Robert", type: "self", fields: {} };
const CAR = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Honda CR-V", type: "vehicle", fields: {} };
const LOAN = {
  id: ID, name: "Honda CR-V Auto Loan", type: "liability", type_key: "auto_loan", notes: "",
  fields: {
    balance: 18420, originalBalance: 28000, interestRate: 5.49, _interestRateUnit: "percent",
    monthlyPayment: 530.26, dueDay: 12, firstPaymentDate: "2024-01-12", lender: "Honda Financial Services",
    autopay: true, source: "obligation", obligationId: "2b6ad3c2-64ed-4ea2-a111-222222222222", nickname: "The Honda",
  },
};
const BARE = { id: ID, name: "Loan from Dad", type: "liability", type_key: "personal_loan", notes: "", fields: { balance: 4000 } };
const BILL = {
  id: ID, name: "Netflix", type: "liability", type_key: "subscription", notes: "Family plan",
  fields: { amount: 22.99, monthlyAmount: 22.99, frequency: "monthly", dueDate: "2099-01-25", nextDueDate: "2099-01-25", firstPaymentDate: "2025-03-25" },
};
const LOAN_SCHEDULE = {
  amount: 530.26, autopay: true, frequency: "monthly", firstPayment: "2024-01-12", paidCount: 0,
  totalPayments: null, remainingPayments: null, reminderLeadDays: null,
  nextDue: { date: "2099-01-12", effectiveDate: "2099-01-12", amount: 530.26 },
  occurrences: [{ date: "2099-01-12", effectiveDate: "2099-01-12", status: "upcoming", amount: 530.26 }],
};
const BILL_SCHEDULE = {
  amount: 22.99, autopay: false, frequency: "monthly", firstPayment: "2025-03-25", annualTotal: 275.88, paidCount: 3,
  totalPayments: null, remainingPayments: null, reminderLeadDays: 3,
  nextDue: { date: "2099-01-25", effectiveDate: "2099-01-25", amount: 22.99 },
  occurrences: [{ date: "2099-01-25", effectiveDate: "2099-01-25", status: "upcoming", amount: 22.99 }],
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ method: string; path: string; body: any }> = [];
let assetsFail = false;
let current: any = LOAN;

beforeEach(() => {
  queryClient.clear();
  calls = [];
  assetsFail = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = String(init?.method || "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method !== "GET") return json({ ok: true, id: "new-1" });
    if (path === "/api/profiles") return json([SELF, CAR, current]);
    if (path.endsWith("/schedule")) return json(current === BILL ? BILL_SCHEDULE : LOAN_SCHEDULE);
    if (path.endsWith("/assets")) return assetsFail ? json({ error: "boom" }, 500) : json(current === LOAN ? [{ id: "l1", liabilityProfileId: ID, assetProfileId: CAR.id, ownershipPercentage: 100, role: "collateral" }] : []);
    if (path.includes("/details")) return json({ rows: [], definitions: [] });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let navigated: string[] = [];
function renderPage(profile: any = LOAN) {
  current = profile;
  navigated = [];
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => [`/profiles/${ID}`, (to: string) => { navigated.push(to); }]) as any}><LiabilityProfilePage profile={profile} /></Router>
    </QueryClientProvider>,
  );
}
const writes = () => calls.filter((c) => c.method !== "GET");
const text = (testId: string) => (screen.getByTestId(testId).textContent || "").replace(/\s+/g, " ").trim();
const value = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;

describe("liability profile: the header card", () => {
  it("names the page, the debt, its type, lender and owner, with a way back", () => {
    renderPage();
    expect(screen.getByTestId("detail-hero-page-title").textContent).toBe("Liability Profile");
    expect(screen.getByTestId("button-back").getAttribute("href")).toBe("#/linked?tab=liabilities");
    expect(screen.getByTestId("liability-title").textContent).toBe("Honda CR-V Auto Loan");
    expect(text("chip-type")).toContain("Auto loan");
    expect(text("chip-lender")).toContain("Honda Financial Services");
    expect(text("chip-owner")).toContain("You owe this");
  });

  it("carries the four headline figures: Balance, Payment, APR, Payoff", () => {
    renderPage();
    expect(text("detail-hero-figures")).toMatch(/Balance.*Payment.*APR.*Payoff/);
    expect(screen.getByTestId("kpi-balance").textContent).toBe("$18,420");
    expect(screen.getByTestId("kpi-monthly").textContent).toBe("$530.26/mo");
    expect(screen.getByTestId("kpi-apr").textContent).toBe("5.49%");
    // A month and a year, from the page's one amortization.
    expect(screen.getByTestId("kpi-payoff").textContent).toMatch(/^[A-Z][a-z]{2} 20\d\d$/);
  });

  it("has the six tabs and the quick-add buttons", () => {
    renderPage();
    for (const t of ["overview", "payments", "schedule", "cost", "documents", "history"]) expect(screen.getByTestId(`tab-${t}`)).toBeTruthy();
    expect(screen.getByTestId("tab-cost").textContent).toBe("Cost of Ownership");
    expect(text("liability-quick-add")).toMatch(/Payment.*Expense.*Task.*More/);
  });
});

describe("liability profile: the Overview", () => {
  it("Liability Details reads the stored record, field by field", () => {
    renderPage();
    expect(text("detail-name")).toBe("Honda CR-V Auto Loan");
    expect(text("detail-lender")).toBe("Honda Financial Services");
    expect(text("detail-original")).toBe("$28,000");
    expect(text("detail-balance")).toBe("$18,420");
    expect(text("detail-rate")).toBe("5.49%");
    expect(text("detail-payment")).toBe("$530.26");
    expect(text("detail-due-day")).toBe("12th");
    expect(text("detail-start")).toBe("Jan 12, 2024");
    expect(text("detail-payoff")).toMatch(/20\d\d$/);
  });

  it("the Overview is one details list, then Balance & Payoff; no Edit button, no Quick Info or Characteristics card", () => {
    renderPage();
    const list = screen.getByTestId("liability-details-card");
    const payoff = screen.getByTestId("balance-payoff-card");
    expect(!!(list.compareDocumentPosition(payoff) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(list.querySelector("h2")?.textContent).toBe("Liability details");
    // The characteristic and the notes are lines of the same list.
    expect(within(list).getByTestId("add-field-cell-nickname")).toBeTruthy();
    expect(within(list).getByTestId("detail-notes")).toBeTruthy();
    expect(within(list).getByTestId("add-field-button").textContent).toContain("Add characteristic");
    for (const gone of ["button-edit-terms", "quick-info-card", "characteristics-card"]) expect(screen.queryByTestId(gone), gone).toBeNull();
  });

  it("a characteristic is changed from its line and removed with two taps (Rule 8)", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("add-field-cell-nickname"));
    expect(value("add-field-edit-nickname")).toBe("The Honda");
    fireEvent.click(screen.getByTestId("add-field-remove-nickname"));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("add-field-remove-nickname"));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0].body).toEqual({ fieldsToDelete: ["nickname"] });
  });

  it("Balance & Payoff figures are worked out from the same terms", () => {
    renderPage();
    expect(text("quick-remaining-term")).toMatch(/^\d+ months$/);
    expect(text("quick-interest")).toMatch(/^\$[\d,]+$/);
    expect(text("balance-payoff-card")).toContain("Current Balance$18,420");
    expect(text("paid-down")).toBe("$9,580 · 34.2%");
    expect(screen.getByTestId("payoff-line")).toBeTruthy();
    expect(text("payoff-est")).toBe(text("detail-payoff"));
  });

  it("the list holds what the user added, never the app's own bookkeeping", async () => {
    renderPage();
    const card = within(screen.getByTestId("liability-details-card"));
    expect(card.getByTestId("add-field-cell-nickname").textContent).toContain("The Honda");   // the reader works
    expect(card.queryByTestId("add-field-cell-source")).toBeNull();
    expect(card.queryByTestId("add-field-cell-obligationId")).toBeNull();
    expect(card.queryByTestId("add-field-cell-lender")).toBeNull();                          // a field of the form, not a second line
    expect(screen.getByTestId("liability-profile-page").textContent).not.toContain("2b6ad3c2");
    await waitFor(() => expect(text("detail-row-linked-asset")).toContain("Honda CR-V"));
  });

  it("a failed linked-asset request is not 'none linked' (Rule 7)", async () => {
    assetsFail = true;
    renderPage();
    await waitFor(() => expect(text("detail-row-linked-asset")).toContain("Couldn't load"), { timeout: 8000 });
    expect(screen.queryByTestId("link-asset-add")).toBeNull();
  }, 12000);

  it("opening the page writes nothing (Rule 3)", async () => {
    renderPage();
    await waitFor(() => expect(text("detail-row-linked-asset")).toContain("Honda CR-V"));
    expect(writes()).toEqual([]);
  });
});

describe("liability profile: everything edits in place", () => {
  it("Edit turns the card into inputs holding the stored values, and writes nothing by itself", () => {
    renderPage();
    expect(screen.queryByTestId("input-terms-rate")).toBeNull();
    expect(screen.queryByTestId("button-save-terms")).toBeNull();   // Save and Undo exist only while editing
    fireEvent.click(screen.getByTestId("detail-name"));
    expect(value("input-edit-name")).toBe("Honda CR-V Auto Loan");
    expect(value("input-terms-lender")).toBe("Honda Financial Services");
    expect(value("input-terms-rate")).toBe("5.49");
    expect(value("input-terms-balance")).toBe("18420");
    expect(value("input-terms-due-day")).toBe("12");
    expect(writes()).toEqual([]);
  });

  it("a header figure, a value, or the name starts the same edit", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("kpi-apr"));
    expect(value("input-terms-rate")).toBe("5.49");
    cleanup();
    renderPage();
    fireEvent.click(screen.getByTestId("detail-balance"));
    expect(value("input-terms-balance")).toBe("18420");
    cleanup();
    renderPage();
    fireEvent.click(screen.getByTestId("liability-title"));
    expect(value("input-edit-name")).toBe("Honda CR-V Auto Loan");
  });

  it("the name and notes are written once, and Save closes the form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("detail-balance"));
    const notes = screen.getByTestId("input-edit-notes");
    fireEvent.change(notes, { target: { value: "CR-V loan through the dealer." } });
    fireEvent.blur(notes);                                    // leaving the box…
    fireEvent.click(screen.getByTestId("button-save-terms")); // …and pressing Save
    await waitFor(() => expect(screen.queryByTestId("input-edit-notes")).toBeNull());
    expect(writes()).toEqual([{ method: "PATCH", path: `/api/profiles/${ID}`, body: { notes: "CR-V loan through the dealer." } }]);
  });

  it("a changed term saves itself, under its own field only (L7)", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("detail-balance"));
    fireEvent.change(screen.getByTestId("input-terms-rate"), { target: { value: "4.9" } });
    await waitFor(() => expect(writes().length).toBe(1), { timeout: 5000 });
    // Only what changed: the rate, as the percent that was typed (L3).
    expect(writes()[0].body).toEqual({ fields: { interestRate: 4.9 } });
    await waitFor(() => expect(text("terms-autosave-status")).toBe("Saved"));
  });

  it("the Autopay switch saves through the one Auto Pay door", async () => {
    renderPage();
    const sw = screen.getByTestId("switch-autopay-hero") as HTMLButtonElement;
    await waitFor(() => expect(sw.disabled).toBe(false));     // disabled until the schedule has loaded
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ method: "POST", path: `/api/liabilities/${ID}/autopay`, body: { enabled: false } });
  });

  it("'Add Characteristic' opens the Field | Value form", async () => {
    renderPage();
    expect(screen.queryByTestId("add-field-form")).toBeNull();
    fireEvent.click(screen.getByTestId("add-field-button"));
    expect(await screen.findByTestId("add-field-form")).toBeTruthy();
  });
});

describe("liability profile: adding from the action row", () => {
  it("+ Expense files a cost under this liability", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-add-expense"));
    await screen.findByTestId("dialog-liability-expense");
    expect((screen.getByTestId("button-save-liability-expense") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-liability-expense-desc"), { target: { value: "Late fee" } });
    fireEvent.change(screen.getByTestId("input-liability-expense-amount"), { target: { value: "25" } });
    fireEvent.change(screen.getByTestId("input-liability-expense-date"), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByTestId("button-save-liability-expense"));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ method: "POST", path: "/api/expenses", body: { description: "Late fee", amount: 25, date: "2026-11-20", category: "other", linkedProfiles: [ID] } });
  });

  it("+ Task creates the task and links it to this liability", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-add-task"));
    await screen.findByTestId("dialog-liability-task");
    fireEvent.change(screen.getByTestId("input-liability-task-title"), { target: { value: "Call about refinancing" } });
    fireEvent.click(screen.getByTestId("button-save-liability-task"));
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[0]).toEqual({ method: "POST", path: "/api/tasks", body: { title: "Call about refinancing", priority: "medium" } });
    expect(writes()[1]).toEqual({ method: "POST", path: `/api/profiles/${ID}/link`, body: { entityType: "task", entityId: "new-1" } });
  });

  it("+ Payment opens the payment dialog with the stored payment", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("quick-pay-min"));
    expect(((await screen.findByTestId("payment-amount-input")) as HTMLInputElement).value).toBe("530.26");
    expect(writes()).toEqual([]);
  });
});

describe("a debt with only a balance", () => {
  it("offers to add what is missing instead of a blank or a guess", () => {
    renderPage(BARE);
    for (const id of ["detail-lender", "detail-original", "detail-rate", "detail-term", "detail-payment", "detail-due-day", "detail-start", "detail-payoff", "detail-notes"]) {
      expect(text(id), id).toBe("Not set");
    }
    // No stored payment and no term: the 360-month guess is not this loan's payment.
    expect(screen.getByTestId("kpi-monthly").textContent).toBe("+ Add");
    expect(screen.getByTestId("liability-profile-page").textContent).not.toContain("$11.11");
    expect(screen.queryByTestId("payoff-line")).toBeNull();
    expect(text("payoff-line-missing")).toContain("to see the balance fall to zero");
  });

  it("an empty value opens the form to fill it in", () => {
    renderPage(BARE);
    fireEvent.click(screen.getByTestId("detail-lender"));
    expect(value("input-terms-lender")).toBe("");
    expect(value("input-terms-balance")).toBe("4000");
  });
});

describe("a recurring bill", () => {
  it("shows amount, next date, frequency and status, never APR or payoff", async () => {
    renderPage(BILL);
    await waitFor(() => expect(text("detail-reminder")).toBe("3 days before"));   // the schedule has loaded
    expect(screen.getByTestId("kpi-bill-monthly").textContent).toBe("$22.99");
    expect(text("detail-hero-figures")).toMatch(/Amount.*Next due.*Frequency.*Status/);
    expect(screen.queryByTestId("kpi-apr")).toBeNull();
    expect(screen.queryByTestId("balance-payoff-card")).toBeNull();
    expect(text("detail-frequency")).toBe("Monthly");
    expect(text("detail-reminder")).toBe("3 days before");
    expect(text("detail-notes")).toBe("Family plan");
    expect(text("next-payment-card")).toContain("Monthly (on the 25th)");
  });

  it("Edit opens the bill's own fields", async () => {
    renderPage(BILL);
    await waitFor(() => expect(text("detail-reminder")).toBe("3 days before"));
    fireEvent.click(screen.getByTestId("detail-amount"));
    expect(value("input-bill-amount")).toBe("22.99");
    expect(value("input-bill-reminder")).toBe("3");
    expect(screen.getByTestId("bill-details-edit-card")).toBeTruthy();
    expect(writes()).toEqual([]);
  });
});
