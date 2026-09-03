// @vitest-environment jsdom
// D138 — HubShell reconciled the Info route on every LOCATION change, so
// opening any person's Info page while scoped to someone else was replaced
// at once by the scoped person's page.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const hubScope = { mode: "selected", selectedIds: ["self-1"], selectedNames: ["Me"], isFiltered: true } as any;
let hubLocation = "/profiles/linda-1/info";
const hashReplaceSpy = vi.fn();
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: vi.fn(), hashReplace: (...a: any[]) => hashReplaceSpy(...a) }));
vi.mock("@/hooks/useProfileScope", () => ({
  useProfileScope: () => hubScope,
  profileScopeParam: () => "",
  useActiveCreateProfileId: () => undefined,
}));
vi.mock("@/hooks/useResumeTick", () => ({ useResumeTick: () => 0 }));
vi.mock("@/hooks/useOverflowX", () => ({ useOverflowX: () => [{ current: null }, false] }));
vi.mock("@/components/hub/HubKpiStrip", () => ({ HubKpiStrip: () => null }));
vi.mock("@/components/hub/HubProfileSwitcher", () => ({ HubProfileSwitcher: () => null }));
vi.mock("wouter", async (orig) => ({ ...(await orig<any>()), useLocation: () => [hubLocation, vi.fn()] }));

import { HubShell } from "../client/src/components/hub/HubShell";

describe("D138: the hub keeps a person's Info page open unless the scope itself changes", () => {
  afterEach(() => { cleanup(); hashReplaceSpy.mockClear(); });
  it("does not replace another person's Info URL on mount or on a location change", () => {
    hubScope.selectedIds = ["self-1"]; hubLocation = "/profiles/linda-1/info";
    const view = render(<HubShell />);
    expect(hashReplaceSpy).not.toHaveBeenCalled();
    hubLocation = "/profiles/mike-1/info";
    view.rerender(<HubShell />);
    expect(hashReplaceSpy).not.toHaveBeenCalled();
  });
  it("still corrects the Info URL when the scope selection changes", () => {
    hubScope.selectedIds = ["self-1"]; hubLocation = "/profiles/linda-1/info";
    const view = render(<HubShell />);
    hubScope.selectedIds = ["bob-1"];
    view.rerender(<HubShell />);
    expect(hashReplaceSpy).toHaveBeenCalledWith("/profiles/bob-1/info");
    hubScope.selectedIds = [];
    view.rerender(<HubShell />);
    expect(hashReplaceSpy).toHaveBeenLastCalledWith("/profiles");
  });
});
