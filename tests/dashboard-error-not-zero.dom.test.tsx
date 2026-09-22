// @vitest-environment jsdom
//
// Rules 29/30 — a dashboard claim is backed by a query, and an API error is
// never rendered as "0 tasks" or "$0".
//
// ExecutiveBriefing's "Tasks Remaining" cell used to destructure
// `{ data: tasksRaw = [] }`: when /api/tasks failed the default [] made the
// cell read "0" with "none overdue" under it — a confident, wrong answer. The
// cell now has four states; a failed query is "—" with "Couldn't load".
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={() => ["/dashboard", () => {}] as any}>{ui}</Router>
    </QueryClientProvider>,
  );
}

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchStub = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Every route answers []; the ones named in `failing` answer 500. */
function stubWithFailures(failing: string[]) {
  fetchStub.mockImplementation(async (url: any) => {
    const u = String(url);
    if (failing.some(f => u.includes(f))) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

const enhanced = { financeSnapshot: { upcomingBills: [], totalAssetValue: 1000, totalLiabilities: 200, totalMonthlySpend: 50, monthlyIncome: 500 }, expiringDocuments: [] };

describe("Rule 30: a failed /api/tasks is not 0 tasks", () => {
  it("renders — and Couldn't load in the Tasks Remaining cell, never 0", async () => {
    stubWithFailures(["/api/tasks"]);
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={{} as any} enhanced={enhanced} />);
    const cell = await screen.findByTestId("exec-kpi-tasks");
    await waitFor(() => expect(cell.textContent).toContain("Couldn't load"));
    expect(cell.getAttribute("data-error")).toBe("true");
    expect(cell.textContent).toContain("—");
    expect(cell.textContent).not.toMatch(/\b0\b/);
    expect(cell.textContent).not.toContain("none overdue");
  });

  it("the healthy path still shows the real count (loaded-empty is 0, loaded-data is N)", async () => {
    fetchStub.mockImplementation(async (url: any) => {
      const u = String(url);
      const body = u.includes("/api/tasks")
        ? [{ id: "t1", title: "Trash", status: "todo" }, { id: "t2", title: "Done", status: "done" }]
        : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={{} as any} enhanced={enhanced} />);
    const cell = await screen.findByTestId("exec-kpi-tasks");
    await waitFor(() => expect(cell.textContent).toContain("1"));
    expect(cell.getAttribute("data-error")).toBeNull();
    expect(cell.textContent).not.toContain("Couldn't load");
  });

  it("a failed enhanced snapshot renders — for Net Worth and Cash Flow, not $0", async () => {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={{} as any} enhanced={undefined} enhancedError />);
    const nw = await screen.findByTestId("exec-kpi-networth");
    const cf = await screen.findByTestId("exec-kpi-cashflow");
    for (const cell of [nw, cf]) {
      expect(cell.getAttribute("data-error")).toBe("true");
      expect(cell.textContent).toContain("—");
      expect(cell.textContent).toContain("Couldn't load");
      expect(cell.textContent).not.toContain("$0");
    }
  });

  it("Rule 18: a refetching cell is marked revalidating rather than presented as final", async () => {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={{} as any} enhanced={enhanced} enhancedFetching />);
    const nw = await screen.findByTestId("exec-kpi-networth");
    expect(nw.getAttribute("data-revalidating")).toBe("true");
    expect(nw.getAttribute("title")).toBe("Updating…");
  });
});

describe("Rule 29: no dashboard queryFn caches a failure as an empty success", () => {
  it("dashboard.tsx and ExecutiveBriefing.tsx contain no `.catch(() => [])` / `.catch(() => null)` queryFns", () => {
    const fs = require("fs"); const path = require("path");
    for (const f of ["../client/src/pages/dashboard.tsx", "../client/src/components/dashboard/ExecutiveBriefing.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      expect(src, f).not.toContain(".then(r => r.json()).catch(() => [])");
      expect(src, f).not.toContain(".then(r => r.json()).catch(() => null)");
    }
  });

  it("the hero revalidating marker is no longer capped at 3.5s and escalates instead", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../client/src/pages/dashboard.tsx"), "utf8");
    expect(src).not.toContain("setShowRefetch(false), 3500");
    expect(src).toContain("Still updating…");
  });
});

describe("numOrUnknown", () => {
  it("is null for an absent or errored value and a number otherwise", async () => {
    const { numOrUnknown, fmtOrUnknown } = await import("../shared/num-or-unknown");
    expect(numOrUnknown(undefined, false)).toBeNull();
    expect(numOrUnknown(null, false)).toBeNull();
    expect(numOrUnknown(12, true)).toBeNull();
    expect(numOrUnknown(0, false)).toBe(0);
    expect(numOrUnknown("42.5", false)).toBe(42.5);
    expect(numOrUnknown("abc", false)).toBeNull();
    expect(fmtOrUnknown(null, (n) => `$${n}`)).toBe("—");
    expect(fmtOrUnknown(3, (n) => `$${n}`)).toBe("$3");
  });
});
