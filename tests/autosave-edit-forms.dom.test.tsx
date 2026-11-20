// @vitest-environment jsdom
// "When I press Edit and change something, save it right away" (2026-11-19).
// The hook every auto-saving edit form uses, and the liability page's two
// forms wired to it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { useAutosave, AUTOSAVE_DELAY_MS, autosaveStatusLabel } from "../client/src/hooks/useAutosave";
import { stableStreamText } from "../client/src/lib/stream-text";

type Form = { rate: string; balance: string };

function setup(initial: Form, save = vi.fn(async (_c: Form, _b: Form) => {})) {
  const hook = renderHook(
    (p: { enabled: boolean; snapshot: Form }) => useAutosave<Form>({ ...p, save }),
    { initialProps: { enabled: true, snapshot: initial } },
  );
  return { ...hook, save };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("useAutosave", () => {
  it("opening the form writes nothing (Rule 3: navigation never writes)", async () => {
    const { save } = setup({ rate: "6.25", balance: "312400" });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3); });
    expect(save).not.toHaveBeenCalled();
  });

  it("a change is saved on its own, shortly after the user stops typing", async () => {
    const { rerender, save, result } = setup({ rate: "6.25", balance: "312400" });
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "312400" } });
    expect(result.current.status).toBe("pending");
    expect(save).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ rate: "5.5", balance: "312400" }, { rate: "6.25", balance: "312400" });
    expect(result.current.status).toBe("saved");
  });

  it("typing is one save, not one per keystroke — and ends on the last value", async () => {
    const { rerender, save } = setup({ rate: "6.25", balance: "" });
    for (const b of ["3", "30", "305", "3050", "30500", "305000"]) {
      rerender({ enabled: true, snapshot: { rate: "6.25", balance: b } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].balance).toBe("305000");
  });

  it("the next save diffs against what was last saved, not what the form opened with", async () => {
    const { rerender, save } = setup({ rate: "6.25", balance: "312400" });
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "312400" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "305000" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual({ rate: "5.5", balance: "312400" });
  });

  it("Done (flush) saves at once, without waiting out the pause", async () => {
    const { rerender, save, result } = setup({ rate: "6.25", balance: "312400" });
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "312400" } });
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("leaving the page with a change still waiting saves it", async () => {
    const { rerender, save, unmount } = setup({ rate: "6.25", balance: "312400" });
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "312400" } });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a failed save says so and the next change retries the whole difference", async () => {
    const save = vi.fn(async (_c: Form, _b: Form) => {});
    save.mockRejectedValueOnce(new Error("offline"));
    const { rerender, result } = setup({ rate: "6.25", balance: "312400" }, save);
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "312400" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    expect(result.current.status).toBe("error");
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "305000" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    expect(save).toHaveBeenCalledTimes(2);
    // Still measured from the last SUCCESSFUL save, so the rate is not lost.
    expect(save.mock.calls[1][1]).toEqual({ rate: "6.25", balance: "312400" });
    expect(result.current.status).toBe("saved");
  });

  it("remembers what the form opened with, however many saves happen (Undo changes)", async () => {
    const { rerender, result } = setup({ rate: "6.25", balance: "312400" });
    expect(result.current.changedSinceOpen).toBe(false);
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "312400" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    rerender({ enabled: true, snapshot: { rate: "5.5", balance: "305000" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); });
    // Saved twice — the opened values are still the ones to go back to.
    expect(result.current.opened).toEqual({ rate: "6.25", balance: "312400" });
    expect(result.current.changedSinceOpen).toBe(true);
    // Putting them back is a change like any other: it is saved.
    rerender({ enabled: true, snapshot: { rate: "6.25", balance: "312400" } });
    expect(result.current.changedSinceOpen).toBe(false);
  });

  it("names its state for the form", () => {
    expect(autosaveStatusLabel("idle")).toMatch(/save automatically/i);
    expect(autosaveStatusLabel("saving")).toBe("Saving…");
    expect(autosaveStatusLabel("saved")).toBe("Saved");
    expect(autosaveStatusLabel("error")).toMatch(/couldn't save/i);
  });
});

describe("the liability edit forms auto-save", () => {
  const page = readFileSync(resolve(__dirname, "../client/src/pages/liability-detail.tsx"), "utf8");
  it("loan terms and bill details both save through useAutosave, with no Save button to forget", () => {
    expect(page).toContain("const termsAutosave = useAutosave<TermsForm>");
    expect(page).toContain("const billAutosave = useAutosave<BillForm>");
    expect(page).not.toContain("saveTermsMutation");
    expect(page).not.toContain("saveBillMutation");
    expect(page).not.toMatch(/"Save terms"|"Save bill"/);
    expect(page).toContain('data-testid="terms-autosave-status"');
    expect(page).toContain('data-testid="bill-autosave-status"');
  });
  it("only what changed since the last save is written", () => {
    expect(page).toContain("changedFieldsOnly(buildTermsFields(saved), buildTermsFields(current))");
    expect(page).toContain("changedFieldsOnly(buildBillFields(saved), buildBillFields(current))");
  });
});

describe("a streaming reply never shows a half-written figure", () => {
  it("holds the trailing, still-growing word back", () => {
    expect(stableStreamText("Your new payment is $2,155/")).toBe("Your new payment is ");
    expect(stableStreamText("Your new payment is $2,155/mo ")).toBe("Your new payment is $2,155/mo ");
    expect(stableStreamText("Rate 22.")).toBe("Rate ");
    expect(stableStreamText("")).toBe("");
    expect(stableStreamText("Done.\n")).toBe("Done.\n");
  });
});
