// @vitest-environment jsdom
//
// 2026-11-21 owner report (phone screenshot of /tasks): the header read "T."
// because the profile filter and New Task shared the title's row; four
// full-size stat tiles filled half the screen; and the open list was A–Z, so
// a bill 52 days late sat under one due next month with nothing marking it
// late. The page now has the standard header (title + one action), the dense
// tiles, and open tasks grouped by when they are due — the same buckets the
// tiles count (shared/task-counts openTaskBucket).
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import TasksPage from "../client/src/pages/tasks";
import { queryClient, BROWSER_TIMEZONE } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";
import { getUserToday, addDays } from "../shared/timezone";
import { countTasksByDay, openTaskBucket } from "../shared/task-counts";

const SELF = "11111111-1111-4111-8111-111111111111";
const base = { tags: [], notes: "", documents: [], createdAt: "2026-01-09T20:42:00Z", updatedAt: "2026-01-09T20:42:00Z" };
const PROFILES = [{ ...base, id: SELF, name: "Test123", type: "self", fields: {}, linkedProfiles: [], parentProfileId: null }];
const today = getUserToday(BROWSER_TIMEZONE);
const t = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, title, status: "todo", priority: "medium", linkedProfiles: [SELF], tags: [],
  createdAt: "2026-01-09T20:51:17Z", updatedAt: "2026-01-09T20:51:40Z", ...o,
});
// Titles are chosen so A–Z order is the REVERSE of due order.
const TASKS = [
  t("soon", "A due next week", { dueDate: addDays(today, 7) }),
  t("undated", "B someday" ),
  t("today", "C due today", { dueDate: today }),
  t("late1", "D late a little", { dueDate: addDays(today, -2) }),
  t("late2", "E late a lot", { dueDate: addDays(today, -50) }),
  t("done", "F finished", { status: "done", dueDate: addDays(today, -9) }),
];

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  queryClient.clear();
  setFilterEveryone();
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const p = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (p === "/api/profiles" || p === "/api/profiles/lite") return json(PROFILES);
    if (p === "/api/tasks") return json(TASKS);
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setFilterEveryone(); });

async function renderTasks() {
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => ["/tasks", () => {}]) as any}><TasksPage /></Router>
    </QueryClientProvider>,
  );
  return await screen.findByTestId("page-tasks");
}
const cardIds = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("[data-record-id]")).map(el => el.getAttribute("data-record-id"));

describe("Tasks page layout", () => {
  it("has a title, and the header's only control is New Task", async () => {
    const page = await renderTasks();
    const h1 = page.querySelector("h1");
    expect(h1?.textContent).toBe("Tasks");
    const header = h1!.parentElement!.parentElement!;
    const controls = Array.from(header.querySelectorAll("button")).map(b => b.getAttribute("data-testid"));
    expect(controls).toEqual(["button-back", "button-new-task"]);
    // The profile filter is still on the page (Rule 4), on the toolbar.
    expect(within(page).getByTestId("task-tab-filters").parentElement!.textContent).toContain("Everyone");
  });

  it("groups open tasks by due bucket, most urgent first, oldest overdue first", async () => {
    const page = await renderTasks();
    const open = within(page).getByTestId("tasks-open");
    expect(cardIds(open)).toEqual(["late2", "late1", "today", "soon", "undated"]);
    const sections = Array.from(open.querySelectorAll("section")).map(s => s.getAttribute("data-testid"));
    expect(sections).toEqual(["tasks-section-overdue", "tasks-section-dueToday", "tasks-section-upcoming", "tasks-section-undated"]);
    expect(cardIds(within(open).getByTestId("tasks-section-overdue"))).toEqual(["late2", "late1"]);
  });

  it("a tile's number is the number of rows under its heading", async () => {
    const page = await renderTasks();
    const c = countTasksByDay(TASKS, today, BROWSER_TIMEZONE);
    expect(c.overdue).toBe(2);
    for (const [tile, bucket, n] of [["overdue", "overdue", c.overdue], ["today", "dueToday", c.dueToday], ["upcoming", "upcoming", c.upcoming]] as const) {
      const value = within(page).getByTestId(`tasks-summary-${tile}`).querySelector(".metric-value");
      expect(value?.textContent).toBe(String(n));
      expect(cardIds(within(page).getByTestId(`tasks-section-${bucket}`))).toHaveLength(n);
    }
    expect(openTaskBucket(TASKS[1], today)).toBe("undated");
  });

  it("marks an overdue date, and only an overdue one", async () => {
    const page = await renderTasks();
    const flag = (id: string) => within(page).getByTestId(`btn-task-due-${id}`).getAttribute("data-overdue");
    expect(flag("late1")).toBe("true");
    expect(flag("late2")).toBe("true");
    expect(flag("today")).toBeNull();
    expect(flag("soon")).toBeNull();
    // A completed task with a past date is finished, not late.
    expect(flag("done")).toBeNull();
  });

  // 2026-11-21 follow-up: the cards were all the same neutral grey. Each one
  // now carries its bucket's colour the way a tracker card carries its kind's
  // (accentScope → --accent-hsl / --td-hs on a .td-scope bubble).
  it("a card is tinted with its bucket's colour, like a tracker card", async () => {
    const page = await renderTasks();
    const card = (id: string) => within(page).getByTestId(`card-task-${id}`);
    const tones = ["late1", "today", "soon", "undated", "done"].map(id => card(id).getAttribute("data-tone"));
    expect(tones).toEqual(["overdue", "dueToday", "upcoming", "undated", "done"]);
    const accents = ["late1", "today", "soon", "undated", "done"].map(id => card(id).style.getPropertyValue("--accent-hsl"));
    expect(accents.every(a => /^\d+ \d+% \d+%$/.test(a))).toBe(true);
    expect(new Set(accents).size).toBe(5);
    expect(card("late1").style.getPropertyValue("--accent-hsl")).toBe(card("late2").style.getPropertyValue("--accent-hsl"));
    expect(card("late1").className).toContain("td-scope");
    expect(card("late1").className).toContain("bubble");
  });

  it("a tile brings its rows back when the tab was hiding them", async () => {
    const page = await renderTasks();
    fireEvent.click(within(page).getByTestId("tab-completed"));
    expect(within(page).queryByTestId("tasks-open")).toBeNull();
    fireEvent.click(within(page).getByTestId("tasks-summary-overdue"));
    expect(cardIds(within(page).getByTestId("tasks-section-overdue"))).toEqual(["late2", "late1"]);
  });
});
