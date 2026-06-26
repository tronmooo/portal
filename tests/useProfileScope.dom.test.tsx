// @vitest-environment jsdom
//
// Runtime verification of the reactive profile-scope binding — the heart of the
// system-wide isolation fix. These mount REAL components into a jsdom DOM and
// assert the behaviors the user reported as broken:
//
//   1. A component reflects the active profile and RE-RENDERS when it changes
//      (filters/views/popups updating live).
//   2. Two independent components (e.g. the dashboard page AND a popup) stay in
//      lockstep on the same selection — no component shows another profile.
//   3. Selecting a profile and then mounting a NEW component (navigating to a
//      page / opening a popup) preserves the selection — nothing resets it.
//   4. useSyncExternalStore does not loop: a single filter change causes a
//      bounded number of renders (the old getProfileFilter() snapshot returned a
//      fresh object every call, which would loop here — this proves the stable
//      snapshot works).
//   5. The create-target follows the active scope (new records land on the
//      selected profile, not "me").

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, act, cleanup } from "@testing-library/react";
import {
  useProfileScope,
  useActiveCreateProfileId,
} from "../client/src/hooks/useProfileScope";
import {
  setFilterEveryone,
  setFilterSelected,
} from "../client/src/lib/profileFilter";

const PROFILES = [
  { id: "self-1", type: "self", name: "Me" },
  { id: "jane-1", type: "person", name: "Jane" },
  { id: "rex-1", type: "pet", name: "Rex" },
];

function ScopeProbe({ label }: { label: string }) {
  const { mode, selectedIds } = useProfileScope();
  return (
    <div data-testid={label}>
      {mode}:{selectedIds.join(",")}
    </div>
  );
}

function CreateTargetProbe() {
  const id = useActiveCreateProfileId(PROFILES);
  return <div data-testid="create-target">{id}</div>;
}

beforeEach(() => {
  // Known starting point: unfiltered.
  act(() => setFilterEveryone());
});

afterEach(() => {
  cleanup();
  act(() => setFilterEveryone());
});

describe("useProfileScope (runtime / jsdom)", () => {
  it("reflects the active selection and updates live when it changes", () => {
    const { getByTestId } = render(<ScopeProbe label="a" />);
    expect(getByTestId("a").textContent).toBe("everyone:");

    act(() => setFilterSelected(["jane-1"], ["Jane"]));
    expect(getByTestId("a").textContent).toBe("selected:jane-1");

    act(() => setFilterSelected(["jane-1", "rex-1"], ["Jane", "Rex"]));
    expect(getByTestId("a").textContent).toBe("selected:jane-1,rex-1");

    act(() => setFilterEveryone());
    expect(getByTestId("a").textContent).toBe("everyone:");
  });

  it("keeps two independent components in lockstep (page + popup never disagree)", () => {
    const { getByTestId } = render(
      <>
        <ScopeProbe label="page" />
        <ScopeProbe label="popup" />
      </>,
    );
    act(() => setFilterSelected(["jane-1"], ["Jane"]));
    expect(getByTestId("page").textContent).toBe("selected:jane-1");
    expect(getByTestId("popup").textContent).toBe("selected:jane-1");
  });

  it("preserves the selection when a NEW component mounts (navigation/popup open does not reset)", () => {
    act(() => setFilterSelected(["jane-1"], ["Jane"]));
    // Simulate opening a popup / navigating: a fresh component mounts AFTER the
    // selection was made. It must inherit Jane, not fall back to everyone.
    const { getByTestId } = render(<ScopeProbe label="late" />);
    expect(getByTestId("late").textContent).toBe("selected:jane-1");
  });

  it("does not infinite-loop: one filter change → a bounded number of renders", () => {
    let renders = 0;
    function Counter() {
      renders++;
      useProfileScope();
      return null;
    }
    render(<Counter />);
    const afterMount = renders;
    act(() => setFilterSelected(["jane-1"], ["Jane"]));
    // A single store change should cost exactly one extra render (a runaway
    // loop from an unstable snapshot would be dozens/hundreds).
    expect(renders - afterMount).toBeLessThanOrEqual(2);
    expect(renders - afterMount).toBeGreaterThanOrEqual(1);
  });

  it("create-target follows the active scope, not 'me'", () => {
    const { getByTestId } = render(<CreateTargetProbe />);
    // Unfiltered → self
    expect(getByTestId("create-target").textContent).toBe("self-1");
    // Scoped to Jane → new records target Jane
    act(() => setFilterSelected(["jane-1"], ["Jane"]));
    expect(getByTestId("create-target").textContent).toBe("jane-1");
  });
});
