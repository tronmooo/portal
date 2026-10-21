// @vitest-environment jsdom
//
// The Tasks popup, 2026-10-21 rework:
//  - opening it from a task elsewhere (the Upcoming panel, the Tasks card)
//    lands on THAT task — its tab, expanded — instead of the Today list;
//  - a half-typed subtask survives a re-render of the popup (rows were a
//    component declared inside the popup, so every render remounted them);
//  - the stat tiles are the way into their lists.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    apiRequest,
    BROWSER_TIMEZONE: "America/Los_Angeles",
    recoverWedgedQueries: vi.fn(),
  };
});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/showTestData", () => ({ useShowTestData: () => true }));
vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</>, useLocation: () => ["/", vi.fn()] }));

const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const TASKS = [
  { id: "late", title: "Pay parking ticket", status: "todo", priority: "high", dueDate: day(-2), tags: [], linkedProfiles: [] },
  { id: "now", title: "Call the dentist", status: "todo", priority: "medium", dueDate: day(0), tags: [], linkedProfiles: [] },
  { id: "soon", title: "Submit expense report", status: "todo", priority: "high", dueDate: day(3), dueTime: "14:00", tags: [], linkedProfiles: [] },
  { id: "far", title: "Renew car registration", status: "todo", priority: "high", dueDate: day(20), tags: [], linkedProfiles: [] },
];

async function mount(props: Record<string, any> = {}) {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { TasksPopup } = await import("../client/src/components/dashboard/TaskHabitPopups");
  apiRequest.mockImplementation(async (_m: string, url: string) => ({ json: async () => (url.startsWith("/api/tasks") ? TASKS : []) }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><TasksPopup open onClose={() => {}} {...props} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("task-tab-upcoming").textContent).toContain("(2)"));
}

afterEach(() => { cleanup(); apiRequest.mockReset(); });

describe("TasksPopup — lands on the task you tapped", () => {
  it("opens on the Upcoming tab with that task expanded", async () => {
    await mount({ initialTab: "upcoming", focusTaskId: "far" });
    expect(screen.getByTestId("task-tab-upcoming").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("task-detail-far")).toBeTruthy());
  });

  it("says when a task is due in words", async () => {
    await mount({ initialTab: "upcoming" });
    expect(screen.getByTestId("task-due-soon").textContent).toMatch(/· 2:00 PM$/);
    fireEvent.click(screen.getByTestId("task-tab-today"));
    await waitFor(() => expect(screen.getByTestId("task-due-late").textContent).toContain("Overdue 2d"));
    expect(screen.getByTestId("task-due-now").textContent).toContain("Today");
  });

  it("the stat tiles open their list", async () => {
    await mount();
    expect(screen.getByTestId("tasks-stat-overdue").textContent).toContain("1");
    expect(screen.getByTestId("tasks-stat-upcoming").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("tasks-stat-upcoming"));
    expect(screen.getByTestId("task-tab-upcoming").getAttribute("aria-selected")).toBe("true");
  });
});

describe("TasksPopup — rows keep their state across a re-render", () => {
  it("a half-typed subtask is still there after the popup re-renders", async () => {
    await mount({ focusTaskId: "now" });
    await waitFor(() => expect(screen.getByTestId("task-detail-now")).toBeTruthy());
    const input = screen.getByTestId("task-add-subtask") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Find insurance card" } });
    // Any parent state change re-renders the popup — the sort toggle is one.
    fireEvent.click(screen.getByTestId("task-sort"));
    expect((screen.getByTestId("task-add-subtask") as HTMLInputElement).value).toBe("Find insurance card");
    // …and it is the same element, not a fresh one (focus would have dropped).
    expect(screen.getByTestId("task-add-subtask")).toBe(input);
  });
});
