// @vitest-environment jsdom
//
// The renderer's half of the contract: the server decides WHAT the Overview
// says, this decides how it looks. So what's pinned here is not styling — it's
// that the composed definition reaches the screen intact:
//
//   · the headline number appears ONCE, not four times under four labels
//   · a linked liability is summarized with a link to the record that owns it
//   · a missing-information suggestion writes to the field it names
//   · a composition that fails to load falls back instead of blanking the page
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { composeOverview } from "@shared/overview-compose";

const { apiRequest, calls } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  calls: [] as Array<{ method: string; url: string; body: any }>,
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({
  invalidateDomain: vi.fn(async () => {}),
  invalidateDomains: vi.fn(async () => {}),
}));

import { DynamicOverview } from "@/components/overview/DynamicOverview";

const SPEC = composeOverview({
  now: new Date("2026-08-26T12:00:00Z"),
  entity: {
    id: "house", name: "123 Evergreen Ln", type: "property",
    fields: { address: "123 Evergreen Ln", currentValue: 345000, purchasePrice: 300000 },
  },
  related: [{
    id: "mortgage-1", name: "Evergreen Mortgage", kind: "mortgage", relation: "financing",
    fields: { balance: 240000, monthlyPayment: 1850 },
  }],
});

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let failOverview = false;

beforeEach(() => {
  calls.length = 0;
  failOverview = false;
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (url.includes("/find-value")) {
      return json({ estimatedValue: 352000, confidence: "medium", explanation: "Three comparable sales nearby." });
    }
    if (url.includes("/overview")) {
      if (failOverview) throw new Error("500");
      return json(SPEC);
    }
    return json({ ok: true });
  });
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderOverview(fallback?: React.ReactNode) {
  const navigate = vi.fn();
  const hook = () => ["/profiles/house", navigate] as [string, (to: string) => void];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook as any}>
        <DynamicOverview profileId="house" fallback={fallback} />
      </Router>
    </QueryClientProvider>,
  );
  return navigate;
}

describe("the composed Overview reaches the screen", () => {
  it("shows the entity's headline value exactly once", async () => {
    renderOverview();
    await screen.findByTestId("dynamic-overview");
    const shown = screen.getAllByText((_, el) => (el?.textContent || "").trim() === "$345,000")
      // getAllByText matches ancestors too; keep the leaf nodes.
      .filter(el => el.children.length === 0);
    expect(shown).toHaveLength(1);
  });

  it("summarizes the mortgage and navigates to the record that owns it", async () => {
    const navigate = renderOverview();
    const rel = await screen.findByTestId("overview-relationship-mortgage-1");
    expect(rel.textContent).toContain("Evergreen Mortgage");
    expect(rel.textContent).toContain("$240,000");
    fireEvent.click(rel);
    expect(navigate.mock.calls[0][0]).toBe("/profiles/mortgage-1");
  });

  it("marks a calculated number as calculated so it can't read as entered fact", async () => {
    renderOverview();
    await screen.findByTestId("dynamic-overview");
    const equity = await screen.findByTestId("overview-summary-equity");
    expect(equity.textContent).toContain("calculated");
    expect(equity.textContent).toContain("$105,000");
  });

  it("writes a missing field to the key the suggestion names", async () => {
    renderOverview();
    await screen.findByTestId("dynamic-overview");
    const suggestion = await screen.findByTestId("overview-missing-ownershipPercentage");
    fireEvent.click(suggestion);
    const input = await screen.findByDisplayValue("");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some(c =>
        c.method === "PATCH" && c.url === "/api/profiles/house" &&
        c.body?.fields?.ownershipPercentage === "50")).toBe(true);
    });
  });

  it("offers a market lookup on an asset and only writes the estimate on request", async () => {
    renderOverview();
    await screen.findByTestId("dynamic-overview");
    fireEvent.click(await screen.findByTestId("overview-find-value"));
    const result = await screen.findByTestId("overview-find-value-result");
    expect(result.textContent).toContain("$352,000");
    // Nothing is written until the user accepts it.
    expect(calls.some(c => c.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByText("Use this"));
    await waitFor(() => {
      expect(calls.some(c =>
        c.method === "PATCH" && c.body?.fields?.currentValue === "352000")).toBe(true);
    });
  });

  it("falls back rather than blanking the page when composition is unavailable", async () => {
    failOverview = true;
    renderOverview(<div data-testid="legacy-overview">legacy</div>);
    await screen.findByTestId("legacy-overview");
    expect(screen.queryByTestId("dynamic-overview")).toBeNull();
  });
});
