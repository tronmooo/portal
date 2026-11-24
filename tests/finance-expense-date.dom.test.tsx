// @vitest-environment jsdom
//
// QA 2026-11-24 (Finance tab, bug 9): an expense added with its date set to
// October 20 was saved as November 24 (today), and editing its date then said
// "updated" while the row still read November 24.
//
// Two ways the form lost the chosen day, both fixed here and both driven
// through the real Finance page:
//
//  · EDIT — the dialog re-seeded its whole form from the stored row whenever
//    the account list behind the "Paid from" picker changed identity (any
//    refetch of /api/profiles that brought different data). A date typed into
//    the open dialog was replaced by the stored date before Save, the PATCH
//    carried no date, and the toast said "updated" anyway.
//  · ADD / EDIT — a date input that is half typed reports "" (Rule 6, "A date
//    is saved whole or not at all"). Add read "" as "no date" and filed the
//    expense TODAY; Edit read it as "unchanged" and saved nothing, both with a
//    success toast. A half-typed date is now refused with a message.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import FinancePage from "../client/src/pages/finance";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";
import { localTodayISO } from "../client/src/lib/dates";

const SELF = "11111111-1111-4111-8111-111111111111";
const CHECKING = "33333333-3333-4333-8333-333333333333";
const base = { tags: [], notes: "", documents: [], createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", linkedProfiles: [], parentProfileId: null };
const SELF_PROFILE = { ...base, id: SELF, name: "Bob Robertson", type: "self", fields: {} };
const checking = (balance: number) => ({ ...base, id: CHECKING, name: "Chase Checking", type: "account", fields: { balance, accountType: "checking" } });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

let profiles: any[] = [];
let expenses: any[] = [];
let writes: Array<{ method: string; url: string; body: any }> = [];

beforeEach(() => {
  // recharts' ResponsiveContainer (the page's charts) needs one; jsdom has none.
  (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  queryClient.clear();
  setFilterEveryone();
  writes = [];
  profiles = [SELF_PROFILE, checking(1000)];
  expenses = [{
    id: "exp-1", description: "Lunch at Panera", amount: 14, category: "food", tags: [],
    linkedProfiles: [SELF], date: localTodayISO(), createdAt: new Date().toISOString(),
  }];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = String(init.method || "GET").toUpperCase();
    const p = url.split("?")[0];
    if (method !== "GET") {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ method, url: p, body });
      if (method === "POST" && p === "/api/expenses") {
        const row = { id: "exp-new", tags: [], linkedProfiles: [SELF], createdAt: new Date().toISOString(), ...body, date: body?.date || localTodayISO() };
        expenses = [row, ...expenses];
        return json(row, 201);
      }
      const m = p.match(/^\/api\/expenses\/([^/]+)$/);
      if (method === "PATCH" && m) {
        const row = expenses.find((e) => e.id === m[1]);
        Object.assign(row, body);
        return json(row);
      }
      return json({});
    }
    if (p === "/api/profiles" || p === "/api/profiles/lite") return json(profiles);
    if (p === "/api/expenses") return json(expenses);
    if (p === "/api/dashboard-enhanced" || p === "/api/stats") return json({});
    if (p === "/api/assets/lifecycle") return json({ rows: [], computedAt: new Date().toISOString() });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setFilterEveryone(); });

function renderFinance() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => ["/finance", () => {}]) as any}><FinancePage /></Router>
    </QueryClientProvider>,
  );
}

/** The edit dialog's date input (the only date input in an open Edit Expense). */
async function openEditDialog() {
  const row = await screen.findByTestId("expense-exp-1");
  fireEvent.click(row.querySelector("button, [role=button]") || row);
  fireEvent.click(await screen.findByTestId("btn-edit-expense-exp-1"));
  const input = await screen.findByTestId("input-edit-expense-date");
  return input as HTMLInputElement;
}

/** Make an input report "" with badInput, the way a half-typed native date does. */
function halfTyped(input: HTMLInputElement) {
  Object.defineProperty(input, "validity", { configurable: true, get: () => ({ badInput: true, valid: false }) });
  fireEvent.change(input, { target: { value: "" } });
}

describe("Finance: an expense keeps the date the user chose", () => {
  it("edit: a profile refetch while the dialog is open does not put the stored date back", async () => {
    renderFinance();
    const input = await openEditDialog();
    fireEvent.change(input, { target: { value: "2026-10-20" } });
    expect(input.value).toBe("2026-10-20");

    // The account list changes identity under the open dialog (a balance moved
    // elsewhere; a refetch on window focus after the date picker closed).
    profiles = [SELF_PROFILE, checking(987.65)];
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["/api/profiles"] }); });
    await waitFor(() => {
      const cached: any[] = queryClient.getQueryData(["/api/profiles"]) || [];
      expect(cached.find((x) => x.id === CHECKING)?.fields?.balance).toBe(987.65);
    });

    expect((screen.getByTestId("input-edit-expense-date") as HTMLInputElement).value).toBe("2026-10-20");
    fireEvent.click(screen.getByTestId("btn-save-edit-expense"));
    await waitFor(() => expect(writes.some((w) => w.method === "PATCH")).toBe(true));
    const patch = writes.find((w) => w.method === "PATCH")!;
    expect(patch.url).toBe("/api/expenses/exp-1");
    expect(patch.body.date).toBe("2026-10-20");
  });

  it("edit: a half-typed date is refused, never saved as 'unchanged' with an 'updated' toast", async () => {
    renderFinance();
    const input = await openEditDialog();
    halfTyped(input);
    fireEvent.click(screen.getByTestId("btn-save-edit-expense"));
    expect(await screen.findByTestId("edit-expense-date-error")).toBeTruthy();
    expect(writes.filter((w) => w.method === "PATCH")).toHaveLength(0);
    // The dialog stays open with the user's work.
    expect(screen.getByTestId("input-edit-expense-date")).toBeTruthy();
  });

  it("add: the chosen day is the day sent", async () => {
    renderFinance();
    fireEvent.click(await screen.findByTestId("button-add-expense"));
    fireEvent.change(await screen.findByTestId("input-expense-description"), { target: { value: "Haircut" } });
    fireEvent.change(screen.getByTestId("input-expense-amount"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("input-expense-date"), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByTestId("button-save-expense"));
    await waitFor(() => expect(writes.some((w) => w.method === "POST" && w.url === "/api/expenses")).toBe(true));
    expect(writes.find((w) => w.url === "/api/expenses")!.body.date).toBe("2026-10-20");
  });

  it("add: a half-typed date is refused, never filed as today", async () => {
    renderFinance();
    fireEvent.click(await screen.findByTestId("button-add-expense"));
    fireEvent.change(await screen.findByTestId("input-expense-description"), { target: { value: "Haircut" } });
    fireEvent.change(screen.getByTestId("input-expense-amount"), { target: { value: "30" } });
    halfTyped(screen.getByTestId("input-expense-date") as HTMLInputElement);
    fireEvent.click(screen.getByTestId("button-save-expense"));
    expect(await screen.findByTestId("expense-date-error")).toBeTruthy();
    expect(writes.filter((w) => w.method === "POST" && w.url === "/api/expenses")).toHaveLength(0);
  });
});
