// @vitest-environment jsdom
//
// "Edit just this date" on a repeating event saves a standalone copy and then
// skips the original occurrence. The skip was fired from the submit handler,
// before the copy was stored: when the save failed, the user saw "Failed to
// create event" and that date had lost its original as well (2026-11-12).
// The follow-up write now waits for the server to confirm the copy.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import { EventFormDialog } from "../client/src/components/CalendarView";
import { queryClient } from "../client/src/lib/queryClient";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let createStatus = 200;
let posts: any[] = [];

beforeEach(() => {
  queryClient.clear();
  posts = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  (Element.prototype as any).scrollIntoView ??= () => undefined;
  (Element.prototype as any).hasPointerCapture ??= () => false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (url === "/api/events" && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return createStatus === 200 ? json({ id: "e-new", ...JSON.parse(init.body) }) : json({ error: "Database unavailable" }, createStatus);
    }
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function open(onSaved: () => void) {
  render(
    <QueryClientProvider client={queryClient}>
      <EventFormDialog open onClose={() => undefined} initial={{ title: "Standup (moved)" } as any} defaultDate="2026-11-20" onSaved={onSaved} />
    </QueryClientProvider>,
  );
  const form = document.querySelector("form");
  if (!form) throw new Error("event form did not render");
  fireEvent.submit(form);
}

describe("the follow-up write of a one-off edit waits for the save", () => {
  it("does not run when the replacement event fails to save", async () => {
    createStatus = 500;
    const onSaved = vi.fn();
    open(onSaved);
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("runs once the replacement event is stored", async () => {
    createStatus = 200;
    const onSaved = vi.fn();
    open(onSaved);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts[0].title).toBe("Standup (moved)");
    expect(posts[0].date).toBe("2026-11-20");
  });
});
