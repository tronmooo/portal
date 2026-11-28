// @vitest-environment jsdom
//
// A weekly task scheduled on Mondays with ONE date moved to a Wednesday is
// still "weekly on Monday" (O2: a moved occurrence does not re-anchor the
// series). Integrity run 2026-11-28 (ui-planning.task, desktop and phone): the
// Tasks badge read "Repeats weekly on Wednesday" — it took the weekday from the
// moved row's due date instead of its scheduled date (`rfrom:`).
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import TasksPage from "../client/src/pages/tasks";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";

const SELF = "11111111-1111-4111-8111-111111111111";
const base = { tags: [], notes: "", documents: [], linkedProfiles: [], createdAt: "2026-01-09T20:42:00Z", updatedAt: "2026-01-09T20:42:00Z" };
const PROFILES = [{ ...base, id: SELF, name: "Me", type: "self", fields: {}, parentProfileId: null }];
// 2027-03-01 is a Monday; 2027-03-03 a Wednesday.
const TASKS = [{
  id: "ferns", title: "Water the ferns", status: "todo", priority: "medium", linkedProfiles: [SELF],
  dueDate: "2027-03-03", tags: ["recur:weekly", "rfrom:2027-03-01"],
  createdAt: "2026-01-09T20:51:17Z", updatedAt: "2026-01-09T20:51:40Z",
}];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  queryClient.clear();
  setFilterEveryone();
  window.location.hash = "#/tasks";
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const p = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (p === "/api/profiles" || p === "/api/profiles/lite") return json(PROFILES);
    if (p === "/api/tasks") return json(TASKS);
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setFilterEveryone(); });

describe("a repeating task with one date moved", () => {
  it("is labelled with the weekday it is scheduled on, not the one it was moved to", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Router hook={(() => ["/tasks", () => {}]) as any}><TasksPage /></Router>
      </QueryClientProvider>,
    );
    const badge = await screen.findByTestId("badge-task-recurrence-ferns");
    expect(badge.textContent).toMatch(/Monday/);
    expect(badge.textContent).not.toMatch(/Wednesday/);
  });
});
