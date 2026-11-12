// @vitest-environment jsdom
//
// Rule 7, the other half: a page whose data FAILED to load with nothing cached
// must not show its "nothing here yet" empty state.
//
// Found on production 2026-11-12 with every data request failing from a cold
// start: Trackers ("No trackers yet"), the Linked hub, Liabilities, Profiles
// ("0 profiles · No profiles yet"), Bills ("No bills in the next 30 days"),
// Artifacts, Wellness, Settings' import history and the dashboard's people
// grid all read as an empty account. Tasks, Habits, Finance, Journal and Goals
// already said "Failed to load data".
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Router } from "wouter";
import fs from "fs";
import path from "path";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import ProfilesListPage from "../client/src/pages/profiles-list";
import { LoadFailed, useLoadFailed } from "../client/src/components/LoadFailed";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let mode: "down" | "empty" | "ok" = "down";
const PROFILE = { id: "p1", name: "Robert", type: "self", fields: {}, tags: [], notes: "", documents: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  setFilterEveryone();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (mode === "down") return json({ error: "Internal error" }, 500);
    return json(mode === "ok" ? [PROFILE] : []);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<QueryClientProvider client={queryClient}><Router><ProfilesListPage /></Router></QueryClientProvider>);

describe("the Profiles page, driven for real", () => {
  it("says it could not load — never '0 profiles / No profiles yet' — when the request fails", async () => {
    mode = "down";
    page();
    await waitFor(() => expect(screen.getByTestId("load-failed")).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByText(/No profiles yet/i)).toBeNull();
    expect(screen.getByTestId("load-failed").textContent).toMatch(/Couldn't load your profiles/);
    expect(screen.getByTestId("load-failed").textContent).toMatch(/Nothing was deleted/);
  });

  it("Retry fetches again and shows the profiles once the server answers", async () => {
    mode = "down";
    page();
    await waitFor(() => expect(screen.getByTestId("load-failed")).toBeTruthy(), { timeout: 5000 });
    mode = "ok";
    fireEvent.click(screen.getByTestId("load-failed-retry"));
    await waitFor(() => expect(screen.getByText("Robert")).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId("load-failed")).toBeNull();
  });

  it("still says 'No profiles yet' for an account that really has none", async () => {
    mode = "empty";
    page();
    await waitFor(() => expect(screen.getByText(/No profiles yet/i)).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId("load-failed")).toBeNull();
  });
});

describe("useLoadFailed", () => {
  function Probe({ endpoint, fail }: { endpoint: string; fail: boolean }) {
    useQuery({ queryKey: [endpoint, "x"], queryFn: async () => { if (fail) throw new Error("down"); return [1]; }, retry: false });
    const load = useLoadFailed("/api/things");
    return <div data-testid="state">{load.failed ? "failed" : "fine"}</div>;
  }
  const mount = (el: React.ReactElement) => render(<QueryClientProvider client={queryClient}>{el}</QueryClientProvider>);

  it("is true when a query for that endpoint failed with no data", async () => {
    mount(<Probe endpoint="/api/things" fail />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("failed"));
  });
  it("ignores other endpoints' failures", async () => {
    mount(<Probe endpoint="/api/other" fail />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("state").textContent).toBe("fine");
  });
  it("is false when earlier good data is still there (the list keeps showing it)", async () => {
    queryClient.setQueryData(["/api/things", "x"], [1, 2]);
    mount(<Probe endpoint="/api/things" fail />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("state").textContent).toBe("fine");
  });
  it("renders a retry control", () => {
    const retry = vi.fn();
    render(<LoadFailed what="your trackers" onRetry={retry} />);
    fireEvent.click(screen.getByTestId("load-failed-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("every page that was caught claiming 'empty' consults it", () => {
  const SITES: Array<[string, string]> = [
    ["client/src/pages/trackers.tsx", "No trackers yet."],
    ["client/src/pages/trackers.tsx", ">No assets or vehicles yet<"],
    ["client/src/pages/trackers.tsx", ">No liabilities yet<"],
    ["client/src/pages/profiles-list.tsx", "No profiles yet."],
    ["client/src/pages/profile-info.tsx", "No people yet."],
    ["client/src/pages/dashboard.tsx", "No people or pets yet"],
    ["client/src/components/dashboard/BriefingPopups.tsx", "No bills in the next 30 days"],
    ["client/src/pages/artifacts.tsx", 'label="No artifacts yet"'],
    ["client/src/components/ChatGPTImportDialog.tsx", "No imports yet."],
  ];
  it.each(SITES)("%s · %s", (file, emptyText) => {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const at = src.indexOf(emptyText);
    expect(at, `${emptyText} not found in ${file}`).toBeGreaterThan(-1);
    // The load-failed branch sits just before the empty text it replaces.
    expect(src.slice(Math.max(0, at - 900), at)).toMatch(/<LoadFailed\b/);
  });
  it("the Calendar says so instead of drawing an empty month", () => {
    const src = fs.readFileSync(path.join(__dirname, "../client/src/pages/calendar-page.tsx"), "utf8");
    expect(src).toMatch(/useLoadFailed\("\/api\/calendar\/timeline"\)/);
    expect(src).toMatch(/calendarLoad\.failed && \([\s\S]{0,120}<LoadFailed/);
  });
  it("the Profiles header does not print a count it does not have", () => {
    const src = fs.readFileSync(path.join(__dirname, "../client/src/pages/profiles-list.tsx"), "utf8");
    expect(src).toMatch(/load\.failed && total === 0 \? "Couldn't load"/);
  });
  it("Wellness shows it above the overview", () => {
    const src = fs.readFileSync(path.join(__dirname, "../client/src/pages/wellness.tsx"), "utf8");
    expect(src.indexOf("healthLoad.failed")).toBeGreaterThan(-1);
    expect(src.indexOf("<LoadFailed")).toBeLessThan(src.indexOf("<WellnessOverview"));
    // …and the "No body measurements yet" cards are not drawn under it.
    expect(src).toMatch(/!healthLoad\.failed && \(\s*<WellnessOverview/);
  });
});

describe("the editor does not open a blank document for an artifact that is not there", () => {
  // Observed on production: /editor/<unknown id> answered 404 and the page
  // rendered an empty, editable "Doc · 0 words" with Save / Share / Delete.
  const src = fs.readFileSync(path.join(__dirname, "../client/src/pages/editor.tsx"), "utf8");
  it("renders a not-found state before the editor when the artifact did not load", () => {
    const guard = src.indexOf("if (!isNew && existingId && !existing) {");
    const editorRoot = src.indexOf('<div className="h-dvh flex flex-col bg-background">');
    expect(guard).toBeGreaterThan(-1);
    expect(editorRoot).toBeGreaterThan(guard);
    expect(src.slice(guard, editorRoot)).toContain('data-testid="editor-not-found"');
  });
  it("keeps an already-open document on screen through a failed background refresh", () => {
    // The guard keys on "no data", never on the query's error flag alone.
    expect(src).not.toMatch(/existingFailed \|\| !existing/);
  });
});
