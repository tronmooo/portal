// @vitest-environment jsdom
//
// Rule 8: destructive buttons take two taps. A review on 2026-11-12 found
// eleven row-level controls that fired their DELETE on the first tap with no
// confirmation and no undo — reversing a loan payment, removing a co-owner,
// deleting a budget, a saved fact, a warranty claim. They share one component
// now; this pins its behaviour and that those controls use it.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfirmIconButton } from "../client/src/components/ui/confirm-icon-button";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ConfirmIconButton", () => {
  it("the first tap only arms it; the second runs the action once", () => {
    const run = vi.fn();
    render(<ConfirmIconButton onConfirm={run} label="Delete payment" data-testid="b">x</ConfirmIconButton>);
    const b = screen.getByTestId("b");
    expect(b.getAttribute("aria-label")).toBe("Delete payment");
    fireEvent.click(b);
    expect(run).not.toHaveBeenCalled();
    expect(b.textContent).toBe("Delete?");
    expect(b.getAttribute("aria-label")).toBe("Tap again: Delete payment");
    fireEvent.click(b);
    expect(run).toHaveBeenCalledTimes(1);
    expect(b.textContent).toBe("x");
  });

  it("disarms by itself, so a later stray tap starts over", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    render(<ConfirmIconButton onConfirm={run} label="Delete" data-testid="b">x</ConfirmIconButton>);
    fireEvent.click(screen.getByTestId("b"));
    act(() => { vi.advanceTimersByTime(4100); });
    expect(screen.getByTestId("b").textContent).toBe("x");
    fireEvent.click(screen.getByTestId("b"));
    expect(run).not.toHaveBeenCalled();
  });

  it("moving focus away disarms it", () => {
    const run = vi.fn();
    render(<ConfirmIconButton onConfirm={run} label="Delete" data-testid="b">x</ConfirmIconButton>);
    fireEvent.click(screen.getByTestId("b"));
    fireEvent.blur(screen.getByTestId("b"));
    fireEvent.click(screen.getByTestId("b"));
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing while the action is already running", () => {
    const run = vi.fn();
    render(<ConfirmIconButton onConfirm={run} label="Delete" pending data-testid="b">x</ConfirmIconButton>);
    fireEvent.click(screen.getByTestId("b"));
    fireEvent.click(screen.getByTestId("b"));
    expect(run).not.toHaveBeenCalled();
  });

  it("does not trigger the row it sits in", () => {
    const row = vi.fn();
    render(<div onClick={row}><ConfirmIconButton onConfirm={() => undefined} label="Delete" data-testid="b">x</ConfirmIconButton></div>);
    fireEvent.click(screen.getByTestId("b"));
    expect(row).not.toHaveBeenCalled();
  });
});

describe("the row-level destructive controls are two-tap", () => {
  const CONTROLS: Array<[string, string]> = [
    ["client/src/pages/profile-detail.tsx", "button-delete-claim-"],
    ["client/src/pages/profile-detail.tsx", "button-delete-redemption-"],
    ["client/src/pages/profile-detail.tsx", "button-delete-sub-payment-"],
    ["client/src/pages/profile-detail.tsx", "button-remove-coowner-"],
    ["client/src/pages/profile-detail.tsx", "button-remove-collateral-"],
    ["client/src/pages/liability-detail.tsx", "reverse-payment-"],
    ["client/src/pages/liability-detail.tsx", "asset-link-delete"],
    ["client/src/pages/liability-detail.tsx", "party-link-delete"],
    ["client/src/pages/trackers.tsx", "btn-delete-tracker-goal"],
    ["client/src/components/dashboard/HeroKPIPopups.tsx", "budget-delete-"],
    ["client/src/pages/profile-info.tsx", "info-remove-"],
    ["client/src/components/liability/BillScheduleSection.tsx", "occ-charge-remove-"],
  ];
  it.each(CONTROLS)("%s · %s", (file, testId) => {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    const at = src.indexOf(`data-testid=${testId.endsWith("-") ? "{`" : '"'}${testId}`);
    expect(at, `control ${testId} not found in ${file}`).toBeGreaterThan(-1);
    // The element that carries this test id is a <ConfirmIconButton …>.
    const open = src.lastIndexOf("<", at);
    const tagStart = Math.max(src.lastIndexOf("<ConfirmIconButton", at), src.lastIndexOf("<button", at), src.lastIndexOf("<Button", at));
    expect(src.slice(tagStart, tagStart + 18)).toBe("<ConfirmIconButton");
    expect(open).toBeGreaterThan(-1);
  });
});
