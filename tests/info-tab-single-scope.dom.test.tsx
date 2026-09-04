// @vitest-environment jsdom
//
// Reported 2026-09-04, with a screenshot: the switcher in the hub header reads
// "Bob Robertson", every other tab shows Bob's data — and the Info tab shows a
// list headed "Selected people · 1 person · tap anyone to open their info"
// containing exactly one card: Bob. "Why would it show the info screen as Bob
// Robertson? It should show his info. He's already selected."
//
// Cause: /profiles renders the combined view, and reconcileInfoRoute
// deliberately never redirects /profiles (that fixpoint is what fixed the
// 2026-08-05 white-screen redirect loop). So any way of reaching /profiles that
// is not the Info chip — the People stat card, "Go to Profiles", a back link,
// the switcher's own "Everyone" entry followed by picking one person — left the
// user on a one-card list they had to tap to get anywhere.
//
// Fix: /profiles RENDERS that person's Info when the scope is exactly one
// person. Rendering, never navigating — these tests assert both halves, because
// solving it with a redirect is what crashed the app last time.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

const { apiRequest, scope } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  scope: { mode: "everyone" as string, selectedIds: [] as string[], selectedNames: [] as string[], isFiltered: false },
}));

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
import { queryClient as mockedQueryClient } from "@/lib/queryClient";

const BOB = {
  id: "bob-1", type: "person", name: "Bob Robertson", avatar: null, tags: [],
  fields: { phone: "555-0100" },
  timeline: [], relatedJournal: [], relatedDocuments: [],
};
const JANE = { id: "jane-1", type: "person", name: "Jane Doe", fields: {}, tags: [] };
const PEOPLE = [BOB, JANE];

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderAt(path: string) {
  const navigate = vi.fn();
  const hook = () => [path, navigate] as [string, (to: string, opts?: any) => void];
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

const selectOnly = (id: string, name: string) => {
  scope.mode = "selected";
  scope.selectedIds = [id];
  scope.selectedNames = [name];
  scope.isFiltered = true;
};

beforeEach(() => {
  (Element.prototype as any).hasPointerCapture ??= () => false;
  (Element.prototype as any).scrollIntoView ??= () => {};
  scope.mode = "everyone";
  scope.selectedIds = [];
  scope.selectedNames = [];
  scope.isFiltered = false;
  apiRequest.mockImplementation(async (method: string, url: string) => {
    if (method === "GET" && url.startsWith("/api/profile-bootstrap/bob-1")) {
      return json({ detail: BOB, profiles: PEOPLE });
    }
    if (method === "GET" && url.startsWith("/api/profiles/lite")) return json(PEOPLE);
    if (method === "GET" && url.startsWith("/api/memories")) return json([]);
    if (method === "GET" && url.startsWith("/api/notes")) return json([]);
    return json([]);
  });
  (mockedQueryClient as QueryClient).setQueryData(["/api/profiles"], PEOPLE);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("/profiles under a one-person scope is that person's Info", () => {
  it("shows Bob's info, not a one-card list of Bob", async () => {
    selectOnly("bob-1", "Bob Robertson");
    const { navigate } = renderAt("/profiles");

    // The person's own Info page — the editable name header, not a summary card.
    await waitFor(() => expect(screen.getByTestId("info-name")).toBeTruthy());
    expect(screen.getByTestId("info-name").textContent).toContain("Bob Robertson");
    expect(screen.queryByTestId("info-people")).toBeNull();
    expect(screen.queryByTestId("info-person-bob-1")).toBeNull();
    // …and the URL is untouched. reconcileInfoRoute owns every Info redirect;
    // a navigate() from this page is half of the 2026-08-05 crash loop.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the people grid one click away via 'All people'", async () => {
    selectOnly("bob-1", "Bob Robertson");
    const { navigate } = renderAt("/profiles");
    await waitFor(() => expect(screen.getByTestId("info-browse-all")).toBeTruthy());

    fireEvent.click(screen.getByTestId("info-browse-all"));

    // Everyone, not just the person in scope — the point of the escape hatch is
    // browsing without having to widen the scope and put it back afterwards.
    await waitFor(() => expect(screen.getByTestId("info-people")).toBeTruthy());
    expect(screen.getByTestId("info-person-bob-1")).toBeTruthy();
    expect(screen.getByTestId("info-person-jane-1")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("still shows the grid for Everyone and for a multi-person selection", async () => {
    renderAt("/profiles");
    await waitFor(() => expect(screen.getByTestId("info-people")).toBeTruthy());
    expect(screen.getByTestId("info-person-jane-1")).toBeTruthy();
    cleanup();

    scope.mode = "selected";
    scope.selectedIds = ["bob-1", "jane-1"];
    scope.selectedNames = ["Bob Robertson", "Jane Doe"];
    scope.isFiltered = true;
    renderAt("/profiles");
    await waitFor(() => expect(screen.getByTestId("info-people")).toBeTruthy());
    expect(screen.getByTestId("info-person-bob-1")).toBeTruthy();
    expect(screen.getByTestId("info-person-jane-1")).toBeTruthy();
  });

  it("an explicit /profiles/:id/info still wins over the scope", async () => {
    // Opening someone from search or the bell while scoped to another person
    // must show the person you opened.
    selectOnly("jane-1", "Jane Doe");
    const { navigate } = renderAt("/profiles/bob-1/info");
    await waitFor(() => expect(screen.getByTestId("info-name")).toBeTruthy());
    expect(screen.getByTestId("info-name").textContent).toContain("Bob Robertson");
    // No "All people" button here: /profiles is a real destination to go back to.
    expect(screen.queryByTestId("info-browse-all")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});
