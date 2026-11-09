// @vitest-environment jsdom
// The chat copy button did nothing in embedded browsers/webviews: it used
// navigator.clipboard only, which rejects there, and swallowed the error.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import { CopyButton } from "@/components/chat/CopyButton";

afterEach(() => { vi.restoreAllMocks(); });

describe("chat CopyButton", () => {
  it("copies when navigator.clipboard rejects (embedded browser)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    let copied = "";
    (document as any).execCommand = vi.fn((cmd: string) => {
      if (cmd !== "copy") return false;
      copied = (document.activeElement as HTMLTextAreaElement)?.value ?? "";
      return true;
    });
    render(<CopyButton value="Weight: 182.4 lbs logged" label="Copy" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(copied).toBe("Weight: 182.4 lbs logged");
  });

  it("falls back to navigator.clipboard when the selection copy is refused", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    (document as any).execCommand = vi.fn(() => false);
    render(<CopyButton value="hello" label="Copy" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("says so when nothing could copy, instead of failing silently", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("no")) }, configurable: true });
    (document as any).execCommand = vi.fn(() => false);
    render(<CopyButton value="hello" label="Copy" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Couldn't copy")).toBeTruthy());
  });
});
