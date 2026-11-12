// @vitest-environment jsdom
//
// Journal free-write autosaves 2 s after typing stops: POST once, then PATCH
// the same draft. Cancelling while that first POST was still in flight reset
// the form, and then the POST's response set the (now empty) form's draft id —
// so the NEXT new entry was PATCHed onto the previous one and replaced its
// text (2026-11-12). A save now belongs to the writing session it started in.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import JournalPage from "../client/src/pages/journal";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
type Write = { method: string; url: string; body: any };
let writes: Write[] = [];
let releaseFirstPost: (() => void) | null = null;
let posts = 0;

beforeEach(() => {
  queryClient.clear();
  setFilterEveryone();
  writes = []; posts = 0; releaseFirstPost = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  (Element.prototype as any).scrollIntoView ??= () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = init?.method || "GET";
    if (url.startsWith("/api/journal") && method !== "GET") {
      writes.push({ method, url, body: init?.body ? JSON.parse(init.body) : null });
      if (method === "POST") {
        const n = ++posts;
        // The first POST hangs until the test lets it go.
        if (n === 1) await new Promise<void>((r) => { releaseFirstPost = r; });
        return json({ id: `entry-${n}`, content: "", mood: "good", tags: [], date: "2026-11-12", createdAt: "2026-11-12T10:00:00Z" });
      }
      return json({ id: url.split("/").pop(), ok: true });
    }
    if (url === "/api/profiles" || url === "/api/profiles/lite") return json([]);
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const type = (text: string) => fireEvent.change(screen.getByTestId("input-journal-free-text"), { target: { value: text } });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("a free-write save belongs to the session it started in", () => {
  it("a new entry written after cancelling mid-autosave is created, not written over the earlier one", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Router><JournalPage /></Router>
      </QueryClientProvider>,
    );
    await waitFor(() => screen.getByTestId("button-new-journal"));

    // Session 1: write, let the autosave POST start, cancel while it hangs.
    click("button-new-journal");
    click("btn-journal-mode-free");
    type("First entry — private thoughts");
    await wait(2200);
    expect(writes.filter((w) => w.method === "POST")).toHaveLength(1);
    click("button-new-journal");            // header button toggles = Cancel
    await act(async () => { releaseFirstPost?.(); await new Promise((r) => setTimeout(r, 50)); });

    // Session 2: a different entry.
    click("button-new-journal");
    click("btn-journal-mode-free");
    type("Second entry — something else entirely");
    await wait(2200);

    const patches = writes.filter((w) => w.method === "PATCH");
    expect(patches.map((w) => `${w.url} ← ${w.body?.content}`)).toEqual([]);
    const created = writes.filter((w) => w.method === "POST").map((w) => w.body.content);
    expect(created).toEqual(["First entry — private thoughts", "Second entry — something else entirely"]);
  }, 20000);
});
