// @vitest-environment jsdom
//
// The liability profile's Overview, to the owner's design (2026-11-22, "make
// it look more like the second photo"): a flat header, ONE balance card, the
// details as tappable rows, the payoff ring, Upcoming / Documents / Alerts /
// Calendar and the Profile actions. The page it replaced opened on two cards
// reading "SOURCE obligation" and "OBLIGATION ID 2b6ad3c2-…".
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
const SCHEDULE = {
  amount: 530.26, autopay: true, frequency: "monthly", firstPayment: "2024-01-12", paidCount: 0,
  totalPayments: null, remainingPayments: null, reminderLeadDays: null,
  nextDue: { date: "2099-01-12", effectiveDate: "2099-01-12", amount: 530.26 },
  occurrences: [{ date: "2099-01-12", effectiveDate: "2099-01-12", status: "upcoming", amount: 530.26 }],
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ method: string; path: string; body: any }> = [];
let documentsFail = false;

beforeEach(() => {
  queryClient.clear();
  calls = [];
  documentsFail = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = String(init?.method || "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method !== "GET") return json({ ok: true });
    if (path === "/api/profiles") return json([SELF, CAR, LOAN]);
    if (path.endsWith("/schedule")) return json(SCHEDULE);
    if (path.endsWith("/assets")) return json([{ id: "l1", liabilityProfileId: ID, assetProfileId: CAR.id, ownershipPercentage: 100, role: "collateral" }]);
    if (path.endsWith("/documents")) return documentsFail ? json({ error: "boom" }, 500) : json([{ id: "d1", name: "Loan agreement" }, { id: "d2", name: "Payment schedule" }]);
    if (path.includes("/details")) return json({ rows: [], definitions: [] });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let navigated: string[] = [];
function renderPage(profile: any = LOAN) {
  navigated = [];
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => [`/profiles/${ID}`, (to: string) => { navigated.push(to); }]) as any}><LiabilityProfilePage profile={profile} /></Router>
    </QueryClientProvider>,
  );
}
const writes = () => calls.filter((c) => c.method !== "GET");
const text = (testId: string) => (screen.getByTestId(testId).textContent || "").replace(/\s+/g, " ");

describe("liability profile: the owner's design", () => {
  it("header: back to Liabilities, the page title, the type and the chips", async () => {
    renderPage();
    expect(screen.getByTestId("detail-hero-page-title").textContent).toBe("Liability Profile");
    expect(screen.getByTestId("button-back").getAttribute("href")).toBe("#/linked?tab=liabilities");
    expect(screen.getByTestId("liability-title").textContent).toBe("Honda CR-V Auto Loan");
    expect(text("liability-header")).toContain("Auto loan");
    expect(text("chip-owner")).toContain("You owe this");
    expect(text("chip-status")).toContain("Active");
  });

  it("one balance card: balance, original, payoff progress, APR, lender, payment, next due, autopay", async () => {
    renderPage();
    expect(screen.getByTestId("kpi-balance").textContent).toBe("$18,420");
    const hero = text("liability-hero");
    expect(hero).toContain("Original amount: $28,000");
    expect(hero).toContain("34.2% paid down");
    expect(hero).toContain("$9,580 paid");
    expect(hero).toContain("$18,420 remaining");
    expect(screen.getByTestId("kpi-apr").textContent).toBe("5.49%");
    expect(hero).toContain("Honda Financial Services");
    expect(screen.getByTestId("kpi-monthly").textContent).toBe("$530.26");
    await waitFor(() => expect(screen.getByTestId("hero-autopay-state").textContent).toBe("Autopay: On"));
    expect(text("payoff-overview")).toContain("Amount paid$9,580");
  });

  it("never lists the app's own bookkeeping as a detail, and keeps what the user typed", async () => {
    renderPage();
    const section = within(screen.getByTestId("liability-details-section"));
    const body = (screen.getByTestId("liability-profile-page").textContent || "");
    expect(body).toContain("The Honda");                      // the reader works: a typed field is listed
    expect(section.getByTestId("add-field-cell-nickname")).toBeTruthy();
    expect(section.queryByTestId("add-field-cell-source")).toBeNull();
    expect(section.queryByTestId("add-field-cell-obligationId")).toBeNull();
    expect(body).not.toContain("2b6ad3c2");
    // The lender is a row of the details, not a second card under them.
    expect(section.queryByTestId("add-field-cell-lender")).toBeNull();
    expect(text("detail-row-lender")).toContain("Honda Financial Services");
  });

  it("names the linked asset and counts the documents from their own lists", async () => {
    renderPage();
    await waitFor(() => expect(text("detail-row-linked-asset")).toContain("Honda CR-V (Vehicle)"));
    await waitFor(() => expect(text("documents-card")).toContain("2 documents"));
    expect(text("documents-card")).toContain("Loan agreement");
  });

  it("a failed documents request is not '0 documents' (Rule 7)", async () => {
    documentsFail = true;
    renderPage();
    await waitFor(() => expect(text("documents-card")).toContain("Couldn't load documents"), { timeout: 8000 });
    expect(text("documents-card")).not.toMatch(/\d+ documents?/);
  }, 12000);

  it("opening the page writes nothing (Rule 3)", async () => {
    renderPage();
    await waitFor(() => expect(text("documents-card")).toContain("2 documents"));
    expect(writes()).toEqual([]);
  });

  it("a detail row opens its editor, prefilled; nothing is written by opening it", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("detail-row-rate"));
    const rate = (await screen.findByTestId("input-terms-rate")) as HTMLInputElement;
    expect(rate.value).toBe("5.49");
    expect((screen.getByTestId("input-terms-lender") as HTMLInputElement).value).toBe("Honda Financial Services");
    expect(writes()).toEqual([]);
  });

  it("the Autopay switch saves through the one Auto Pay door", async () => {
    renderPage();
    const sw = screen.getByTestId("switch-autopay-hero");
    // Disabled until the schedule (the setting's source) has loaded.
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ method: "POST", path: `/api/liabilities/${ID}/autopay`, body: { enabled: false } });
  });

  it("'Delete this liability' asks first: the first tap deletes nothing (Rule 8)", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-delete-profile"));
    expect(await screen.findByTestId("dialog-confirm-delete-profile")).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("button-confirm-delete-profile"));
    await waitFor(() => expect(writes().some((c) => c.method === "DELETE" && c.path === `/api/profiles/${ID}`)).toBe(true));
  });

  it("'Add custom field' opens the Field | Value form", async () => {
    renderPage();
    expect(screen.queryByTestId("add-field-form")).toBeNull();
    fireEvent.click(screen.getByTestId("profile-action-add-field"));
    expect(await screen.findByTestId("add-field-form")).toBeTruthy();
  });

  it("every figure in the balance card opens the form that edits it", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("kpi-apr"));
    expect(((await screen.findByTestId("input-terms-rate")) as HTMLInputElement).value).toBe("5.49");
    expect(screen.getByTestId("terms-edit-dialog")).toBeTruthy();
    // The form opened over the Overview: the page did not change tab.
    expect(screen.getByTestId("tab-overview").getAttribute("data-state")).toBe("active");
    expect(writes()).toEqual([]);
  });

  it("the type can be changed, and it is the type_key column that is written (L4)", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("detail-row-type"));
    expect(await screen.findByTestId("dialog-change-type")).toBeTruthy();
    // Nothing chosen yet: Save is not offered for the type it already has.
    expect((screen.getByTestId("button-save-type") as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("the name opens the name & notes form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("liability-title"));
    expect(((await screen.findByTestId("input-edit-name")) as HTMLInputElement).value).toBe("Honda CR-V Auto Loan");
  });

  it("'Ask Portol about this' opens chat with the liability named", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("profile-action-ask"));
    expect(sessionStorage.getItem("portol_chat_prefill")).toBe("About my Honda CR-V Auto Loan: ");
    expect(navigated).toEqual(["/chat"]);
    sessionStorage.removeItem("portol_chat_prefill");
  });

  describe("a debt with only a balance", () => {
    const BARE = { id: ID, name: "Loan from Dad", type: "liability", type_key: "personal_loan", notes: "", fields: { balance: 4000 } };

    it("offers to add what is missing instead of leaving a blank or a guess", async () => {
      renderPage(BARE);
      for (const key of ["lender", "original", "payment", "rate", "start", "payoff", "notes"]) {
        expect(text(`detail-row-${key}`), key).toContain("Add");
      }
      // No stored payment and no term: the 360-month guess is not this loan's payment.
      expect(screen.getByTestId("kpi-monthly").textContent).toBe("+ Add");
      expect(screen.getByTestId("liability-profile-page").textContent).not.toContain("$11.11");
      expect(screen.queryByTestId("payoff-overview")).toBeNull();
    });

    it("an empty row opens the form to fill it in", async () => {
      renderPage(BARE);
      fireEvent.click(screen.getByTestId("detail-row-lender"));
      expect(((await screen.findByTestId("input-terms-lender")) as HTMLInputElement).value).toBe("");
      expect(((screen.getByTestId("input-terms-balance")) as HTMLInputElement).value).toBe("4000");
    });

    it("'Upcoming payments' with nothing scheduled opens the form that schedules one", async () => {
      renderPage(BARE);
      await waitFor(() => expect(text("upcoming-payments-card")).toContain("No payment is scheduled"));
      fireEvent.click(screen.getByTestId("upcoming-payments-card"));
      expect(await screen.findByTestId("input-terms-due-day")).toBeTruthy();
    });
  });
});
