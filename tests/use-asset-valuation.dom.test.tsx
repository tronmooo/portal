// @vitest-environment jsdom
//
// The client half: the value card renders the seeded estimate immediately,
// fires ONE background refresh when the verdict says stale, updates itself
// from the response, and never fans out when the user flips between assets.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest, calls, queryClient } = vi.hoisted(() => {
  const { QueryClient } = require("@tanstack/react-query");
  return {
    apiRequest: vi.fn(),
    calls: [] as Array<{ method: string; url: string; body: any }>,
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  };
});

vi.mock("@/lib/queryClient", () => ({ queryClient, apiRequest, BROWSER_TIMEZONE: "UTC" }));

import { CurrentValueCard } from "@/components/asset/CurrentValueCard";
import { __resetValuationRefreshState, valuationQueryKey } from "@/hooks/useAssetValuation";
import type { ValuationRecord, ValuationSnapshot } from "@shared/valuation/types";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function record(value: number, over: Partial<ValuationRecord> = {}): ValuationRecord {
  return {
    schemaVersion: 1, modelVersion: "valuation-v1", profileId: "a", status: "valued", currency: "USD",
    value, low: value * 0.9, high: value * 1.1, confidence: 0.7, confidenceLabel: "medium",
    methodology: ["comparable_market_analysis"], methodSummary: "Comparable market analysis · 1 source",
    evidence: [{ id: "e1", kind: "live_market_search", source: "KBB", provider: "live-search", observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), value, currency: "USD", reliability: 0.8, relevance: 0.9, halfLifeMs: 1 }],
    materialInputs: { attributes: { make: "Honda" } }, inputFingerprint: "fp", marketDataAsOf: new Date().toISOString(),
    marketFreshnessMs: 1000, valuedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
    nextRefreshAt: new Date(Date.now() + 1000).toISOString(), refreshReason: "scheduled", factors: ["KBB: $20,000"], missingInfo: [],
    understanding: null, errorCount: 0, error: null, ...over,
  };
}
function snapshot(rec: ValuationRecord | null, fresh: boolean): ValuationSnapshot {
  return { record: rec, supported: true, inputFingerprint: "fp", freshness: fresh ? { fresh: true, reason: null, detail: "" } : { fresh: false, reason: "scheduled", detail: "" } };
}

let refreshResponder: (profileId: string) => Response = () => json({ snapshot: snapshot(record(21000), true), ran: true, changed: true });

beforeEach(() => {
  calls.length = 0;
  queryClient.clear();
  __resetValuationRefreshState();
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    const m = url.match(/\/api\/profiles\/([^/]+)\/valuation(\/refresh)?/);
    if (m && m[2]) return refreshResponder(m[1]);
    if (m) return json(queryClient.getQueryData(valuationQueryKey(m[1])) ?? snapshot(null, false));
    return json({});
  });
});
afterEach(() => cleanup());

function mount(profileId: string, fields: Record<string, any> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CurrentValueCard profileId={profileId} fields={fields} />
    </QueryClientProvider>,
  );
}

describe("CurrentValueCard + useAssetValuation", () => {
  it("renders the seeded estimate immediately and does not refresh when fresh", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(20000), true));
    mount("a");
    expect(screen.getByTestId("current-value-amount").textContent).toBe("$20,000");
    expect(screen.getByTestId("current-value-range").textContent).toContain("$18,000");
    expect(screen.getByTestId("current-value-confidence").textContent).toMatch(/medium confidence · 70%/);
    await new Promise(r => setTimeout(r, 30));
    expect(calls.filter(c => c.url.includes("/refresh"))).toHaveLength(0);
  });

  it("stale seed → shows the old value, fires ONE background refresh, then shows the new value", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(20000), false));
    mount("a");
    expect(screen.getByTestId("current-value-amount").textContent).toBe("$20,000");
    await waitFor(() => expect(screen.getByTestId("current-value-amount").textContent).toBe("$21,000"));
    expect(calls.filter(c => c.url === "/api/profiles/a/valuation/refresh")).toHaveLength(1);
    expect((queryClient.getQueryData(valuationQueryKey("a")) as ValuationSnapshot).freshness.fresh).toBe(true);
  });

  it("remounting within the throttle window does not refresh again", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(20000), false));
    const { unmount } = mount("a");
    await waitFor(() => expect(calls.filter(c => c.url.includes("/refresh"))).toHaveLength(1));
    unmount();
    // Pretend the refreshed snapshot were still stale (server verdict) — the throttle still holds.
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(21000), false));
    mount("a");
    await new Promise(r => setTimeout(r, 40));
    expect(calls.filter(c => c.url.includes("/refresh"))).toHaveLength(1);
  });

  it("rapid switching between assets fires at most one refresh per asset", async () => {
    for (const id of ["a", "b", "c"]) queryClient.setQueryData(valuationQueryKey(id), snapshot(record(1000), false));
    let view = mount("a");
    for (const id of ["b", "c", "a", "b", "c"]) {
      view.unmount();
      view = mount(id);
    }
    await waitFor(() => expect(calls.filter(c => c.url.includes("/refresh")).length).toBeGreaterThanOrEqual(3));
    await new Promise(r => setTimeout(r, 40));
    const refreshes = calls.filter(c => c.url.includes("/refresh")).map(c => c.url);
    expect(new Set(refreshes).size).toBe(3);
    expect(refreshes).toHaveLength(3);
  });

  it("no record yet → says so, and shows refreshing while the first estimate runs", async () => {
    let release!: (r: Response) => void;
    refreshResponder = () => { throw new Error("unused"); };
    apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
      calls.push({ method, url, body });
      if (url.endsWith("/refresh")) return new Promise<Response>(r => { release = r; });
      return json(snapshot(null, false));
    });
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(null, false));
    mount("a");
    await waitFor(() => expect(screen.getByTestId("current-value-refreshing")).toBeTruthy());
    expect(screen.getByTestId("current-value-unavailable").textContent).toMatch(/Estimating/);
    release(json({ snapshot: snapshot(record(5000), true), ran: true, changed: true }));
    await waitFor(() => expect(screen.getByTestId("current-value-amount").textContent).toBe("$5,000"));
    expect(screen.queryByTestId("current-value-refreshing")).toBeNull();
    refreshResponder = () => json({ snapshot: snapshot(record(21000), true), ran: true, changed: true });
  });

  it("insufficient data is stated, never a number; the user's own value is shown as kept", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(0, { status: "insufficient_data", value: null, low: null, high: null, confidence: 0, confidenceLabel: "none" }), true));
    mount("a");
    expect(screen.getByTestId("current-value-unavailable").textContent).toMatch(/Not enough information/);
    expect(screen.queryByTestId("current-value-amount")).toBeNull();
    cleanup();
    queryClient.setQueryData(valuationQueryKey("b"), snapshot({ ...record(20000), profileId: "b" }, true));
    mount("b", { currentValue: 23000, currentValueSource: "user" });
    expect(screen.getByTestId("current-value-user-value").textContent).toContain("$23,000");
  });

  it("the details panel explains methodology, evidence and inputs; Refresh forces a run", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(20000), true));
    mount("a");
    fireEvent.click(screen.getByTestId("current-value-details-toggle"));
    const details = screen.getByTestId("current-value-details");
    expect(details.textContent).toContain("Comparable market analysis");
    expect(details.textContent).toContain("KBB");
    expect(details.textContent).toContain("1 characteristics");
    fireEvent.click(screen.getByTestId("current-value-refresh"));
    await waitFor(() => expect(screen.getByTestId("current-value-amount").textContent).toBe("$21,000"));
    const refresh = calls.find(c => c.url.endsWith("/refresh"));
    expect(refresh?.body).toEqual({ force: true });
  });

  it("a 202 (another refresh running) polls the snapshot instead of starting a second run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
      calls.push({ method, url, body });
      if (url.endsWith("/refresh")) return json({ snapshot: snapshot(record(20000), false), ran: false, locked: true }, 202);
      polls++;
      return json(snapshot(record(22000), polls >= 2));
    });
    queryClient.setQueryData(valuationQueryKey("a"), snapshot(record(20000), false));
    mount("a");
    await vi.advanceTimersByTimeAsync(9_000);
    await waitFor(() => expect(screen.getByTestId("current-value-amount").textContent).toBe("$22,000"));
    expect(calls.filter(c => c.url.endsWith("/refresh"))).toHaveLength(1);
    vi.useRealTimers();
  });
});
