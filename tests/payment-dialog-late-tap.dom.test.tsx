// @vitest-environment jsdom
//
// A second tap on "Record payment" that lands after the first payment was
// recorded — the dialog still on screen while it closes — is the same payment,
// never a second one (I10; integrity run 2026-11-27: two taps 300 ms apart on
// a phone stored two ledger rows, because the key was renewed on success).
// The key is minted when the dialog OPENS; a closing dialog submits nothing.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { readFileSync } from "node:fs";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import { LiabilityProfilePage } from "../client/src/pages/liability-detail";
import { queryClient } from "../client/src/lib/queryClient";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOAN = {
  id: ID, name: "Test Auto Loan", type: "liability", type_key: "auto_loan", notes: "",
  fields: { balance: 10000, interestRate: 6, _interestRateUnit: "percent", monthlyPayment: 400, dueDay: 12, lender: "Bank" },
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let posts: any[] = [];
const realGCS = window.getComputedStyle;

beforeEach(() => {
  queryClient.clear();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "POST" && path.endsWith("/payments")) { posts.push(JSON.parse(init.body)); return json({ payment: { id: `p${posts.length}` } }); }
    if (method !== "GET") return json({ ok: true });
    if (path === "/api/profiles") return json([LOAN]);
    if (path.endsWith("/schedule")) return json({ amount: 400, frequency: "monthly", occurrences: [], nextDue: null });
    if (path.includes("/details")) return json({ rows: [], definitions: [] });
    return json([]);
  }));
  // A closing dialog stays on screen while its exit animation runs (as in a
  // browser): Radix keeps it mounted until "animationend", which jsdom never fires.
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    const st = realGCS.call(window, el, pseudo as any);
    if ((el as HTMLElement).getAttribute?.("data-testid") === "payment-dialog") {
      return new Proxy(st, { get: (t, k) => (k === "animationName" ? (el.getAttribute("data-state") === "closed" ? "exit" : "enter") : (t as any)[k]) }) as any;
    }
    return st;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => [`/profiles/${ID}`, () => {}]) as any}><LiabilityProfilePage profile={LOAN as any} /></Router>
    </QueryClientProvider>,
  );
}

describe("the payment dialog", () => {
  it("a tap on the closing dialog after the payment was recorded records nothing more", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByTestId("tab-payments"), { button: 0 });
    fireEvent.click(await screen.findByTestId("action-custom"));
    fireEvent.change(await screen.findByTestId("payment-amount-input"), { target: { value: "450" } });
    const submit = screen.getByTestId("payment-submit");
    fireEvent.click(submit);
    await waitFor(() => expect(posts.length).toBe(1));
    // the dialog has answered and is closing; the button is still there
    await waitFor(() => expect(screen.getByTestId("payment-dialog").getAttribute("data-state")).toBe("closed"));
    expect(submit.isConnected).toBe(true);
    fireEvent.click(submit);
    await new Promise((r) => setTimeout(r, 800));
    // either no second request, or the same key (the same payment)
    expect(posts.length === 1 || posts[1].idempotencyKey === posts[0].idempotencyKey).toBe(true);
  });

  it("each opening is a new payment with its own key", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByTestId("tab-payments"), { button: 0 });
    for (const amount of ["100", "100"]) {
      fireEvent.click(await screen.findByTestId("action-custom"));
      await waitFor(() => expect(screen.getByTestId("payment-dialog").getAttribute("data-state")).toBe("open"));
      fireEvent.change(screen.getByTestId("payment-amount-input"), { target: { value: amount } });
      fireEvent.click(screen.getByTestId("payment-submit"));
      await waitFor(() => expect(posts.length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByTestId("payment-dialog").getAttribute("data-state")).toBe("closed"));
    }
    expect(posts.length).toBe(2);
    expect(posts[0].idempotencyKey).toBeTruthy();
    expect(posts[1].idempotencyKey).not.toBe(posts[0].idempotencyKey);
  });

  // jsdom does not deliver a click to a closing Radix dialog the way a phone
  // does, so the cause is also pinned in the source: the key is minted when the
  // dialog opens (never renewed on success), and a closed dialog submits nothing.
  it("mints the key on opening, not on success, and a closed dialog submits nothing", () => {
    const src = readFileSync(`${process.cwd()}/client/src/pages/liability-detail.tsx`, "utf8");
    const open = src.slice(src.indexOf("function openPaymentDialog"), src.indexOf("setPaymentDialog({", src.indexOf("function openPaymentDialog")));
    expect(open).toContain("paymentKeyRef.current = newPaymentKey()");
    const mut = src.slice(src.indexOf("const recordPaymentMutation"), src.indexOf("function submitPayment"));
    const onSuccess = mut.slice(mut.indexOf("onSuccess"), mut.indexOf("onError"));
    expect(onSuccess).not.toContain("newPaymentKey");
    const submit = src.slice(src.indexOf("function submitPayment"), src.indexOf("recordPaymentMutation.mutate(", src.indexOf("function submitPayment")));
    expect(submit).toMatch(/if \(!paymentDialog\.open\) return;/);
  });
});
