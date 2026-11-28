// @vitest-environment jsdom
//
// One press, one asset (integrity run 2026-11-27, ui-profiles.asset-create):
// on the Contained tab a double click on "Create" stored the child asset
// TWICE — the button's `disabled={isPending}` only takes effect on the render
// after TanStack publishes the mutation's state, so the second click of a
// double click (or the second tap of a double tap) sent a second POST.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

const h = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }), apiRequest: h.apiRequest, BROWSER_TIMEZONE: "UTC", getQueryFn: () => async () => null };
});

import { queryClient } from "@/lib/queryClient";
import { ChildAssetsCard } from "@/pages/profile-detail";

const PIANO: any = { id: "piano-1", type: "asset", name: "Piano", fields: { currentValue: 3000 }, childProfiles: [], tags: [], notes: "" };
const res = (body: any) => Promise.resolve({ ok: true, json: async () => body } as any);

beforeEach(() => {
  h.apiRequest.mockReset();
  h.apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "POST") return new Promise((r) => setTimeout(() => r({ ok: true, json: async () => ({ id: "bench-1", name: "Bench" }) }), 30));
    if (url.includes("/tree")) return res({ id: "piano-1", children: [] });
    return res([]);
  });
});
afterEach(() => { cleanup(); queryClient.clear(); });

describe("Contained tab: Add child asset", () => {
  it("a double click on Create sends ONE create", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Router><ChildAssetsCard profile={PIANO} onChildAdded={() => {}} /></Router>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-add-child-asset"));
    fireEvent.change(await screen.findByTestId("input-child-asset-name"), { target: { value: "Bench" } });
    fireEvent.change(screen.getByTestId("input-child-asset-value"), { target: { value: "250" } });
    const create = screen.getByTestId("button-confirm-add-child-asset");
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.keyDown(screen.getByTestId("input-child-asset-value"), { key: "Enter" });
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    const posts = h.apiRequest.mock.calls.filter((c) => c[0] === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][2]).toMatchObject({ name: "Bench", parentProfileId: "piano-1", fields: { currentValue: 250 } });
  });
});
