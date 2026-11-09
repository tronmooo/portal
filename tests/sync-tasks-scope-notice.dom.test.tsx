// @vitest-environment jsdom
//
// 2026-11-09 tutorial report: chat added "Buy milk" and "Call the dentist"
// (both stored, both the user's own), yet the Tasks page read "Nothing on
// your list · 0 active · 0 completed" under a filter chip that said
// "Everyone". A profile scope left over from an earlier screen (Max, the
// pet) was hiding the user's own tasks, and nothing on the page said so.
//
// Rule 4: a filter can't look like deletion. When the scope hides tasks, the
// page names the scope, says the tasks are hidden (not deleted), and offers
// to clear it. The chip reads the same scope the rows were filtered with.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import TasksPage from "../client/src/pages/tasks";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone, setFilterSelected, getProfileFilter } from "../client/src/lib/profileFilter";

const SELF = "11111111-1111-4111-8111-111111111111";
const MAX = "22222222-2222-4222-8222-222222222222";
const base = { tags: [], notes: "", documents: [], createdAt: "2026-11-09T20:42:00Z", updatedAt: "2026-11-09T20:42:00Z" };
const PROFILES = [
  { ...base, id: SELF, name: "Test123", type: "self", fields: {}, linkedProfiles: [], parentProfileId: null },
  { ...base, id: MAX, name: "Max", type: "pet", fields: { birthday: "2020-03" }, linkedProfiles: [], parentProfileId: null },
];
const TASKS = [
  { id: "t1", title: "Buy milk", status: "done", priority: "medium", linkedProfiles: [SELF], tags: [], createdAt: "2026-11-09T20:51:17Z", updatedAt: "2026-11-09T20:51:40Z" },
  { id: "t2", title: "Call the dentist", status: "todo", priority: "medium", dueDate: "2026-11-13", dueTime: "10:00", linkedProfiles: [SELF], tags: [], createdAt: "2026-11-09T20:51:30Z", updatedAt: "2026-11-09T20:51:30Z" },
];

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let requested: string[] = [];

beforeEach(() => {
  queryClient.clear();
  setFilterEveryone();
  requested = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    requested.push(url);
    const p = url.split("?")[0];
    if (p === "/api/profiles" || p === "/api/profiles/lite") return json(PROFILES);
    if (p === "/api/tasks") {
      // The server applies ?profileIds= the same way the page does; answer
      // honestly so a page that asked for a scoped list would get one.
      const ids = new URLSearchParams(url.split("?")[1] || "").get("profileIds");
      if (ids) return json(TASKS.filter(t => t.linkedProfiles.some(id => ids.split(",").includes(id))));
      return json(TASKS);
    }
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setFilterEveryone(); });

function renderTasks() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => ["/tasks", () => {}]) as any}><TasksPage /></Router>
    </QueryClientProvider>,
  );
}

describe("Tasks page: a profile scope never looks like an empty list", () => {
  it("scope left on Max: says the user's tasks are hidden, not deleted, and offers to clear", async () => {
    setFilterSelected([MAX], ["Max"]);
    renderTasks();
    const empty = await screen.findByTestId("tasks-scope-empty");
    expect(empty.textContent).toContain("Max");
    expect(empty.textContent).toMatch(/2 tasks are hidden, not deleted/);
    expect(screen.queryByText("Nothing on your list")).toBeNull();
    // The chip names the scope the rows were filtered with — never "Everyone".
    const page = screen.getByTestId("page-tasks");
    expect(page.textContent).toContain("Max");

    // Clearing the filter shows both tasks.
    await act(async () => { fireEvent.click(screen.getByTestId("tasks-scope-empty-clear")); });
    expect(getProfileFilter().mode).toBe("everyone");
    await waitFor(() => expect(screen.getByText("Call the dentist")).toBeTruthy());
    expect(screen.getByText("Buy milk")).toBeTruthy();
    expect(screen.queryByTestId("tasks-scope-empty")).toBeNull();
  });

  it("some tasks shown, some hidden: a notice counts what the scope hides", async () => {
    const tasks = [...TASKS, { ...TASKS[1], id: "t3", title: "Vet checkup", linkedProfiles: [MAX] }];
    (globalThis.fetch as any).mockImplementation(async (input: any) => {
      const p = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (p === "/api/profiles" || p === "/api/profiles/lite") return json(PROFILES);
      if (p === "/api/tasks") return json(tasks);
      return json([]);
    });
    setFilterSelected([MAX], ["Max"]);
    renderTasks();
    const notice = await screen.findByTestId("tasks-scope-notice");
    expect(notice.textContent).toMatch(/1 of 3/);
    expect(notice.textContent).toContain("Max");
    expect(screen.getByText("Vet checkup")).toBeTruthy();
    expect(screen.queryByText("Call the dentist")).toBeNull();
  });

  it("Everyone: no notice, both tasks listed", async () => {
    renderTasks();
    await waitFor(() => expect(screen.getByText("Call the dentist")).toBeTruthy());
    expect(screen.getByText("Buy milk")).toBeTruthy();
    expect(screen.queryByTestId("tasks-scope-notice")).toBeNull();
    expect(screen.queryByTestId("tasks-scope-empty")).toBeNull();
  });

  it("a timed task shows its time on the row (\"Friday at 10am\" → 10 AM)", async () => {
    renderTasks();
    const time = await screen.findByTestId("text-task-due-time-t2");
    expect(time.textContent).toContain("10 AM");
    expect(screen.queryByTestId("text-task-due-time-t1")).toBeNull();
  });

  it("reads the whole task list, so it can count what a scope hides", async () => {
    setFilterSelected([MAX], ["Max"]);
    renderTasks();
    await screen.findByTestId("tasks-scope-empty");
    const taskReads = requested.filter(u => u.split("?")[0] === "/api/tasks");
    expect(taskReads.length).toBeGreaterThan(0);
    expect(taskReads.every(u => !/profileIds=/.test(u))).toBe(true);
  });
});
