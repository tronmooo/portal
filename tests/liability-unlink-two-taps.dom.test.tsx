// @vitest-environment jsdom
//
// Rule 8 on the liability page's "Owners & linked records": unlinking an asset
// takes two taps. It went on the first tap (integrity run, 2026-11-27). The first tap arms ("Tap again"); only the second writes.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import { LiabilityProfilePage } from "../client/src/pages/liability-detail";
import { queryClient } from "../client/src/lib/queryClient";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELF = { id: "11111111-1111-4111-8111-111111111111", name: "Robert", type: "self", fields: {} };
const CAR = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Honda CR-V", type: "vehicle", fields: {} };
const LOAN = { id: ID, name: "Car Loan", type: "liability", type_key: "auto_loan", notes: "",
  fields: { balance: 9000, interestRate: 5, _interestRateUnit: "percent", monthlyPayment: 300, dueDay: 9 } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let writes: Array<{ method: string; path: string }> = [];

beforeEach(() => {
  queryClient.clear();
  writes = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = String(init?.method || "GET").toUpperCase();
    if (method !== "GET") { writes.push({ method, path }); return json({ ok: true }); }
    if (path === "/api/profiles") return json([SELF, CAR, LOAN]);
    if (path.endsWith("/assets")) return json([{ id: "al1", liabilityProfileId: ID, assetProfileId: CAR.id, ownershipPercentage: 100, role: "collateral" }]);
    if (path.endsWith("/parties")) return json([{ id: "pl1", liabilityProfileId: ID, partyProfileId: SELF.id, ownershipPercentage: 100, role: "owner" }]);
    if (path.endsWith("/schedule")) return json({ amount: 300, frequency: "monthly", occurrences: [], nextDue: null });
    if (path.includes("/details")) return json({ rows: [], definitions: [] });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openLinks() {
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => [`/profiles/${ID}`, () => {}]) as any}><LiabilityProfilePage profile={LOAN as any} /></Router>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByTestId("chip-owner"));
  await screen.findByTestId("dialog-links");
}

describe("Owners & linked records", () => {
  it("unlinking an asset takes two taps", async () => {
    await openLinks();
    const btn = await screen.findByTestId("asset-link-delete");
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 100));
    expect(writes.filter((w) => w.method === "DELETE")).toEqual([]);
    expect(btn.textContent).toMatch(/tap again/i);
    fireEvent.click(btn);
    await waitFor(() => expect(writes).toContainEqual({ method: "DELETE", path: "/api/liability-asset-links/al1" }));
  });
});
