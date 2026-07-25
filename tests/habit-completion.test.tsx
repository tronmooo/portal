// @vitest-environment jsdom
//
// Regression tests for the Habits popup's completion buttons.
//
// User report (2026-07-25): "I marked one habit done. I marked the second
// habit. It wouldn't let me mark it complete." Root cause: every row's check
// button was disabled off the SHARED mutation's `isPending`, so the first
// check-in froze the whole list until the write came back — seconds on a cold
// serverless instance. Second cause: a habit with targetPerDay > 1 ("Go to the
// bathroom 3× daily") counted a single check-in as complete, so it could never
// actually be completed and un-checking it left the remaining check-ins behind.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Module doubles ───────────────────────────────────────────────────────────
// Deferred request resolution lets a test hold a check-in "in flight" and prove
// the OTHER rows stay live while it hangs.
const calls: { method: string; url: string; body?: any }[] = [];
let gate: { promise: Promise<any>; resolve: (v?: any) => void } | null = null;

const apiRequest = vi.fn(async (method: string, url: string, body?: any) => {
  calls.push({ method, url, body });
  if (gate) await gate.promise;
  return { json: async () => ({}) } as any;
});

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: any[]) => (apiRequest as any)(...args),
  get queryClient() { return testQueryClient; },
}));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(), invalidateDomains: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", vi.fn()],
}));
// The popup seeds its list from the briefing cache; feed it fixtures directly.
let habitFixtures: any[] = [];
vi.mock("@/components/dashboard/popups/useSeededList", () => ({
  useSeededScopedList: () => ({ data: habitFixtures, isPending: false }),
}));

import { HabitsPopup } from "../client/src/components/dashboard/TaskHabitPopups";

let testQueryClient: QueryClient;

const today = new Date().toLocaleDateString("en-CA");
const habit = (over: Partial<any>): any => ({
  id: "h1", name: "Brush teeth", frequency: "daily", targetPerDay: 1,
  currentStreak: 1, checkins: [], ...over,
});

const mount = () => render(
  <QueryClientProvider client={testQueryClient}>
    <HabitsPopup open onClose={() => {}} />
  </QueryClientProvider>
);

beforeEach(() => {
  calls.length = 0;
  gate = null;
  apiRequest.mockClear();
  testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(cleanup);

describe("HabitsPopup completion", () => {
  it("keeps every other habit tappable while one check-in is still in flight", async () => {
    habitFixtures = [
      habit({ id: "h1", name: "Brush teeth" }),
      habit({ id: "h2", name: "Comb hair" }),
      habit({ id: "h3", name: "Daily run" }),
    ];
    let release!: (v?: any) => void;
    gate = { promise: new Promise(res => { release = res; }), resolve: () => release() };

    mount();
    fireEvent.click(screen.getByTestId("habit-toggle-h1"));
    await waitFor(() => expect(calls.length).toBe(1));

    // h1's own button is inert while its write is in flight…
    expect((screen.getByTestId("habit-toggle-h1") as HTMLButtonElement).disabled).toBe(true);
    // …but the rest of the list is NOT — this is the reported bug.
    expect((screen.getByTestId("habit-toggle-h2") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("habit-toggle-h3") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("habit-toggle-h2"));
    fireEvent.click(screen.getByTestId("habit-toggle-h3"));
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.map(c => c.url)).toEqual([
      "/api/habits/h1/checkin", "/api/habits/h2/checkin", "/api/habits/h3/checkin",
    ]);
    release();
  });

  it("posts one check-in per tap and only reads complete at targetPerDay", async () => {
    habitFixtures = [habit({ id: "hb", name: "Go to the bathroom", targetPerDay: 3, currentStreak: 0 })];
    mount();
    // Radix portals the dialog, so assert against the document, not the mount.
    expect(document.body.textContent).toContain("3× daily");
    expect(document.body.textContent).toContain("0/3 today");

    fireEvent.click(screen.getByTestId("habit-toggle-hb"));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/habits/hb/checkin", body: { date: today } });
    // One of three is progress, NOT completion — the row must stay tappable.
    await waitFor(() => expect((screen.getByTestId("habit-toggle-hb") as HTMLButtonElement).disabled).toBe(false));
  });

  it("un-checking a multi-per-day habit clears every check-in logged today", async () => {
    habitFixtures = [habit({
      id: "hb", name: "Go to the bathroom", targetPerDay: 3, currentStreak: 2,
      checkins: [{ id: "c1", date: today }, { id: "c2", date: today }, { id: "c3", date: today }],
    })];
    mount();
    fireEvent.click(screen.getByTestId("habit-toggle-hb"));
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      "DELETE /api/habits/hb/checkin/c1",
      "DELETE /api/habits/hb/checkin/c2",
      "DELETE /api/habits/hb/checkin/c3",
    ]);
  });

  it("does not reorder the list when a habit is checked off", async () => {
    // Ordering ranks on the streak EXCLUDING today, so completing a habit can't
    // shuffle rows out from under the user's next tap.
    habitFixtures = [
      habit({ id: "h1", name: "Alpha", currentStreak: 3, checkins: [{ id: "c1", date: today }] }),
      habit({ id: "h2", name: "Beta", currentStreak: 3, checkins: [] }),
    ];
    mount();
    const order = screen.getAllByTestId(/^habit-toggle-/).map(el => el.getAttribute("data-testid"));
    // Alpha's streak of 3 INCLUDES today; Beta's does not. Ranked on the shared
    // base streak of 2 vs 3, Beta leads — and stays there once Alpha is undone.
    expect(order).toEqual(["habit-toggle-h2", "habit-toggle-h1"]);
  });
});
