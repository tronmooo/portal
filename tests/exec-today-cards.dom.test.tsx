// @vitest-environment jsdom
// The Executive tab's Tasks and Habits cards (redesign 2026-11-21).
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Flame } from "lucide-react";
import { TasksCardBody, HabitsCardBody, TASK_CARD_LIMIT, HABIT_CARD_LIMIT } from "../client/src/components/dashboard/ExecTodayCards";

afterEach(cleanup);

const TODAY = "2026-11-21";
const days = (d: any): number | null => {
  const t = String(d || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return Math.round((Date.parse(`${t}T12:00:00Z`) - Date.parse(`${TODAY}T12:00:00Z`)) / 86400000);
};

function tasksProps(over: Partial<React.ComponentProps<typeof TasksCardBody>> = {}): React.ComponentProps<typeof TasksCardBody> {
  return {
    overdue: [{ id: "o1", title: "Renew badge", dueDate: "2026-11-19", priority: "high" }],
    dueToday: [{ id: "t1", title: "Call mechanic", dueDate: TODAY }],
    upcoming: [{ id: "u1", title: "Book flights", dueDate: "2026-11-24" }, { id: "u2", title: "Someday", dueDate: null }],
    doneToday: [{ id: "d1", title: "Water plants", status: "done" }],
    daysFromToday: days,
    formatDue: (du) => `D${du}`,
    busyKeys: new Set(), leavingKeys: new Set(),
    onComplete: vi.fn(), onReopen: vi.fn(), onOpenTask: vi.fn(), onOpenAll: vi.fn(), onAdd: vi.fn(),
    adding: false, emptyState: <p data-testid="empty">No open tasks.</p>,
    ...over,
  };
}

describe("TasksCardBody", () => {
  it("separates overdue, due today, upcoming and completed today", () => {
    render(<TasksCardBody {...tasksProps()} />);
    expect(screen.getByTestId("exec-tasks-group-overdue").textContent).toContain("Renew badge");
    expect(screen.getByTestId("exec-tasks-group-today").textContent).toContain("Call mechanic");
    expect(screen.getByTestId("exec-tasks-group-upcoming").textContent).toContain("Book flights");
    expect(screen.getByTestId("exec-tasks-group-upcoming").textContent).toContain("No due date");
    expect(screen.getByTestId("exec-tasks-group-done").textContent).toContain("Completed today");
    // Counts on the chips match the groups.
    expect(screen.getByTestId("exec-tasks-stat-overdue").textContent).toContain("1");
    expect(screen.getByTestId("exec-tasks-stat-today").textContent).toContain("1");
    expect(screen.getByTestId("exec-tasks-stat-upcoming").textContent).toContain("2");
    expect(screen.getByTestId("exec-tasks-stat-done").textContent).toContain("1");
  });

  it("an overdue row says when it was due and by how much; a high-priority one is marked", () => {
    render(<TasksCardBody {...tasksProps()} />);
    const row = screen.getByTestId("exec-task-row-o1").textContent || "";
    expect(row).toContain("Was due D-2");
    expect(row).toContain("2d late");
    expect(row).toContain("High");
  });

  it("the circle completes, the pencil and the title open the task for editing", () => {
    const p = tasksProps();
    render(<TasksCardBody {...p} />);
    fireEvent.click(screen.getByTestId("exec-task-complete-t1"));
    expect(p.onComplete).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
    fireEvent.click(screen.getByTestId("exec-task-edit-u1"));
    expect(p.onOpenTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: "u1" }), "upcoming");
    fireEvent.click(screen.getByTestId("exec-task-open-o1"));
    expect(p.onOpenTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: "o1" }), "today");
  });

  it("completed tasks are folded away until asked for, and can be reopened", () => {
    const p = tasksProps();
    render(<TasksCardBody {...p} />);
    expect(screen.queryByTestId("exec-task-done-d1")).toBeNull();
    fireEvent.click(screen.getByTestId("exec-tasks-done-toggle"));
    expect(screen.getByTestId("exec-task-done-d1").textContent).toContain("Water plants");
    fireEvent.click(screen.getByTestId("exec-task-reopen-d1"));
    expect(p.onReopen).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
  });

  it("adds a task from one line, on Enter, and clears the box", () => {
    const p = tasksProps();
    render(<TasksCardBody {...p} />);
    const input = screen.getByTestId("exec-task-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Buy stamps  " } });
    fireEvent.submit(input.closest("form")!);
    expect(p.onAdd).toHaveBeenCalledWith("Buy stamps");
    expect(input.value).toBe("");
  });

  it("does not add an empty line", () => {
    const p = tasksProps();
    render(<TasksCardBody {...p} />);
    fireEvent.submit(screen.getByTestId("exec-task-add-input").closest("form")!);
    expect(p.onAdd).not.toHaveBeenCalled();
  });

  it("past the card's limit the rest are counted, never dropped", () => {
    const many = Array.from({ length: TASK_CARD_LIMIT + 3 }, (_, i) => ({ id: `m${i}`, title: `Task ${i}`, dueDate: TODAY }));
    render(<TasksCardBody {...tasksProps({ overdue: [], dueToday: many, upcoming: [], doneToday: [] })} />);
    expect(document.querySelectorAll("[data-testid^='exec-task-row-']")).toHaveLength(TASK_CARD_LIMIT);
    expect(screen.getByTestId("exec-tasks-more").textContent).toContain("3 more open tasks");
    // The chip still counts all of them.
    expect(screen.getByTestId("exec-tasks-stat-today").textContent).toContain(String(TASK_CARD_LIMIT + 3));
  });

  it("with nothing open and nothing done, shows the empty state — and still offers Add", () => {
    render(<TasksCardBody {...tasksProps({ overdue: [], dueToday: [], upcoming: [], doneToday: [] })} />);
    expect(screen.getByTestId("empty")).toBeTruthy();
    expect(screen.getByTestId("exec-task-add-input")).toBeTruthy();
  });

  it("with everything done today, says so instead of 'no tasks'", () => {
    render(<TasksCardBody {...tasksProps({ overdue: [], dueToday: [], upcoming: [] })} />);
    expect(screen.queryByTestId("empty")).toBeNull();
    expect(screen.getByTestId("exec-tasks-all-done").textContent).toContain("Everything done");
  });
});

const habit = (id: string, name: string, checkinsToday: number, extra: Record<string, any> = {}) => ({
  id, name, frequency: "daily", currentStreak: 0,
  checkins: Array.from({ length: checkinsToday }, (_, i) => ({ id: `${id}-c${i}`, date: TODAY, timestamp: `${TODAY}T0${i}:00:00Z` })),
  ...extra,
});

function habitsProps(over: Partial<React.ComponentProps<typeof HabitsCardBody>> = {}): React.ComponentProps<typeof HabitsCardBody> {
  return {
    habitsDueToday: [habit("h1", "Stretch", 1, { currentStreak: 4 }), habit("h2", "Read", 0, { timeOfDay: "evening" })],
    doneCount: 1, notScheduled: 0, bestStreak: 4, todayStr: TODAY, accent: "25 90% 56%",
    busyKeys: new Set(), iconFor: () => Flame,
    onCheckIn: vi.fn(), onOpenAll: vi.fn(), emptyState: <p data-testid="empty">No habits scheduled today.</p>,
    ...over,
  };
}

describe("HabitsCardBody", () => {
  it("shows today's standing: done of total, what is left, a progress bar and the streak", () => {
    render(<HabitsCardBody {...habitsProps()} />);
    expect(screen.getByTestId("exec-habits-summary").textContent).toBe("1 of 2 done today");
    expect(screen.getByTestId("exec-habits-remaining").textContent).toContain("1 left to do");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
    expect(screen.getByTestId("exec-habits-streak").textContent).toContain("4");
  });

  it("each habit has one button: an open one checks in, a finished one is marked done", () => {
    const p = habitsProps();
    render(<HabitsCardBody {...p} />);
    const open = screen.getByTestId("exec-habit-checkin-h2");
    expect(open.getAttribute("aria-pressed")).toBe("false");
    expect(open.textContent).toContain("Check in");
    fireEvent.click(open);
    expect(p.onCheckIn).toHaveBeenCalledWith(expect.objectContaining({ id: "h2" }));

    const done = screen.getByTestId("exec-habit-checkin-h1");
    expect(done.getAttribute("aria-pressed")).toBe("true");
    expect(done.getAttribute("aria-label")).toBe("Stretch — done today");
    // A finished habit is not checked in again from here: it opens the panel.
    fireEvent.click(done);
    expect(p.onCheckIn).toHaveBeenCalledTimes(1);
    expect(p.onOpenAll).toHaveBeenCalledTimes(1);
  });

  it("a row says its state: done today, the time of day, the streak", () => {
    render(<HabitsCardBody {...habitsProps()} />);
    expect(screen.getByTestId("exec-habit-row-h1").textContent).toContain("Done today");
    expect(screen.getByTestId("exec-habit-row-h1").textContent).toContain("4-day streak");
    expect(screen.getByTestId("exec-habit-row-h2").textContent).toContain("Evening");
  });

  it("a several-times-a-day habit shows its count and adds one per tap", () => {
    const p = habitsProps({
      habitsDueToday: [habit("w", "Water", 1, { targetPerDay: 3 })],
      doneCount: 0,
    });
    render(<HabitsCardBody {...p} />);
    expect(screen.getByTestId("exec-habit-row-w").textContent).toContain("1 of 3 today");
    const btn = screen.getByTestId("exec-habit-checkin-w");
    // One of three is not done: the button still checks in.
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(p.onCheckIn).toHaveBeenCalledWith(expect.objectContaining({ id: "w" }));
  });

  it("all done reads as done, not as zero left", () => {
    render(<HabitsCardBody {...habitsProps({ habitsDueToday: [habit("h1", "Stretch", 1)], doneCount: 1 })} />);
    expect(screen.getByTestId("exec-habits-remaining").textContent).toBe("All done for today");
  });

  it("habits past the limit and habits not scheduled today are counted behind one link", () => {
    const many = Array.from({ length: HABIT_CARD_LIMIT + 2 }, (_, i) => habit(`m${i}`, `Habit ${i}`, 0));
    const p = habitsProps({ habitsDueToday: many, doneCount: 0, notScheduled: 3 });
    render(<HabitsCardBody {...p} />);
    expect(document.querySelectorAll("[data-testid^='exec-habit-row-']")).toHaveLength(HABIT_CARD_LIMIT);
    const more = screen.getByTestId("exec-habits-more");
    expect(more.textContent).toContain("2 more habits today");
    expect(more.textContent).toContain("3 not scheduled today");
    fireEvent.click(more);
    expect(p.onOpenAll).toHaveBeenCalled();
  });

  it("with nothing scheduled today, shows the empty state it was given", () => {
    render(<HabitsCardBody {...habitsProps({ habitsDueToday: [], doneCount: 0 })} />);
    expect(screen.getByTestId("empty")).toBeTruthy();
  });
});
