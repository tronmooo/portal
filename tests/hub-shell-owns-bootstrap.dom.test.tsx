// @vitest-environment jsdom
// 2026-09-04: only the Executive tab fetched the scope bootstrap, so a reload
// or deep link onto Assets / Finance / Wellness left the KPI strip on "…" and
// every tab paying its own cold round-trip. The shell — mounted for every hub
// route — owns that request now, and warms a tab's chunk on pointer intent.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

const hubScope = { mode: "selected", selectedIds: ["self-1"], selectedNames: ["Me"], isFiltered: true } as any;
const prefetchSpy = vi.fn(() => Promise.resolve());
const chunkSpy = vi.fn();
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: vi.fn(), hashReplace: vi.fn() }));
vi.mock("@/lib/scope-prefetch", () => ({ prefetchScopeBootstrap: (...a: any[]) => prefetchSpy(...a) }));
vi.mock("@/lib/navigation-prefetch", () => ({ preloadHubTabChunk: (...a: any[]) => chunkSpy(...a) }));
vi.mock("@/hooks/useProfileScope", () => ({
  useProfileScope: () => hubScope,
  profileScopeParam: () => "",
  useActiveCreateProfileId: () => undefined,
}));
vi.mock("@/hooks/useResumeTick", () => ({ useResumeTick: () => 0 }));
vi.mock("@/hooks/useOverflowX", () => ({ useOverflowX: () => [{ current: null }, false] }));
vi.mock("@/components/hub/HubKpiStrip", () => ({ HubKpiStrip: () => null }));
vi.mock("@/components/hub/HubProfileSwitcher", () => ({ HubProfileSwitcher: () => null }));
vi.mock("wouter", async (orig) => ({ ...(await orig<any>()), useLocation: () => ["/linked?tab=assets", vi.fn()] }));

import { HubShell } from "../client/src/components/hub/HubShell";

describe("HubShell owns the scope bootstrap", () => {
  afterEach(() => { cleanup(); prefetchSpy.mockClear(); chunkSpy.mockClear(); });

  it("fires the bootstrap for the active scope on mount — on a non-Executive route", () => {
    hubScope.mode = "selected"; hubScope.selectedIds = ["self-1"];
    render(<HubShell />);
    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledWith("selected", ["self-1"]);
  });

  it("fires again only when the scope changes, not on every render", () => {
    hubScope.mode = "selected"; hubScope.selectedIds = ["self-1"];
    const view = render(<HubShell />);
    view.rerender(<HubShell />);
    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    hubScope.mode = "everyone"; hubScope.selectedIds = [];
    view.rerender(<HubShell />);
    expect(prefetchSpy).toHaveBeenCalledTimes(2);
    expect(prefetchSpy).toHaveBeenLastCalledWith("everyone", []);
  });

  it("warms a tab's chunk when the pointer reaches its chip", () => {
    const { getByTestId } = render(<HubShell />);
    fireEvent.pointerEnter(getByTestId("hub-tab-finance"));
    expect(chunkSpy).toHaveBeenCalledWith("finance");
    fireEvent.touchStart(getByTestId("hub-tab-wellness"));
    expect(chunkSpy).toHaveBeenCalledWith("wellness");
  });
});
