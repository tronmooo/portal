// @vitest-environment jsdom
//
// One-time tasks are not schedules.
//
// A multi-action chat message ("plan my kitchen remodel … and remind me daily
// to stretch") used to file EVERY task it created as a daily chore, because
// create_task sniffed cadence out of the whole user message rather than the
// task's own words. Six one-off to-dos — obtain quotes, purchase materials,
// renew passport, call the dentist — showed up under "Recurring · Repeats
// daily". These tests pin both halves of the fix: the detector only reads the
// task's own words, and the popup gives one-time tasks their own tab.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { detectRecurrenceFreq, isRecurring, parseRecurrence, humanSummary } from "../shared/recurrence";

describe("detectRecurrenceFreq — cadence comes from the task's own words", () => {
  it("returns undefined for one-time tasks", () => {
    for (const title of [
      "Call the dentist",
      "Renew passport",
      "Kitchen Remodel — Obtain quotes from contractors",
      "Kitchen Remodel — Purchase materials",
      "Kitchen Remodel — Schedule contractor walkthrough",
      "Book flights to Denver",
    ]) {
      expect(detectRecurrenceFreq(title), title).toBeUndefined();
    }
  });

  it("does not treat a one-off deadline that names a time unit as a schedule", () => {
    expect(detectRecurrenceFreq("Renew passport (due 45 days before expiration)")).toBeUndefined();
    expect(detectRecurrenceFreq("Oil change — Honda (every 5,000 miles)")).toBeUndefined();
  });

  it("still reads a real cadence off the recurrence arg or the title", () => {
    expect(detectRecurrenceFreq("daily")).toBe("daily");
    expect(detectRecurrenceFreq("Water the plants weekly")).toBe("weekly");
    expect(detectRecurrenceFreq("Pay rent monthly")).toBe("monthly");
    expect(detectRecurrenceFreq("Change smoke alarm batteries every year")).toBe("yearly");
    expect(detectRecurrenceFreq("Standup every weekday")).toBe("weekdays");
    expect(detectRecurrenceFreq("Check tire pressure every 3 days")).toBe("every-3-days");
    expect(detectRecurrenceFreq("Trash out every 2 weeks")).toBe("biweekly"); // same cadence, legacy token
    expect(detectRecurrenceFreq("Deep clean every 3 weeks")).toBe("every-3-weeks");
    expect(detectRecurrenceFreq("Take meds every day")).toBe("daily");
  });

  it("empty input is not a schedule", () => {
    expect(detectRecurrenceFreq("")).toBeUndefined();
    expect(detectRecurrenceFreq("   ")).toBeUndefined();
    expect(detectRecurrenceFreq(undefined as any)).toBeUndefined();
  });

  // The create_task call site builds its text from `${recurrence} ${title}` —
  // the user's message is deliberately NOT in there.
  it("a sibling task's cadence cannot leak into a one-off", () => {
    const userMessage = "plan my kitchen remodel and remind me daily to stretch";
    const title = "Kitchen Remodel — Purchase materials";
    expect(detectRecurrenceFreq(`${""} ${title}`)).toBeUndefined();
    // …and the old, message-wide input is exactly what produced the bug.
    expect(detectRecurrenceFreq(`${title} ${userMessage}`)).toBe("daily");
  });

  it("an untagged task reads as one-time everywhere", () => {
    expect(isRecurring([])).toBe(false);
    expect(isRecurring(["cat:home", "prio:critical"])).toBe(false);
    expect(humanSummary(parseRecurrence(["cat:home"]))).toBe("Does not repeat");
  });
});

// ── UI: the One-time tab ─────────────────────────────────────────────────────

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

const today = new Date().toLocaleDateString("en-CA");
const dayFromNow = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };

const TASKS = [
  // The four one-offs the AI mis-filed as daily chores, now correctly untagged.
  { id: "t1", title: "Kitchen Remodel — Purchase materials", status: "todo", priority: "medium", dueDate: dayFromNow(29), tags: [], linkedProfiles: [] },
  { id: "t2", title: "Renew passport", status: "todo", priority: "high", dueDate: dayFromNow(5), tags: [], linkedProfiles: [] },
  { id: "t3", title: "Call the dentist", status: "todo", priority: "high", dueDate: today, tags: [], linkedProfiles: [] },
  { id: "t4", title: "Return the library book", status: "todo", priority: "low", dueDate: dayFromNow(-3), tags: [], linkedProfiles: [] },
  { id: "t5", title: "Buy a housewarming gift", status: "todo", priority: "low", tags: [], linkedProfiles: [] },
  // A genuine schedule stays a schedule.
  { id: "t6", title: "Water the plants", status: "todo", priority: "medium", dueDate: today, tags: ["recur:weekly"], linkedProfiles: [] },
];

async function renderTasksPopup() {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { TasksPopup } = await import("../client/src/components/dashboard/TaskHabitPopups");
  apiRequest.mockImplementation(async (_m: string, url: string) => ({
    json: async () => (url.startsWith("/api/tasks") ? TASKS : []),
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TasksPopup open onClose={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("task-tab-onetime")).toBeTruthy());
}

afterEach(() => { cleanup(); apiRequest.mockReset(); });

describe("TasksPopup — One-time vs Recurring", () => {
  it("counts one-time tasks separately from recurring ones", async () => {
    await renderTasksPopup();
    await waitFor(() => expect(screen.getByTestId("task-tab-onetime").textContent).toContain("(5)"));
    expect(screen.getByTestId("task-tab-recurring").textContent).toContain("(1)");
  });

  it("the One-time tab lists every non-repeating task, grouped by due date", async () => {
    await renderTasksPopup();
    fireEvent.click(screen.getByTestId("task-tab-onetime"));
    await waitFor(() => expect(screen.getByTestId("section-onetime-overdue")).toBeTruthy());

    expect(screen.getByTestId("section-onetime-overdue").textContent).toContain("Return the library book");
    expect(screen.getByTestId("section-onetime-today").textContent).toContain("Call the dentist");
    expect(screen.getByTestId("section-onetime-later").textContent).toContain("Renew passport");
    expect(screen.getByTestId("section-onetime-later").textContent).toContain("Kitchen Remodel — Purchase materials");
    // An undated one-off has a home instead of only showing up under Today.
    expect(screen.getByTestId("section-onetime-undated").textContent).toContain("Buy a housewarming gift");
  });

  it("keeps the schedule off the One-time tab and the one-offs off Recurring", async () => {
    await renderTasksPopup();
    fireEvent.click(screen.getByTestId("task-tab-onetime"));
    await waitFor(() => expect(screen.getByTestId("section-onetime-today")).toBeTruthy());
    expect(screen.queryByTestId("task-card-t6")).toBeNull();

    fireEvent.click(screen.getByTestId("task-tab-recurring"));
    await waitFor(() => expect(screen.getByTestId("task-card-t6")).toBeTruthy());
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
      expect(screen.queryByTestId(`task-card-${id}`), id).toBeNull();
    }
    // …and the Recurring tab says how to move a mis-filed task out.
    expect(screen.getByTestId("recurring-tab-hint").textContent).toContain("End repeat");
  });
});
