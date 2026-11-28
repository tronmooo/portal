// @vitest-environment jsdom
//
// OWNER REPORT (2026-11-22): "things need to respond when I mark things done —
// they should disappear."
//
// The dashboard used to wait for the server before a row moved, slide it out,
// and drop its "leaving" mark after 400 ms whether or not the refetch had
// landed — so a completed row sat still and then blinked back. And an expired
// document in Needs Attention had no way to be dismissed from the card at all.
//
// Mounted for real: the ExecutiveBriefing against stubbed endpoints.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({
  useAuth: () => ({ getAuthHeader: () => ({}) }),
}));

type Route = (url: string, opts?: any) => { status?: number; body: any; delayMs?: number } | any;
let fetchStub: ReturnType<typeof vi.fn>;
let calls: Array<{ url: string; method: string; body: any }>;

function stubRoutes(routes: Record<string, Route | any>) {
  fetchStub.mockImplementation(async (url: any, opts?: any) => {
    const u = String(url);
    const method = String(opts?.method || "GET");
    let body: any = null;
    try { body = opts?.body ? JSON.parse(opts.body) : null; } catch { body = opts?.body; }
    calls.push({ url: u, method, body });
    // Longest key first, so "/api/notifications/dismissed" is not answered by
    // the "/api/notifications/dismiss" stub.
    const hit = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    const raw = hit ? (typeof routes[hit] === "function" ? routes[hit](u, opts) : routes[hit])
      // Every card on screen (quiet mode, the default, hides half of them).
      : u.includes("/api/preferences/exec_card_prefs") ? { value: JSON.stringify({ quiet: false, hidden: [], order: [] }) } : [];
    const shaped = raw && typeof raw === "object" && "body" in raw && ("status" in raw || "delayMs" in raw)
      ? raw : { status: 200, body: raw };
    if (shaped.delayMs) await new Promise((r) => setTimeout(r, shaped.delayMs));
    return new Response(JSON.stringify(shaped.body), {
      status: shaped.status ?? 200, headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(async () => {
  // Each test is a fresh session. The app's client sends an identical write
  // still in flight only once (lib/queryClient.ts apiRequest), so the previous
  // test's slow PATCH of the same task would otherwise answer this test's.
  (await import("../client/src/lib/queryClient")).abandonInFlightWrites();
  calls = [];
  fetchStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
  try { localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount(enhanced: any) {
  const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
  // The app's own client: the briefing's mutations write through it.
  const { queryClient } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient as unknown as QueryClient}>
      <Router hook={() => ["/dashboard", () => {}] as any}>
        <ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={{}} enhanced={enhanced} />
      </Router>
    </QueryClientProvider>,
  );
  await waitFor(() => { expect(screen.getByTestId("exec-card-attention")).toBeTruthy(); });
}

const today = () => new Date().toLocaleDateString("en-CA");
const EMPTY = { financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] };

describe("Tasks card: a ticked task leaves on the tap", () => {
  const tasks = () => [
    { id: "t1", title: "Call mechanic", status: "open", dueDate: today() },
    { id: "t2", title: "Renew gym", status: "open", dueDate: today() },
  ];

  it("is gone while the save is still in flight, and counts as done", async () => {
    // The server takes its time; the list endpoint keeps answering with the
    // task still open (a refetch that has not caught up).
    stubRoutes({
      "/api/tasks": (_u: string, opts: any) =>
        opts?.method === "PATCH" ? { status: 200, body: {}, delayMs: 1500 } : tasks(),
    });
    await mount(EMPTY);
    const card = () => screen.getByTestId("exec-card-tasks");
    fireEvent.click(await screen.findByTestId("exec-task-complete-t1"));

    await waitFor(() => { expect(screen.queryByTestId("exec-task-complete-t1")).toBeNull(); }, { timeout: 1200 });
    // The save has been sent and has NOT answered yet: the row left on the tap.
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/api/tasks/t1"))).toBe(true);
    expect(card().textContent).not.toContain("Call mechanic");
    expect(card().textContent).toContain("Renew gym");
    // Left 1 · Overdue 0 · Done 1.
    const stats = within(card()).getByTestId("exec-tasks-stats").textContent || "";
    expect(stats.replace(/\s+/g, "")).toMatch(/^1.*0.*1/);
  });

  it("writes once however many times the leaving row is tapped", async () => {
    stubRoutes({
      "/api/tasks": (_u: string, opts: any) =>
        opts?.method === "PATCH" ? { status: 200, body: {}, delayMs: 600 } : tasks(),
    });
    await mount(EMPTY);
    const circle = await screen.findByTestId("exec-task-complete-t1");
    fireEvent.click(circle); fireEvent.click(circle); fireEvent.click(circle);
    await waitFor(() => { expect(screen.queryByTestId("exec-task-complete-t1")).toBeNull(); }, { timeout: 1200 });
    expect(calls.filter((c) => c.method === "PATCH" && c.url.includes("/api/tasks/t1"))).toHaveLength(1);
  });

  it("comes back when the save fails", async () => {
    stubRoutes({
      "/api/tasks": (_u: string, opts: any) =>
        opts?.method === "PATCH" ? { status: 500, body: { error: "nope" }, delayMs: 500 } : tasks(),
    });
    await mount(EMPTY);
    fireEvent.click(await screen.findByTestId("exec-task-complete-t1"));
    await waitFor(() => { expect(screen.queryByTestId("exec-task-complete-t1")).toBeNull(); }, { timeout: 1200 });
    await waitFor(() => { expect(screen.queryByTestId("exec-task-complete-t1")).not.toBeNull(); }, { timeout: 4000 });
    expect(screen.getByTestId("exec-card-tasks").textContent).toContain("Call mechanic");
  });
});

describe("Needs Attention: an expired document can be dismissed from the card", () => {
  const doc = {
    documentId: "doc-hd", ruleId: "document:doc-hd:expirationdate:expiration",
    documentName: "Home Depot Purchase — Expiration", name: "Home Depot Purchase",
    fieldName: "expirationDate", fieldPath: "expirationDate", sourceEntityType: "document",
    ruleType: "expiration", expirationDate: "2026-11-02", daysUntil: -20, status: "expired",
  };
  const ID = "doc-exp-doc-hd-expirationDate-2026-11-02";
  // The alert the server raises for the same date — the shape that used to
  // take the dismissed row's place.
  const twin = {
    id: ID, type: "document_expiring", entityType: "document", entityId: "doc-hd", severity: "warning",
    title: "Expired: Home Depot Purchase", message: "Home Depot Purchase expired 20 days ago", dueDate: "2026-11-02",
  };
  const enhanced = { financeSnapshot: { upcomingBills: [] }, expiringDocuments: [doc] };

  function routes(stored: string[]) {
    return {
      "/api/notifications/dismiss": (_u: string, opts: any) => {
        for (const id of JSON.parse(opts.body).ids) if (!stored.includes(id)) stored.push(id);
        return { status: 200, body: { ids: stored }, delayMs: 400 };
      },
      "/api/notifications/restore": (_u: string, opts: any) => {
        const drop: string[] = JSON.parse(opts.body).ids;
        for (const id of drop) { const at = stored.indexOf(id); if (at >= 0) stored.splice(at, 1); }
        return { status: 200, body: { ids: stored } };
      },
      "/api/notifications/dismissed": () => ({
        status: 200,
        body: { alerts: stored.includes(ID) ? [{ id: ID, title: "Expired: Home Depot Purchase", message: "expired 20 days ago" }] : [] },
      }),
      "/api/preferences/dismissed_notifications": () => ({ status: 200, body: { value: JSON.stringify(stored) } }),
      // The server keeps raising the alert until its own filter catches up;
      // the dashboard must not show it for a dismissed date either way.
      "/api/notifications": () => (stored.includes(ID) ? [] : [twin]),
    };
  }

  it("shows the date once, with a Dismiss button", async () => {
    stubRoutes(routes([]));
    await mount(enhanced);
    const card = screen.getByTestId("exec-card-attention");
    await waitFor(() => { expect(card.textContent).toContain("Home Depot Purchase"); });
    expect(within(card).getAllByTestId(/^exec-item-/).filter((n) => /^exec-item-(doc|alert):/.test(n.getAttribute("data-testid") || ""))).toHaveLength(1);
    expect(within(card).getByTestId(`exec-dismiss-doc:${doc.ruleId}`)).toBeTruthy();
  });

  it("Dismiss removes it at once, stores the shared id, and neither shape returns", async () => {
    const stored: string[] = [];
    stubRoutes(routes(stored));
    await mount(enhanced);
    const card = screen.getByTestId("exec-card-attention");
    fireEvent.click(await within(card).findByTestId(`exec-dismiss-doc:${doc.ruleId}`));

    // Gone before the server has answered (the stub takes 400 ms).
    await waitFor(() => { expect(card.textContent).not.toContain("Home Depot Purchase"); }, { timeout: 300 });
    await waitFor(() => { expect(stored).toEqual([ID]); });
    const sent = calls.find((c) => c.method === "POST" && c.url.includes("/api/notifications/dismiss"));
    expect(sent?.body).toEqual({ ids: [ID] });
    // Nothing was written to this browser: the dismissal is the server's.
    expect(localStorage.getItem("portol_doc_snooze_v1")).toBeNull();

    // After every refetch has landed: still gone, in both shapes.
    await new Promise((r) => setTimeout(r, 900));
    expect(card.textContent).not.toContain("Home Depot Purchase");
    expect(within(card).queryByTestId(`exec-item-alert:${ID}`)).toBeNull();
    expect(screen.getByTestId("exec-attention-clear")).toBeTruthy();
  });

  it("the Dismissed list names it and Restore brings it back", async () => {
    const stored: string[] = [ID];
    stubRoutes(routes(stored));
    await mount(enhanced);
    const card = screen.getByTestId("exec-card-attention");
    await waitFor(() => { expect(screen.getByTestId("exec-attention-clear")).toBeTruthy(); });

    fireEvent.click(screen.getByTestId("attention-filters-toggle"));
    const restoreBtn = await screen.findByTestId(`dismissed-alert-restore-${ID}`);
    expect(screen.getByTestId("dismissed-alerts").textContent).toContain("Expired: Home Depot Purchase");
    // Opening the list wrote nothing (Rule 3).
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    fireEvent.click(restoreBtn);
    await waitFor(() => { expect(stored).toEqual([]); });
    await waitFor(() => { expect(card.textContent).toContain("Home Depot Purchase"); });
    await waitFor(() => { expect(screen.queryByTestId(`dismissed-alert-restore-${ID}`)).toBeNull(); });
  });

  it("says it could not load the list rather than claiming nothing was dismissed", async () => {
    const r = routes([ID]);
    stubRoutes({ ...r, "/api/notifications/dismissed": () => ({ status: 500, body: { error: "down" } }) });
    await mount(enhanced);
    fireEvent.click(screen.getByTestId("attention-filters-toggle"));
    await waitFor(() => { expect(screen.getByTestId("dismissed-alerts-error")).toBeTruthy(); }, { timeout: 6000 });
    expect(screen.queryByTestId("dismissed-alerts-empty")).toBeNull();
  });
});
