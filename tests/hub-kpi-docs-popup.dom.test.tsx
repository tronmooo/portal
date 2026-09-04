// @vitest-environment jsdom
//
// Regression: the DOCS EXP chip on the hub KPI strip had no popup — pressing
// it navigated to the Documents tab. User report 2026-09-04: "There is no pop
// up here. When I press this, nothing happens. It just redirects me somewhere."
//
// Every other number on that strip opens the dashboard's existing popup for it.
// This one now opens the Documents expirations popup — the same component the
// Executive briefing's Documents card opens — and its count is derived exactly
// the way that popup lists rows, so the tile can't promise a number the popup
// then contradicts.

import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const navigateSpy = vi.fn();
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (...a: any[]) => navigateSpy(...a), hashReplace: vi.fn() }));
vi.mock("@/hooks/useProfileScope", () => ({
  useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }),
  profileScopeParam: () => "",
}));
vi.mock("@/hooks/useOverflowX", () => ({ useOverflowX: () => [{ current: null }, false] }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn(), BROWSER_TIMEZONE: "UTC" }));

// Two rules on ONE document on ONE day: the raw feed's shape. The chip must
// read 1 (the popup groups them into a single card), not 2.
const EXPIRING = [
  { documentId: "doc-1", ruleId: "r1", documentName: "Passport", fieldName: "expirationDate", expirationDate: "2026-09-20", daysUntil: 16, ruleType: "expiration" },
  { documentId: "doc-1", ruleId: "r2", documentName: "Passport", fieldName: "renewalDate", expirationDate: "2026-09-20", daysUntil: 16, ruleType: "renewal" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const endpoint = String(queryKey?.[0] ?? "");
    if (endpoint === "/api/dashboard-enhanced") {
      return { data: { expiringDocuments: EXPIRING, overdueTasks: [], financeSnapshot: {} }, isPending: false };
    }
    if (endpoint === "/api/stats") return { data: { activeTasks: 0, streaks: [] }, isPending: false };
    return { data: [], isPending: false };
  },
}));

// The real popup is a heavy lazy chunk; this test is about the wiring.
vi.mock("@/components/dashboard/BriefingPopups", () => ({
  DocsPopup: ({ docs }: any) => <div data-testid="docs-popup">docs:{docs.length}</div>,
}));

import { HubKpiStrip } from "../client/src/components/hub/HubKpiStrip";

beforeEach(() => { navigateSpy.mockClear(); });
afterEach(() => cleanup());

describe("DOCS EXP chip", () => {
  it("opens the expirations popup instead of navigating away", async () => {
    render(<HubKpiStrip />);
    fireEvent.click(screen.getByTestId("hub-kpi-docs"));
    await waitFor(() => expect(screen.getByTestId("docs-popup")).toBeTruthy());
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("hands the popup the raw rows, so a merged card keeps every rule id", async () => {
    render(<HubKpiStrip />);
    fireEvent.click(screen.getByTestId("hub-kpi-docs"));
    await waitFor(() => expect(screen.getByTestId("docs-popup").textContent).toBe("docs:2"));
  });

  it("counts records the way the popup lists them", () => {
    render(<HubKpiStrip />);
    // Two rules, one document, one day — one card in the popup, so the tile
    // reads 1. Counting the raw feed would say 2 and be contradicted the
    // moment the user opened it.
    const text = screen.getByTestId("hub-kpi-docs").textContent || "";
    expect(text).toMatch(/(^|\D)1(\D|$)/);
    expect(text).not.toContain("2");
  });
});
