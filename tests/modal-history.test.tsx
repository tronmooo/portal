// @vitest-environment jsdom
//
// Back-button-aware modals (lib/modal-history): pressing Back while a
// controlled dialog is open must CLOSE the dialog, not navigate the page —
// and stacked modals close one at a time, top-most first (2026-07-29 tester
// report: "The Back button skips modals — closes the modal AND changes the
// page").
import React, { useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Dialog, DialogContent } from "../client/src/components/ui/dialog";

afterEach(cleanup);

const popstate = () => act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });

function Host({ onChange, testId }: { onChange: (o: boolean) => void; testId: string }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); onChange(o); }}>
      <DialogContent data-testid={testId}>hello</DialogContent>
    </Dialog>
  );
}

describe("useModalHistory (Dialog root)", () => {
  it("Back closes an open dialog instead of leaving it open", () => {
    const onChange = vi.fn();
    const { queryByTestId } = render(<Host onChange={onChange} testId="m1" />);
    expect(queryByTestId("m1")).not.toBeNull();
    popstate();
    expect(onChange).toHaveBeenCalledWith(false);
    expect(queryByTestId("m1")).toBeNull();
  });

  it("stacked modals close one at a time, top-most first", () => {
    const first = vi.fn();
    const second = vi.fn();
    const r1 = render(<Host onChange={first} testId="m-a" />);
    const r2 = render(<Host onChange={second} testId="m-b" />);
    expect(r1.queryByTestId("m-a")).not.toBeNull();
    expect(r2.queryByTestId("m-b")).not.toBeNull();
    // First Back: only the most recently opened modal closes.
    popstate();
    expect(second).toHaveBeenCalledWith(false);
    expect(first).not.toHaveBeenCalled();
    // Second Back: the remaining modal closes.
    popstate();
    expect(first).toHaveBeenCalledWith(false);
  });

  it("a popstate with no open modal is left to the router (nothing closes, no crash)", () => {
    const onChange = vi.fn();
    const { queryByTestId } = render(<Host onChange={onChange} testId="m2" />);
    popstate(); // closes the modal
    onChange.mockClear();
    popstate(); // plain navigation — stack is empty
    expect(onChange).not.toHaveBeenCalled();
    expect(queryByTestId("m2")).toBeNull();
  });
});
