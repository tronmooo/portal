// @vitest-environment jsdom
//
// QA report 2026-08-05, the one hard crash: open a person's Info page
// (/profiles/:id/info), open the person switcher, pick "Everyone" → full
// white-screen, "Something went wrong / An unexpected error occurred", React
// error #185 ("Maximum update depth exceeded"). Reproduced 2/2.
//
// Cause: two redirects pointed at each other. HubShell's reconcileInfoRoute
// sent /profiles/<self>/info → /profiles whenever the scope was not exactly one
// person, and the Info page's own InfoSelfRedirect sent /profiles →
// /profiles/<self>/info. Neither is wrong alone; together they never settle.
//
// tests/hub-routes.test.ts proves the reconciler is now a fixpoint. These tests
// prove the other half — that the PAGE renders the aggregated scope instead of
// navigating out of it — by rendering it and watching the router.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

const { apiRequest, scope } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => new Response("[]", { status: 200 })),
  scope: { mode: "everyone" as string, selectedIds: [] as string[], selectedNames: [] as string[], isFiltered: false },
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => scope }));

import ProfileInfoPage from "../client/src/pages/profile-info";
import { queryClient as mockedQueryClient } from "@/lib/queryClient";

const PEOPLE = [
  { id: "self-1", type: "self", name: "Mike", fields: { birthday: "1985-04-02" }, tags: ["household"] },
  { id: "bob-1", type: "person", name: "Bob", fields: {}, tags: [] },
  { id: "rex-1", type: "pet", name: "Rex", fields: {}, tags: [] },
  // Not a person — assets/liabilities must not show up in a people list.
  { id: "house-1", type: "asset", name: "House", fields: {}, tags: [] },
];

/** Render at `path` with a router whose navigate is a spy, so a redirect fired
 *  from render or an effect is observable instead of silently looping. */
function renderAt(path: string) {
  const navigate = vi.fn();
  const hook = () => [path, navigate] as [string, (to: string, opts?: any) => void];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <Router hook={hook as any}>
        <ProfileInfoPage />
      </Router>
    </QueryClientProvider>,
  );
  return { navigate, view };
}

beforeEach(() => {
  scope.mode = "everyone";
  scope.selectedIds = [];
  scope.selectedNames = [];
  scope.isFiltered = false;
  // The profiles list the page reads without touching the network.
  (mockedQueryClient as QueryClient).setQueryData(["/api/profiles"], PEOPLE);
  (mockedQueryClient as QueryClient).setQueryData(["/api/memories"], []);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Info under an aggregated scope renders instead of redirecting", () => {
  it("shows a card per person, and never navigates", () => {
    const { navigate } = renderAt("/profiles");

    expect(screen.getByTestId("page-profile-info")).toBeTruthy();
    expect(screen.getByTestId("info-person-self-1")).toBeTruthy();
    expect(screen.getByTestId("info-person-bob-1")).toBeTruthy();
    expect(screen.getByTestId("info-person-rex-1")).toBeTruthy();
    // THE regression: any navigate() from this page is half of the redirect
    // loop that white-screened the app.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("lists people only — assets and liabilities are not 'everyone'", () => {
    renderAt("/profiles");
    expect(screen.queryByTestId("info-person-house-1")).toBeNull();
  });

  it("shows only the selected people under a multi-person selection", () => {
    scope.mode = "selected";
    scope.selectedIds = ["self-1", "bob-1"];
    scope.selectedNames = ["Mike", "Bob"];
    scope.isFiltered = true;

    const { navigate } = renderAt("/profiles");
    expect(screen.getByTestId("info-person-self-1")).toBeTruthy();
    expect(screen.getByTestId("info-person-bob-1")).toBeTruthy();
    expect(screen.queryByTestId("info-person-rex-1")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate even when a single person is selected", () => {
    // HubShell's reconcileInfoRoute owns this redirect. If the page did it too,
    // the two would be free to disagree again — which is the whole bug.
    scope.mode = "selected";
    scope.selectedIds = ["bob-1"];
    scope.selectedNames = ["Bob"];
    scope.isFiltered = true;

    const { navigate } = renderAt("/profiles");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders an empty state rather than redirecting when there are no people", () => {
    (mockedQueryClient as QueryClient).setQueryData(["/api/profiles"], [
      { id: "house-1", type: "asset", name: "House", fields: {}, tags: [] },
    ]);
    const { navigate } = renderAt("/profiles");
    expect(screen.getByText("No people yet.")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
