// @vitest-environment jsdom
//
// Journal tutorial QA (2026-11-20), the Journal page:
//
//   4. Saving a manual entry replaced the entry the day already had.
//   5. No date picker; the mood buttons only existed in Guided mode, so a
//      free-write entry came out with a mood nobody picked.
//   8. (Info tab) "Last 18h ago" for an entry saved minutes earlier.
//
// Renders the real page and asserts the requests the composer sends.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { getUserToday } from "../shared/timezone";

const { apiRequest, calls, toast } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  calls: [] as Array<{ method: string; url: string; body: any }>,
  toast: vi.fn(),
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/useProfileScope", () => ({
  useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }),
  useActiveCreateProfileId: () => "",
}));
vi.mock("@/hooks/useRecordHighlight", () => ({ useRecordHighlight: () => {} }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}), invalidateDomains: vi.fn(async () => {}) }));

import JournalPage from "../client/src/pages/journal";

const TODAY = getUserToday("America/Los_Angeles");
const CHAT_ENTRY = {
  id: "j-chat", date: TODAY, mood: "bad", content: "I'm feeling frustrated and overwhelmed with work today.",
  tags: [], linkedProfiles: [], createdAt: new Date().toISOString(),
};
let existing: any[] = [];

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function renderPage() {
  const hook = () => ["/journal", vi.fn()] as [string, (to: string) => void];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Router hook={hook as any}><JournalPage /></Router></QueryClientProvider>);
}
const wrote = (method: string, urlPart: string) => calls.filter((c) => c.method === method && c.url.includes(urlPart));

beforeEach(() => {
  calls.length = 0;
  existing = [];
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (method === "GET" && url.startsWith("/api/journal")) return json(existing);
    if (method === "GET" && url.startsWith("/api/profiles")) return json([]);
    // The server joins a second write for a day onto that day's entry.
    if (method === "POST" && url === "/api/journal") {
      const hit = existing.find((e) => e.date === (body.entryDate || TODAY));
      return hit ? json({ ...hit, appended: true }) : json({ id: "j-new", date: body.entryDate || TODAY, mood: body.mood || "neutral", content: body.content, appended: false }, 201);
    }
    return json({ ok: true });
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openFreeWrite() {
  renderPage();
  await waitFor(() => expect(screen.getByTestId("button-new-journal")).toBeTruthy());
  fireEvent.click(screen.getByTestId("button-new-journal"));
  fireEvent.click(screen.getByTestId("btn-journal-mode-free"));
}

describe("free write", () => {
  it("has a date picker and the mood buttons", async () => {
    await openFreeWrite();
    expect((screen.getByTestId("input-journal-date") as HTMLInputElement).value).toBe(TODAY);
    expect(screen.getByTestId("button-mood-good")).toBeTruthy();
    expect(screen.getByTestId("journal-mood-source").textContent).toMatch(/detected from what you write/);
  });

  it("sends no mood unless one was picked, and files the entry under the chosen day", async () => {
    await openFreeWrite();
    fireEvent.change(screen.getByTestId("input-journal-date"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: "Quiet day, read a book." } });
    fireEvent.click(screen.getByTestId("button-save-journal-free"));
    await waitFor(() => expect(wrote("POST", "/api/journal")).toHaveLength(1));
    const body = wrote("POST", "/api/journal")[0].body;
    expect(body.entryDate).toBe("2026-11-01");
    expect("mood" in body).toBe(false);
  });

  it("a picked mood is sent as picked", async () => {
    await openFreeWrite();
    fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: "Quiet day." } });
    fireEvent.click(screen.getByTestId("button-mood-okay"));
    expect(screen.getByTestId("journal-mood-source").textContent).toMatch(/You picked Okay/);
    fireEvent.click(screen.getByTestId("button-save-journal-free"));
    await waitFor(() => expect(wrote("POST", "/api/journal")).toHaveLength(1));
    expect(wrote("POST", "/api/journal")[0].body.mood).toBe("okay");
  });

  it("says the day already has an entry, and never overwrites it", async () => {
    existing = [CHAT_ENTRY];
    await openFreeWrite();
    await waitFor(() => expect(screen.getByTestId("journal-existing-entry-notice").textContent).toMatch(/added to it/));

    const box = screen.getByTestId("input-journal-free-text");
    fireEvent.change(box, { target: { value: "Walked the dog" } });
    fireEvent.click(screen.getByTestId("button-save-journal-free"));
    await waitFor(() => expect(wrote("POST", "/api/journal")).toHaveLength(1));

    // No request may carry `content` to the existing entry: that is the
    // overwrite. (The composer closes after Save; the autosave path is the
    // same function and is covered by the route test's find/replace.)
    const patches = wrote("PATCH", "/api/journal/j-chat");
    expect(patches.every((c) => !("content" in c.body))).toBe(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Added to that day's entry" })));
  });

  it("autosave after joining an existing entry edits only its own passage", async () => {
    existing = [CHAT_ENTRY];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openFreeWrite();
      const box = screen.getByTestId("input-journal-free-text");
      fireEvent.change(box, { target: { value: "Walked the dog" } });
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() => expect(wrote("POST", "/api/journal")).toHaveLength(1));
      fireEvent.change(box, { target: { value: "Walked the dog and cooked dinner" } });
      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() => expect(wrote("PATCH", "/api/journal/j-chat")).toHaveLength(1));
      const body = wrote("PATCH", "/api/journal/j-chat")[0].body;
      expect(body.find).toBe("Walked the dog");
      expect(body.replace).toBe("Walked the dog and cooked dinner");
      expect("content" in body).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
