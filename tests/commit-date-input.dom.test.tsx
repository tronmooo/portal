// @vitest-environment jsdom
// A date field that saves must not save a date that is still being typed
// (owner report 2026-11-24: the task editor sent "0002-11-25" on the first
// typed year digit, the server refused it and the field reset to blank).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { CommitDateInput } from "@/components/CommitDateInput";

afterEach(cleanup);
const field = (c: HTMLElement) => c.querySelector('input[type="date"]') as HTMLInputElement;

describe("CommitDateInput", () => {
  it("typing 11/25/2026 saves once, with the whole date", () => {
    const onCommit = vi.fn();
    const { container } = render(<CommitDateInput value="" onCommit={onCommit} data-testid="due" />);
    const input = field(container);
    fireEvent.focus(input);
    // What the browser reports as the year is typed digit by digit.
    for (const v of ["0002-11-25", "0020-11-25", "0202-11-25"]) {
      fireEvent.change(input, { target: { value: v } });
      expect(onCommit).not.toHaveBeenCalled();
      expect(input.value).toBe(v); // the field keeps what was typed
    }
    fireEvent.change(input, { target: { value: "2026-11-25" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2026-11-25");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1); // the blur does not send it again
  });

  it("a pick from the calendar popup saves at once", () => {
    const onCommit = vi.fn();
    const { container } = render(<CommitDateInput value="2026-11-24" onCommit={onCommit} />);
    fireEvent.change(field(container), { target: { value: "2026-12-01" } });
    expect(onCommit).toHaveBeenCalledWith("2026-12-01");
  });

  it("leaving a half-typed date saves nothing, restores the stored date and says so", () => {
    const onCommit = vi.fn();
    const { container, queryByTestId } = render(<CommitDateInput value="2026-11-24" onCommit={onCommit} data-testid="due" />);
    const input = field(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0002-11-25" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-11-24");
    expect(queryByTestId("due-unfinished")?.textContent).toMatch(/Nothing was changed/);
  });

  it("emptying the field and leaving it clears the date with \"\"", () => {
    const onCommit = vi.fn();
    const { container } = render(<CommitDateInput value="2026-11-24" onCommit={onCommit} />);
    const input = field(container);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    expect(onCommit).not.toHaveBeenCalled(); // a blank part mid-edit also reads ""
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("opening and leaving without a change writes nothing (Rule 3)", () => {
    const onCommit = vi.fn();
    const { container } = render(<CommitDateInput value="2026-11-24" onCommit={onCommit} />);
    fireEvent.focus(field(container));
    fireEvent.blur(field(container));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows the stored value when it changes elsewhere, but not while being typed in", () => {
    const { container, rerender } = render(<CommitDateInput value="" onCommit={() => {}} />);
    const input = field(container);
    rerender(<CommitDateInput value="2026-11-30" onCommit={() => {}} />);
    expect(input.value).toBe("2026-11-30");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0002-12-01" } });
    rerender(<CommitDateInput value="2026-11-29" onCommit={() => {}} />); // a refetch lands mid-typing
    expect(input.value).toBe("0002-12-01");
  });
});
