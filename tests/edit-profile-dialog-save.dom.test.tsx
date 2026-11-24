// @vitest-environment jsdom
//
// The profile Edit dialog (QA 2026-11-24, second pass, on a subscription):
//
//  1. "Next Billing" — a native date input reports 0002-12-12, 0020-12-12 and
//     0202-12-12 while 2026 is typed. The dialog autosaved each of them (one
//     was stored as the year 202) and the field went blank. A date is saved
//     whole or not at all (Rule 6, CommitDateInput).
//  2. "Done" closed the dialog first and saved behind it, so a reload made at
//     once lost the edit (the plan change). Done now waits for the save (L7),
//     and a failed save keeps the dialog open.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest: h.apiRequest, BROWSER_TIMEZONE: "UTC", getQueryFn: () => async () => null };
});

import { queryClient } from "@/lib/queryClient";
import { EditProfileDialog } from "@/pages/profile-detail";

const SUB: any = { id: "sub-1", type: "subscription", name: "Stream Plus", notes: "", fields: { cost: 9.99, frequency: "monthly", plan: "Basic" } };
const ok = () => Promise.resolve({ ok: true, json: async () => ({}) } as any);

function mount(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={queryClient}>
      <EditProfileDialog open profile={SUB} onClose={onClose} onSaved={() => {}} />
    </QueryClientProvider>,
  );
  return onClose;
}
const patches = () => h.apiRequest.mock.calls.filter((c) => c[0] === "PATCH").map((c) => c[2]);
const flushPromises = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => { h.apiRequest.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Next Billing is saved whole", () => {
  it("sends only the finished day, never the years typed on the way", async () => {
    h.apiRequest.mockImplementation(ok);
    vi.useFakeTimers();
    mount();
    const input = screen.getByTestId("input-field-renewalDate") as HTMLInputElement;
    expect(input.type).toBe("date");
    fireEvent.focus(input);
    for (const v of ["0002-12-12", "0020-12-12", "0202-12-12"]) {
      fireEvent.change(input, { target: { value: v } });
      await act(async () => { vi.advanceTimersByTime(1500); });
    }
    expect(patches()).toEqual([]);
    expect(input.value).toBe("0202-12-12"); // what was typed is still there
    fireEvent.change(input, { target: { value: "2026-12-12" } });
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flushPromises();
    expect(patches()).toEqual([{ fields: { renewalDate: "2026-12-12" } }]);
    expect(input.value).toBe("2026-12-12");
    fireEvent.blur(input);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(patches()).toHaveLength(1); // the blur does not send it again
  });

  it("a half-typed date left behind writes nothing and says so", async () => {
    h.apiRequest.mockImplementation(ok);
    mount();
    const input = screen.getByTestId("input-field-renewalDate") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0020-12-12" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("input-field-renewalDate-unfinished")).toBeTruthy();
    expect(patches()).toEqual([]);
  });
});

describe("Done waits for the save", () => {
  it("does not close until the change is stored", async () => {
    let finish!: (v: any) => void;
    h.apiRequest.mockImplementation(() => new Promise((r) => { finish = r; }));
    const onClose = mount();
    fireEvent.change(screen.getByTestId("input-field-plan"), { target: { value: "Premium Family" } });
    fireEvent.click(screen.getByTestId("button-done-edit-profile"));
    await flushPromises();
    expect(patches()).toEqual([{ fields: { plan: "Premium Family" } }]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("button-done-edit-profile").textContent).toMatch(/Saving/);
    await act(async () => { finish({ ok: true, json: async () => ({}) }); });
    await flushPromises();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("joins a save already on its way instead of closing behind it", async () => {
    let finish!: (v: any) => void;
    h.apiRequest.mockImplementationOnce(() => new Promise((r) => { finish = r; })).mockImplementation(ok);
    const onClose = mount();
    const plan = screen.getByTestId("input-field-plan");
    fireEvent.change(plan, { target: { value: "Premium" } });
    fireEvent.blur(plan); // the first save leaves
    await flushPromises();
    fireEvent.change(plan, { target: { value: "Premium Family" } });
    fireEvent.click(screen.getByTestId("button-done-edit-profile"));
    await flushPromises();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish({ ok: true, json: async () => ({}) }); });
    await flushPromises();
    expect(patches()).toEqual([{ fields: { plan: "Premium" } }, { fields: { plan: "Premium Family" } }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed save keeps the dialog open; a second press closes without it", async () => {
    h.apiRequest.mockImplementation(() => Promise.reject(new Error("500: boom")));
    const onClose = mount();
    fireEvent.change(screen.getByTestId("input-field-plan"), { target: { value: "Premium Family" } });
    fireEvent.click(screen.getByTestId("button-done-edit-profile"));
    await flushPromises();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("edit-save-status").textContent).toMatch(/Couldn't save/);
    const done = screen.getByTestId("button-done-edit-profile");
    expect(done.textContent).toMatch(/Close without saving/);
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
