// @vitest-environment jsdom
//
// Ending a profile from the Info tab.
//
// The Info tab is where a person or a pet is created, renamed, re-typed and
// edited field by field — and it had no way to remove one. A profile added by
// mistake, or a pet no longer in the household, stayed forever: the delete
// existed on the liability and asset detail pages, which a person profile
// never reaches. So the button lives here now, and this test asserts the whole
// path — the warning that says what goes and what stays, the confirmation step
// (nothing this destructive fires on one click), the DELETE that leaves, and
// the self profile that has no button at all.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

type Call = { method: string; url: string; body: any };

const { apiRequest, calls, scope } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  calls: [] as Array<{ method: string; url: string; body: any }>,
  scope: { mode: "single" as string, selectedIds: ["bob-1"], selectedNames: ["Bob QA"], isFiltered: true },
}));

const PROFILE = {
  id: "bob-1",
  type: "person",
  name: "Bob QA",
  avatar: null,
  tags: [],
  notes: "",
  fields: { phone: "555-0100" },
  timeline: [],
  relatedJournal: [],
  relatedDocuments: [],
};

let selfMode = false;

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => scope }));
vi.mock("@/lib/cache-bus", () => ({
  invalidateDomain: vi.fn(async () => {}),
  invalidateDomains: vi.fn(async () => {}),
}));

import ProfileInfoPage from "../client/src/pages/profile-info";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const navigate = vi.fn();
  const hook = () => ["/profiles/bob-1/info", navigate] as [string, (to: string, opts?: any) => void];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook as any}>
        <ProfileInfoPage />
      </Router>
    </QueryClientProvider>,
  );
  return { navigate };
}

const wrote = (method: string, urlPart: string): Call | undefined =>
  calls.find(c => c.method === method && c.url.includes(urlPart));

beforeEach(() => {
  calls.length = 0;
  selfMode = false;
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (method === "GET" && url.startsWith("/api/profile-bootstrap/")) {
      const p = selfMode ? { ...PROFILE, type: "self" } : PROFILE;
      return json({ detail: p, profiles: [p] });
    }
    if (method === "GET" && url.startsWith("/api/notes")) return json([]);
    if (method === "GET" && url.startsWith("/api/memories")) return json([]);
    if (method === "GET" && url.startsWith("/api/profiles/")) return json(PROFILE);
    return json({ success: true });
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ready = () => waitFor(() => expect(screen.getByTestId("info-name")).toBeTruthy());

describe("Info tab · delete profile", () => {
  it("offers the delete, and says what goes and what stays", async () => {
    renderPage();
    await ready();
    const zone = screen.getByTestId("info-danger-zone");
    expect(zone.textContent).toContain("Bob QA");
    expect(zone.textContent).toMatch(/cannot be undone/i);
    // The cascade keeps co-owned rows — the copy has to say so, or "delete
    // Bob" reads as "delete the household's shared expenses" too.
    expect(zone.textContent).toMatch(/shared/i);
    expect(screen.getByTestId("info-delete-profile")).toBeTruthy();
  });

  it("does not delete on the first click — it asks first", async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByTestId("info-delete-profile"));
    await screen.findByTestId("info-delete-confirm");
    expect(wrote("DELETE", "/api/profiles/bob-1")).toBeUndefined();
  });

  it("deletes the profile once confirmed, and leaves the page", async () => {
    const { navigate } = renderPage();
    await ready();
    fireEvent.click(screen.getByTestId("info-delete-profile"));
    fireEvent.click(await screen.findByTestId("info-delete-confirm-button"));

    await waitFor(() => expect(wrote("DELETE", "/api/profiles/bob-1")).toBeTruthy());
    // Standing on the page of a profile that no longer exists renders
    // "Profile not found"; go back to the people list instead.
    await waitFor(() => expect(navigate.mock.calls.at(-1)?.[0]).toBe("/profiles"));
  });

  it("keeps the profile when the confirmation is declined", async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByTestId("info-delete-profile"));
    fireEvent.click(await screen.findByTestId("info-delete-cancel"));
    await waitFor(() => expect(screen.queryByTestId("info-delete-confirm")).toBeNull());
    expect(wrote("DELETE", "/api/profiles/bob-1")).toBeUndefined();
  });

  it("gives the self profile no delete at all — the app resolves 'me' by it", async () => {
    selfMode = true;
    renderPage();
    await ready();
    expect(screen.queryByTestId("info-danger-zone")).toBeNull();
    expect(screen.queryByTestId("info-delete-profile")).toBeNull();
  });
});
