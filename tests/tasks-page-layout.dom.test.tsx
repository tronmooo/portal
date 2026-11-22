// @vitest-environment jsdom
//
// 2026-11-21, owner's Tasks redesign (three passes in one day):
//  1. the header read "T." on a phone, four full-size tiles filled half the
//     screen, and the open list was A–Z with nothing marking a late task;
//  2. the cards were one neutral grey;
//  3. tasks were one flat list: nothing showed that "Bill due: Lubi" belongs
//     to the Lubi bill or that "Registration renewal" belongs to the car.
//
// The page is now organised by what a task is ABOUT (shared/task-groups):
// My Tasks / Asset Tasks / Liability Tasks, asset and liability tasks grouped
// under their item, each item opening its own page. Inside a section, open
// tasks run most-urgent first and keep their due bucket's colour.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import TasksPage from "../client/src/pages/tasks";
import { queryClient, BROWSER_TIMEZONE } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";
import { getUserToday, addDays } from "../shared/timezone";
import { countTasksByDay, countOpenDueWithin } from "../shared/task-counts";

const SELF = "11111111-1111-4111-8111-111111111111";
const CAR = "33333333-3333-4333-8333-333333333333";
const BILL = "44444444-4444-4444-8444-444444444444";
const base = { tags: [], notes: "", documents: [], linkedProfiles: [], createdAt: "2026-01-09T20:42:00Z", updatedAt: "2026-01-09T20:42:00Z" };
const PROFILES = [
  { ...base, id: SELF, name: "Test123", type: "self", fields: {}, parentProfileId: null },
  { ...base, id: CAR, name: "Honda CR-V", type: "vehicle", fields: {}, parentProfileId: SELF },
  { ...base, id: BILL, name: "Lubi", type: "subscription", fields: {}, parentProfileId: SELF },
];
const today = getUserToday(BROWSER_TIMEZONE);
const t = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, title, status: "todo", priority: "medium", linkedProfiles: [SELF], tags: [],
  createdAt: "2026-01-09T20:51:17Z", updatedAt: "2026-01-09T20:51:40Z", ...o,
});
// Personal titles are chosen so A–Z order is the REVERSE of due order.
const TASKS = [
  t("soon", "A due next week", { dueDate: addDays(today, 7) }),
  t("undated", "B someday"),
  t("today", "C due today", { dueDate: today }),
  t("late1", "D late a little", { dueDate: addDays(today, -2) }),
  t("late2", "E late a lot", { dueDate: addDays(today, -50) }),
  t("done", "F finished", { status: "done", dueDate: addDays(today, -9) }),
  t("car1", "Registration renewal", { dueDate: addDays(today, 3), linkedProfiles: [SELF, CAR] }),
  t("car2", "Oil change", { linkedProfiles: [CAR] }),
  t("bill1", "Bill due: Lubi", { priority: "high", dueDate: addDays(today, -20), linkedProfiles: [BILL] }),
  t("billdone", "Bill due: Lubi (old)", { status: "done", linkedProfiles: [BILL] }),
];

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
let patches: { url: string; body: any }[] = [];

beforeEach(() => {
  queryClient.clear();
  setFilterEveryone();
  patches = [];
  window.location.hash = "#/tasks";
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    const p = url.split("?")[0];
    if (init?.method && init.method !== "GET") {
      patches.push({ url: p, body: init.body ? JSON.parse(init.body) : null });
      return json({ ok: true });
    }
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
  const page = await screen.findByTestId("page-tasks");
  // Profiles arrive on their own request; the sections settle once they do.
  await within(page).findByTestId("tasks-group-asset");
  return page;
}
const cardIds = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("[data-record-id]")).map(el => el.getAttribute("data-record-id"));
const tid = (root: HTMLElement, id: string) => within(root).getByTestId(id);

describe("Tasks page layout", () => {
  it("has a title, and the header's only control is New Task", async () => {
    const page = await renderTasks();
    const h1 = page.querySelector("h1");
    expect(h1?.textContent).toBe("Tasks");
    const header = h1!.parentElement!.parentElement!;
    const controls = Array.from(header.querySelectorAll("button")).map(b => b.getAttribute("data-testid"));
    expect(controls).toEqual(["button-back", "button-new-task"]);
    // The profile filter is still on the page (Rule 4), below the tabs.
    expect(page.textContent).toContain("Everyone");
  });

  it("files each task under what it is about: mine, an asset, a liability", async () => {
    const page = await renderTasks();
    // Personal tasks: most urgent first, oldest overdue first, undated last.
    expect(cardIds(tid(page, "tasks-group-mine"))).toEqual(["late2", "late1", "today", "soon", "undated"]);
    // A task linked to the car (even beside a person) is the car's.
    expect(cardIds(tid(page, `tasks-item-${CAR}`))).toEqual(["car1", "car2"]);
    expect(cardIds(tid(page, "tasks-group-asset"))).toEqual(["car1", "car2"]);
    // A bill's reminder is the bill's.
    expect(cardIds(tid(page, `tasks-item-${BILL}`))).toEqual(["bill1"]);
    expect(cardIds(tid(page, "tasks-group-liability"))).toEqual(["bill1"]);
    // Every open task is listed exactly once.
    const open = TASKS.filter(x => x.status !== "done").map(x => x.id).sort();
    expect(cardIds(page).slice().sort()).toEqual(open);
  });

  it("names each item, its kind and its task count, and the header opens the item", async () => {
    const page = await renderTasks();
    const car = tid(page, `tasks-item-link-${CAR}`);
    expect(car.textContent).toContain("Honda CR-V");
    expect(car.textContent).toContain("2 tasks · Vehicle");
    expect(tid(page, `tasks-item-link-${BILL}`).textContent).toContain("1 task · Subscription");
    fireEvent.click(car);
    expect(window.location.hash).toBe(`#/profiles/${CAR}`);
    // Navigation writes nothing (Rule 3).
    expect(patches).toEqual([]);
  });

  it("the open badges and the tabs count the rows under them", async () => {
    const page = await renderTasks();
    for (const [kind, n] of [["mine", 5], ["asset", 2], ["liability", 1]] as const) {
      expect(tid(page, `tasks-group-open-${kind}`).textContent).toBe(`${n} open`);
      expect(tid(page, `tab-${kind}`).textContent).toContain(`(${n})`);
      expect(cardIds(tid(page, `tasks-group-rows-${kind}`))).toHaveLength(n);
    }
    expect(tid(page, "tab-all").textContent).toContain("(8)");
  });

  it("a tab shows only its section; All brings the others back", async () => {
    const page = await renderTasks();
    fireEvent.click(tid(page, "tab-liability"));
    expect(cardIds(page)).toEqual(["bill1"]);
    expect(within(page).queryByTestId("tasks-group-mine")).toBeNull();
    expect(tid(page, "tab-liability").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tid(page, "tab-all"));
    expect(cardIds(page)).toHaveLength(8);
  });

  it("completed tasks stay with their section, folded away until asked for", async () => {
    const page = await renderTasks();
    expect(within(page).queryByTestId("card-task-done")).toBeNull();
    const toggle = tid(page, "tasks-group-done-toggle-mine");
    expect(toggle.textContent).toContain("Show 1 completed");
    fireEvent.click(toggle);
    expect(tid(page, "card-task-done").getAttribute("data-tone")).toBe("done");
    // The bill's finished reminder is under Liabilities, not under Mine.
    expect(within(tid(page, "tasks-group-mine")).queryByTestId("card-task-billdone")).toBeNull();
    fireEvent.click(tid(page, "tasks-group-done-toggle-liability"));
    expect(within(tid(page, "tasks-group-liability")).getByTestId("card-task-billdone")).toBeTruthy();
  });

  it("a section collapses and reopens", async () => {
    const page = await renderTasks();
    const toggle = tid(page, "tasks-group-toggle-mine");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(page).queryByTestId("card-task-late1")).toBeNull();
    // The badge still says what the collapsed section holds.
    expect(tid(page, "tasks-group-open-mine").textContent).toBe("5 open");
    fireEvent.click(toggle);
    expect(tid(page, "card-task-late1")).toBeTruthy();
  });

  it("the tiles count the same list the rows are cut from", async () => {
    const page = await renderTasks();
    const c = countTasksByDay(TASKS, today, BROWSER_TIMEZONE);
    expect(c.overdue).toBe(3);
    const week = countOpenDueWithin(TASKS, today, addDays(today, 6));
    expect(week).toBe(2);
    const value = (id: string) => tid(page, id).querySelector(".metric-value")?.textContent;
    expect(value("tasks-summary-overdue")).toBe(String(c.overdue));
    expect(value("tasks-summary-today")).toBe(String(c.dueToday));
    expect(value("tasks-summary-this-week")).toBe(String(week));
    expect(value("tasks-summary-done-today")).toBe(String(c.doneToday));
    expect(page.querySelectorAll('[data-tone="overdue"]')).toHaveLength(c.overdue);
    expect(page.querySelectorAll('[data-tone="dueToday"]')).toHaveLength(c.dueToday);
  });

  it("a tile brings its rows back when a tab or a collapsed section was hiding them", async () => {
    const page = await renderTasks();
    fireEvent.click(tid(page, "tab-asset"));
    expect(within(page).queryByTestId("card-task-late1")).toBeNull();
    fireEvent.click(tid(page, "tasks-summary-overdue"));
    expect(tid(page, "card-task-late1")).toBeTruthy();
    expect(tid(page, "card-task-bill1")).toBeTruthy();
  });

  it("a row keeps its due bucket's colour, and only a late date is flagged", async () => {
    const page = await renderTasks();
    const card = (id: string) => tid(page, `card-task-${id}`);
    expect(["late1", "today", "soon", "undated"].map(id => card(id).getAttribute("data-tone")))
      .toEqual(["overdue", "dueToday", "upcoming", "undated"]);
    const accents = ["late1", "today", "soon", "undated"].map(id => card(id).style.getPropertyValue("--accent-hsl"));
    expect(accents.every(a => /^\d+ \d+% \d+%$/.test(a))).toBe(true);
    expect(new Set(accents).size).toBe(4);
    const flag = (id: string) => tid(page, `btn-task-due-${id}`).getAttribute("data-overdue");
    expect(flag("late1")).toBe("true");
    expect(flag("bill1")).toBe("true");
    expect(flag("today")).toBeNull();
    expect(flag("soon")).toBeNull();
  });

  it("each section is a tracker-style panel with its own colour", async () => {
    const page = await renderTasks();
    const panels = ["mine", "asset", "liability"].map(k => tid(page, `tasks-group-${k}`));
    for (const p of panels) {
      expect(p.className).toContain("td-hero");
      expect(p.className).toContain("td-scope");
    }
    expect(new Set(panels.map(p => p.style.getPropertyValue("--td-hs"))).size).toBe(3);
    // Each panel carries its colour on its leading edge too.
    for (const p of panels) expect(p.style.borderLeft).toContain("3px solid");
  });

  it("checking off a bill's reminder completes the task and offers the bill, writing nothing else", async () => {
    const page = await renderTasks();
    fireEvent.click(tid(page, "checkbox-task-bill1"));
    await waitFor(() => expect(patches.length).toBe(1));
    // The only write is the task's own status: no payment is recorded by the
    // checkbox (Auto Pay rule A1).
    expect(patches).toEqual([{ url: "/api/tasks/bill1", body: { status: "done" } }]);
  });
});
