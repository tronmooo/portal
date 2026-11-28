// @vitest-environment jsdom
//
// One press, one ownership write (integrity run 2026-11-27,
// ui-profiles.asset-ownership): a double click on "Save ownership" sent two
// PUT /api/profiles/:id/owners at once. The server answered the first 200 and
// the second 400 (duplicate key), and the second's rollback put the OLD owner
// set back — the split the user saved was gone. The button's
// `disabled={isPending}` arrives a render too late to stop the second click.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

// Radix's Slider measures itself; jsdom has no ResizeObserver.
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const h = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }), apiRequest: h.apiRequest, BROWSER_TIMEZONE: "UTC", getQueryFn: () => async () => null };
});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}), invalidateDomains: vi.fn(async () => {}) }));

import { queryClient } from "@/lib/queryClient";
import { OwnershipEditor } from "@/components/OwnershipEditor";

const SELF = { id: "11111111-1111-4111-8111-111111111111", name: "Me", type: "self" };
const SAM = { id: "22222222-2222-4222-8222-222222222222", name: "Sam", type: "person" };
const BOAT = { id: "33333333-3333-4333-8333-333333333333", name: "Boat", type: "asset" };
const res = (body: any) => Promise.resolve({ ok: true, json: async () => body } as any);

beforeEach(() => {
  h.apiRequest.mockReset();
  h.apiRequest.mockImplementation((method: string) => {
    if (method === "PUT") return new Promise((r) => setTimeout(() => r({ ok: true, json: async () => ({ owners: [] }) }), 30));
    return res([{ assetProfileId: BOAT.id, partyProfileId: SELF.id, ownershipPercentage: 100, role: "owner" }]);
  });
});
afterEach(() => { cleanup(); queryClient.clear(); });

describe("OwnershipEditor", () => {
  it("a double click on Save ownership sends ONE write", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <OwnershipEditor profile={BOAT} allProfiles={[SELF, SAM, BOAT]} />
      </QueryClientProvider>,
    );
    await screen.findByTestId(`owner-row-${SELF.id}`);
    fireEvent.change(screen.getByTestId("owner-add-select"), { target: { value: SAM.id } });
    fireEvent.change(screen.getByTestId(`owner-input-${SELF.id}`), { target: { value: "60" } });
    fireEvent.change(screen.getByTestId(`owner-input-${SAM.id}`), { target: { value: "40" } });
    const save = screen.getByTestId("owner-save");
    fireEvent.click(save);
    fireEvent.click(save);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    const puts = h.apiRequest.mock.calls.filter((c) => c[0] === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0][2]).toEqual({ owners: [{ partyProfileId: SELF.id, ownershipPercentage: 60 }, { partyProfileId: SAM.id, ownershipPercentage: 40 }] });
  });
});
