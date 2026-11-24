// @vitest-environment jsdom
//
// Trackers → Add Entry on a Running tracker (QA, 2026-11-24):
//  · an empty submit showed a "Failed to log entry" toast without saying which
//    field was needed. It now names the field, beside it, and sends nothing;
//  · the six number inputs had no accessible names (the visible labels were
//    not associated). Each input is now named by its label and unit.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import { AddEntryDialog } from "../client/src/pages/trackers";
import { queryClient } from "../client/src/lib/queryClient";

const RUNNING: any = {
  id: "t-run", name: "Running", category: "fitness", unit: "mi", linkedProfiles: [], entries: [], createdAt: "2026-11-01T00:00:00Z",
  fields: [
    { name: "distance", type: "number", unit: "mi", isPrimary: true },
    { name: "duration", type: "number", unit: "min" },
    { name: "pace", type: "number", unit: "min/mi" },
    { name: "speed", type: "number", unit: "mph" },
    { name: "caloriesBurned", type: "number", unit: "kcal" },
    { name: "heartRate", type: "number", unit: "bpm" },
  ],
};

const posts: Array<{ url: string; body: any }> = [];
beforeEach(() => {
  posts.length = 0;
  queryClient.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "e1", values: {}, timestamp: new Date().toISOString() }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderForm() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AddEntryDialog tracker={RUNNING} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("Add Entry form", () => {
  it("names every number input by its label and unit", () => {
    renderForm();
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs).toHaveLength(6);
    for (const name of [/^Distance \(mi\)$/, /^Duration \(min\)$/, /^Pace \(min\/mi\)$/, /^Speed \(mph\)$/, /Calories Burned \(kcal\)/, /Heart Rate \(bpm\)/]) {
      expect(screen.getByRole("spinbutton", { name })).toBeTruthy();
    }
    // Every one of them has a name, not just the ones listed.
    for (const el of inputs) {
      const id = el.getAttribute("id");
      expect(id).toBeTruthy();
      expect(document.querySelector(`label[for="${id}"]`)?.textContent?.trim()).toBeTruthy();
    }
  });

  it("an empty submit names the required field beside it and sends nothing", async () => {
    renderForm();
    fireEvent.click(screen.getByTestId("button-entry-submit"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Distance \(mi\) is required/);
    const distance = screen.getByRole("spinbutton", { name: /^Distance/ });
    expect(distance.getAttribute("aria-invalid")).toBe("true");
    expect(distance.getAttribute("aria-describedby")).toBe(alert.getAttribute("id"));
    expect(posts).toHaveLength(0);
    expect(screen.queryByText("Failed to log entry")).toBeNull();
    // Typing clears the message.
    fireEvent.change(distance, { target: { value: "2" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a filled form posts what was typed", async () => {
    renderForm();
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Distance/ }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Duration/ }), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("button-entry-submit"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toMatch(/\/api\/trackers\/t-run\/entries$/);
    expect(posts[0].body.values).toMatchObject({ distance: 2, duration: 20 });
  });
});
