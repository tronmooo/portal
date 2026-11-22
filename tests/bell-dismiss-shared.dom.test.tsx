// @vitest-environment jsdom
//
// Pre-merge audit, 2026-11-22. A dated alert ("Expired: Home Depot …") and its
// row in the dashboard's Needs Attention now share ONE dismissal. The bell
// used to (a) dismiss whatever notice you opened, which would now silently
// remove that dashboard row, and (b) load the dismissed list once at mount, so
// an alert restored from the dashboard never came back in the bell.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));

const DOC_ID = "doc-exp-doc-hd-expirationDate-2026-11-02";
const NOTES = [
  { id: DOC_ID, type: "document_expiring", severity: "warning", title: "Expired: Home Depot Purchase", message: "expired 20 days ago", entityType: "document", entityId: "doc-hd", dueDate: "2026-11-02" },
  { id: "task-overdue-t1", type: "task_overdue", severity: "warning", title: "Overdue: Call mechanic", message: "was due yesterday", entityType: "task", entityId: "t1" },
];
let stored: string[];
let posts: Array<{ url: string; body: any }>;

beforeEach(() => {
  stored = []; posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, opts?: any) => {
    const u = String(url);
    const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/api/notifications/dismiss")) {
      const ids: string[] = JSON.parse(opts.body).ids;
      posts.push({ url: u, body: { ids } });
      for (const id of ids) if (!stored.includes(id)) stored.push(id);
      return json({ ids: stored });
    }
    if (u.includes("/api/preferences/dismissed_notifications")) return json({ value: JSON.stringify(stored) });
    // The server filters what the account dismissed, as production does.
    if (u.includes("/api/notifications")) return json(NOTES.filter((n) => !stored.includes(n.id)));
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mountBell() {
  const { NotificationBell } = await import("../client/src/components/NotificationBell");
  const { queryClient } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/dashboard", () => {}] as any}><NotificationBell /></Router>
    </QueryClientProvider>,
  );
  return queryClient;
}
const openBell = async () => {
  const trigger = await screen.findByRole("button", { name: /notification/i });
  fireEvent.click(trigger);
  await screen.findByText("Expired: Home Depot Purchase");
};
const KEY = ["/api/preferences/dismissed_notifications"];

describe("the bell and the dashboard share one dismissed list", () => {
  it("opening a dated alert from the bell does not dismiss it", async () => {
    await mountBell();
    await openBell();
    fireEvent.click(screen.getByText("Expired: Home Depot Purchase"));
    await new Promise((r) => setTimeout(r, 150));
    expect(posts).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("opening any other notice still marks it read, as before", async () => {
    await mountBell();
    await openBell();
    fireEvent.click(screen.getByText("Overdue: Call mechanic"));
    await waitFor(() => expect(posts.map((p) => p.body.ids)).toEqual([["task-overdue-t1"]]));
  });

  it("a dismissal made in the bell reaches the shared list at once", async () => {
    const qc = await mountBell();
    await openBell();
    fireEvent.click(screen.getByText("Overdue: Call mechanic"));
    await waitFor(() => expect(qc.getQueryData<string[]>(KEY)).toEqual(["task-overdue-t1"]));
  });

  it("an alert dismissed, then restored, on the dashboard leaves and returns in the bell", async () => {
    const qc = await mountBell();
    await openBell();
    // Dismissed from the dashboard: the shared list changes under the bell.
    stored = [DOC_ID];
    qc.setQueryData(KEY, [DOC_ID]);
    await waitFor(() => expect(screen.queryByText("Expired: Home Depot Purchase")).toBeNull());
    // Restored from the dashboard's Dismissed list.
    stored = [];
    qc.setQueryData(KEY, []);
    await qc.invalidateQueries({ queryKey: ["/api/notifications"] });
    await waitFor(() => expect(screen.queryByText("Expired: Home Depot Purchase")).not.toBeNull());
  });
});
