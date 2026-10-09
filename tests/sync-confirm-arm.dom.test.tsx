// @vitest-environment jsdom
//
// Rule 9: a destructive button arms on the first tap and acts on the second;
// a stray single tap (a scroll ending on the button) changes nothing.
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useConfirmArm, CONFIRM_WINDOW_MS } from "../client/src/hooks/useConfirmArm";

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const arm = useConfirmArm();
  return (
    <button data-testid="del" onClick={() => arm.confirm("x", onDelete)}>
      {arm.isArmed("x") ? "Tap again to delete" : "Delete"}
    </button>
  );
}

describe("useConfirmArm", () => {
  it("first tap arms, second tap deletes", () => {
    const onDelete = vi.fn();
    render(<DeleteButton onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId("del"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId("del").textContent).toBe("Tap again to delete");
    fireEvent.click(screen.getByTestId("del"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("del").textContent).toBe("Delete");
    cleanup();
  });

  it("a single stray tap disarms on its own and never deletes", () => {
    vi.useFakeTimers();
    const onDelete = vi.fn();
    render(<DeleteButton onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId("del"));
    act(() => { vi.advanceTimersByTime(CONFIRM_WINDOW_MS + 10); });
    expect(screen.getByTestId("del").textContent).toBe("Delete");
    fireEvent.click(screen.getByTestId("del")); // arms again, does not delete
    expect(onDelete).not.toHaveBeenCalled();
    vi.useRealTimers();
    cleanup();
  });
});
