// @vitest-environment jsdom
//
// QA 2026-11-24 (live demo account), four findings:
//
//  11. A task created in chat "for 3 PM" showed 3 PM on the Calendar, but the
//      task editor had only a date: no way to see or change the time. The
//      time is the task's own `dueTime` ("HH:MM", wall clock on dueDate) —
//      the editor now reads and writes that same field, sends only what
//      changed (a recurring task's dueDate is never sent for a time edit,
//      O2), and clearing it makes the task all-day ("" — the route's clear).
//  12. Settings → Active Tasks opened the Executive dashboard; a second tap
//      was needed to reach the task list.
//  13. Settings → Documents opened Artifacts unfiltered (notes too); the
//      Documents chip needed a second tap. The tile now links
//      /artifacts?type=documents and the page reads that ?type= (a URL, never
//      stored — Rule 4).
//  14. Six Settings switches (Fast-Path Commands, Email Notifications, …) had
//      no accessible name.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({
  useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1", email: "smoke@example.com" }, signOut: () => {} }),
}));

import TasksPage from "../client/src/pages/tasks";
import SettingsPage from "../client/src/pages/settings";
import ArtifactsPage from "../client/src/pages/artifacts";
import { queryClient, BROWSER_TIMEZONE } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";
import { getUserToday, addDays } from "../shared/timezone";

const SELF = "11111111-1111-4111-8111-111111111111";
const today = getUserToday(BROWSER_TIMEZONE);
const day = addDays(today, 3);
const t = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, title, status: "todo", priority: "medium", linkedProfiles: [SELF], tags: [],
  createdAt: "2026-01-09T20:51:17Z", updatedAt: "2026-01-09T20:51:40Z", ...o,
});
const TASKS = [
  t("timed", "Call the vet", { dueDate: day, dueTime: "15:00" }),
  t("allday", "Buy milk", { dueDate: day }),
  t("weekly", "Mow the lawn", { dueDate: day, dueTime: "09:00", tags: ["recur:weekly"] }),
];
const PROFILES = [{ id: SELF, name: "Me", type: "self", fields: {}, tags: [], linkedProfiles: [], parentProfileId: null }];

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
let writes: { method: string; url: string; body: any }[] = [];

beforeEach(() => {
  queryClient.clear();
  setFilterEveryone();
  writes = [];
  window.location.hash = "#/tasks";
  if (!window.matchMedia) {
    (window as any).matchMedia = (q: string) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    });
  }
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "");
    const p = url.split("?")[0];
    if (init?.method && init.method !== "GET") {
      const body = init.body ? JSON.parse(init.body) : null;
      writes.push({ method: init.method, url: p, body });
      return json({ id: "new", ...(body || {}) });
    }
    if (p === "/api/profiles" || p === "/api/profiles/lite") return json(PROFILES);
    if (p === "/api/tasks") return json(TASKS);
    if (p === "/api/stats") return json({ activeTasks: 7, totalTrackers: 2 });
    if (p === "/api/documents") return json([
      { id: "d1", name: "Lease", title: "Lease", type: "contract", mimeType: "application/pdf", createdAt: "2026-03-20T00:00:00Z", linkedProfiles: [SELF], extractedData: {}, tags: [] },
    ]);
    if (p === "/api/artifacts") return json([
      { id: "a1", title: "Chat note", type: "note", content: "hello", createdAt: "2026-04-01T00:00:00Z", linkedProfiles: [SELF], tags: [], pinned: false, items: [] },
    ]);
    if (p.startsWith("/api/preferences/")) return json({ value: null });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setFilterEveryone(); });

// ── 11. Task editor: the due time ────────────────────────────────────────────

async function openEditor(id: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => ["/tasks", () => {}]) as any}><TasksPage /></Router>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByTestId(`task-edit-trigger-${id}`));
  return screen.findByTestId("dialog-edit-task");
}
const timeInput = (dlg: HTMLElement) => within(dlg).getByLabelText("Due Time") as HTMLInputElement;
const save = (dlg: HTMLElement) => fireEvent.click(within(dlg).getByTestId("button-submit-task"));
const patchesTo = (id: string) => writes.filter(w => w.method === "PATCH" && w.url === `/api/tasks/${id}`);

describe("Task editor edits the time chat and the Calendar use (finding 11)", () => {
  it("shows the stored dueTime and writes only the changed time", async () => {
    const dlg = await openEditor("timed");
    expect(timeInput(dlg).value).toBe("15:00");
    fireEvent.change(timeInput(dlg), { target: { value: "16:30" } });
    save(dlg);
    await waitFor(() => expect(patchesTo("timed")).toHaveLength(1));
    // The time alone: the day is untouched (no zone math can move it).
    expect(patchesTo("timed")[0].body).toEqual({ dueTime: "16:30" });
  });

  it("clearing the time makes the task all-day", async () => {
    const dlg = await openEditor("timed");
    fireEvent.click(within(dlg).getByTestId("button-task-clear-time"));
    expect(timeInput(dlg).value).toBe("");
    save(dlg);
    await waitFor(() => expect(patchesTo("timed")).toHaveLength(1));
    expect(patchesTo("timed")[0].body).toEqual({ dueTime: "" });
  });

  it("adds a time to an all-day task", async () => {
    const dlg = await openEditor("allday");
    expect(timeInput(dlg).value).toBe("");
    fireEvent.change(timeInput(dlg), { target: { value: "08:15" } });
    save(dlg);
    await waitFor(() => expect(patchesTo("allday")).toHaveLength(1));
    expect(patchesTo("allday")[0].body).toEqual({ dueTime: "08:15" });
  });

  it("a recurring task's time edit never sends its dueDate (O2)", async () => {
    const dlg = await openEditor("weekly");
    expect(timeInput(dlg).value).toBe("09:00");
    fireEvent.change(timeInput(dlg), { target: { value: "10:00" } });
    save(dlg);
    await waitFor(() => expect(patchesTo("weekly")).toHaveLength(1));
    const body = patchesTo("weekly")[0].body;
    expect(Object.keys(body)).toEqual(["dueTime"]);
    expect(body.dueTime).toBe("10:00");
  });

  it("clearing the date clears the time with it (a time needs a day)", async () => {
    const dlg = await openEditor("timed");
    fireEvent.change(within(dlg).getByLabelText("Due Date"), { target: { value: "" } });
    expect(timeInput(dlg).disabled).toBe(true);
    save(dlg);
    await waitFor(() => expect(patchesTo("timed")).toHaveLength(1));
    expect(patchesTo("timed")[0].body).toEqual({ dueDate: "", dueTime: "" });
  });
});

// ── 12–14. Settings ──────────────────────────────────────────────────────────

function renderSettings(navigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.location.hash = "#/settings";
  render(
    <QueryClientProvider client={qc}>
      <Router hook={(() => ["/settings", navigate]) as any}><SettingsPage /></Router>
    </QueryClientProvider>,
  );
  return navigate;
}

describe("Settings stat tiles open the list they count (findings 12, 13)", () => {
  it("Active Tasks opens the task list, not the Executive dashboard", async () => {
    const navigate = renderSettings();
    fireEvent.click(await screen.findByTestId("stat-active-tasks"));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toBe("/dashboard/tasks");
  });

  it("Documents opens Artifacts already filtered to documents (query inside the hash)", async () => {
    renderSettings();
    fireEvent.click(await screen.findByTestId("stat-documents"));
    await waitFor(() => expect(window.location.hash).toBe("#/artifacts?type=documents"));
  });
});

describe("Artifacts reads its type filter from the link (finding 13)", () => {
  it("/artifacts?type=documents opens on the Documents chip, without notes", async () => {
    window.location.hash = "#/artifacts?type=documents";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Router hook={(() => ["/artifacts?type=documents", () => {}]) as any}><ArtifactsPage /></Router>
      </QueryClientProvider>,
    );
    await screen.findByTestId("artifact-card-d1");
    expect(screen.getByTestId("filter-documents").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("filter-all").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("artifact-card-a1")).toBeNull();
    // The chip is still the user's: All shows everything again.
    fireEvent.click(screen.getByTestId("filter-all"));
    await screen.findByTestId("artifact-card-a1");
  });

  it("no ?type= opens on All", async () => {
    window.location.hash = "#/artifacts";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Router hook={(() => ["/artifacts", () => {}]) as any}><ArtifactsPage /></Router>
      </QueryClientProvider>,
    );
    await screen.findByTestId("artifact-card-a1");
    expect(screen.getByTestId("filter-all").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Every Settings switch has an accessible name (finding 14)", () => {
  it("names each switch by its visible label", async () => {
    renderSettings();
    await screen.findByTestId("stat-documents");
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThanOrEqual(6);
    for (const sw of switches) {
      const labelledBy = sw.getAttribute("aria-labelledby");
      const name = sw.getAttribute("aria-label")
        || (labelledBy ? document.getElementById(labelledBy)?.textContent : "")
        || (sw.id ? document.querySelector(`label[for="${sw.id}"]`)?.textContent : "");
      expect(name, `switch ${sw.outerHTML.slice(0, 80)} has no name`).toBeTruthy();
    }
    for (const name of [
      "Fast-Path Commands", "Auto-Expense from Documents", "Smart Data Routing",
      "Auto-Create Trackers", "Enable Notifications", "Email Notifications",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }
  });
});
