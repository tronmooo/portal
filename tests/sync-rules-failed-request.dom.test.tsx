// @vitest-environment jsdom
//
// FAILED-REQUEST REGRESSION (Rule 10): "request failed" is never "the user has
// no records". Previously loaded assets stay on screen through a 500, a network
// error and a 401 (the token-refresh window), and no query function in the
// client turns a failure into a cached-as-success empty list.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import TrackersPage from "../client/src/pages/trackers";
import { queryClient } from "../client/src/lib/queryClient";
import { setFilterEveryone } from "../client/src/lib/profileFilter";

const SELF = "11111111-1111-4111-8111-111111111111";
const base = { tags: [], notes: "", documents: [], createdAt: "2026-04-01T00:00:00Z", updatedAt: "2026-10-09T18:57:00Z" };
const PROFILES = [
  { ...base, id: SELF, name: "Robert", type: "self", fields: {}, linkedProfiles: [], parentProfileId: null },
  { ...base, id: "a0000000-0000-4000-8000-000000000001", name: "iPhone 17 Pro Max", type: "asset", fields: { currentValue: 911 }, parentProfileId: SELF, linkedProfiles: [SELF] },
  { ...base, id: "a0000000-0000-4000-8000-000000000005", name: "Honda CR-V 2021", type: "vehicle", fields: { currentValue: 22000 }, parentProfileId: SELF, linkedProfiles: [SELF] },
];

let mode: "ok" | "500" | "network" | "401" = "ok";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  mode = "ok";
  queryClient.clear();
  setFilterEveryone();
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const p = String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (p === "/api/profiles") {
      if (mode === "500") return json({ error: "boom" }, 500);
      if (mode === "network") throw new TypeError("Failed to fetch");
      if (mode === "401") return json({ error: "unauthorized" }, 401);
      return json(PROFILES);
    }
    if (p === "/api/valuations/status") return json({ rows: [] });
    if (p === "/api/dashboard-enhanced") return json({ financeSnapshot: { assetBreakdown: [], liabilityBreakdown: [] } });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderAssets() {
  window.history.replaceState(null, "", "/linked?tab=assets");
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={(() => ["/linked?tab=assets", () => {}]) as any}><TrackersPage /></Router>
    </QueryClientProvider>,
  );
}

describe("a failed refetch never replaces loaded assets with an empty list", () => {
  for (const failure of ["500", "network", "401"] as const) {
    it(`keeps the assets on screen through a ${failure}`, async () => {
      renderAssets();
      await waitFor(() => expect(screen.getAllByText("Honda CR-V 2021").length).toBeGreaterThan(0));
      mode = failure;
      await act(async () => { await queryClient.refetchQueries({ queryKey: ["/api/profiles"] }).catch(() => {}); });
      await new Promise(r => setTimeout(r, 30));
      expect(screen.getAllByText("Honda CR-V 2021").length).toBeGreaterThan(0);
      expect(screen.getAllByText("iPhone 17 Pro Max").length).toBeGreaterThan(0);
      expect(screen.queryByTestId("assets-empty")).toBeNull();
      expect(screen.queryByText("No assets or vehicles yet")).toBeNull();
      // The cache still holds the real list, not null / [].
      expect((queryClient.getQueryData<any[]>(["/api/profiles"]) || []).length).toBe(PROFILES.length);
    });
  }

  it("the default query function: a 401 with data cached is an ERROR (data kept), not a successful null", async () => {
    function Probe() {
      const q = useQuery<any[]>({ queryKey: ["/api/profiles"], retry: false });
      return <span data-testid="n">{q.data == null ? "null" : String(q.data.length)}|{q.isError ? "error" : "ok"}</span>;
    }
    render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe(`${PROFILES.length}|ok`));
    mode = "401";
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["/api/profiles"] }).catch(() => {}); });
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe(`${PROFILES.length}|error`));
  });
});

describe("static guard: no query function turns a failure into empty data", () => {
  it("no `.catch(() => [])` / `catch { return [] }` inside a useQuery queryFn", () => {
    const root = path.resolve(__dirname, "../client/src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const lines = fs.readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
          // The queryFn itself, or the few lines of its body.
          const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
          if (!/queryFn\s*:/.test(window)) return;
          // Parsing a malformed body of a SUCCESSFUL response (a preference
          // holding bad JSON) is not a request failure — apiRequest still
          // throws on a failed request before these run.
          if (/JSON\.parse|\bres\.json\(\)\.catch/.test(line)) return;
          if (/\.catch\(\s*\(\)\s*=>\s*(\[\]|\(\[\]\)|null)\s*\)|catch\s*(\([^)]*\))?\s*\{\s*return\s*(\[\]|null)\s*;?\s*\}/.test(line)) {
            offenders.push(`${path.relative(root, p)}:${i + 1}`);
          }
        });
      }
    };
    walk(root);
    // dashboard.tsx's layout preference falls back to the DEFAULT LAYOUT on a
    // failed read — a presentation preference, not user records.
    expect(offenders.filter(o => !o.startsWith("pages/dashboard.tsx"))).toEqual([]);
  });
});

describe("profile detail: a failed linked-records request is not 'No linked …'", () => {
  it("both linked tabs render an error with Retry when their query fails", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../client/src/pages/profile-detail.tsx"), "utf8");
    expect(src).toMatch(/assetsFailed && items\.length === 0 \? \(\s*<LinkedLoadError what="linked assets"/);
    expect(src).toMatch(/liabilitiesFailed && items\.length === 0 \? \(\s*<LinkedLoadError what="linked liabilities"/);
  });
});
