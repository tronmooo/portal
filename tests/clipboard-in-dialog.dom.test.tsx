// @vitest-environment jsdom
//
// Live, 2026-11-26: "Copy as text" and "Copy view-only link" in the artifact
// viewer copied NOTHING. The copy box was appended to <body>; the open
// dialog's focus trap took focus back, execCommand("copy") copied an empty
// selection and still answered true, so the clipboard-API fallback never ran.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "../client/src/components/ui/dialog";
import { copyText } from "../client/src/lib/clipboard";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function captureCopies() {
  const copied: string[] = [];
  (document as any).execCommand = vi.fn((cmd: string) => {
    if (cmd !== "copy") return false;
    const a = document.activeElement as HTMLTextAreaElement | null;
    copied.push(a && a.tagName === "TEXTAREA" ? a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? a.value.length) : "");
    return true;
  });
  return copied;
}

describe("copyText", () => {
  it("copies the text from inside an open dialog (its focus trap does not eat it)", async () => {
    const copied = captureCopies();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Viewer</DialogTitle>
          <button>inside</button>
        </DialogContent>
      </Dialog>,
    );
    screen.getByText("inside").focus();
    let ok = false;
    await act(async () => { ok = await copyText("Morning Routine\n\n☐ Drink water"); });
    expect(ok).toBe(true);
    expect(copied).toEqual(["Morning Routine\n\n☐ Drink water"]);
    // The box is gone again and focus is back where it was.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("copies on a plain page too", async () => {
    const copied = captureCopies();
    let ok = false;
    await act(async () => { ok = await copyText("https://portol.me/#/share/abc"); });
    expect(ok).toBe(true);
    expect(copied).toEqual(["https://portol.me/#/share/abc"]);
  });

  it("falls back to the clipboard API when the selection copy cannot take focus", async () => {
    (document as any).execCommand = vi.fn(() => true);
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(() => {});
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let ok = false;
    await act(async () => { ok = await copyText("hello"); });
    expect(focus).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(ok).toBe(true);
  });
});
