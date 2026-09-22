// @vitest-environment jsdom
//
// The card half of the per-asset tracking switch (user request, 2026-09-22).
// Auto is the default and looks exactly like it always did, plus one switch.
// Off, the card becomes the user's own value with an inline editor, the
// estimate affordances disappear, and the last estimate is reachable only as
// labelled history.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

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
function record(value: number): ValuationRecord {
  return {
    schemaVersion: 1, modelVersion: "valuation-v1", profileId: "a", status: "valued", currency: "USD",
    value, low: value * 0.9, high: value * 1.1, confidence: 0.5, confidenceLabel: "medium",
    methodology: ["comparable_market_analysis"], methodSummary: "Comparable market analysis",
    evidence: [], materialInputs: { attributes: { brand: "Apple" } }, inputFingerprint: "fp",
    marketDataAsOf: null, marketFreshnessMs: 0, valuedAt: "2026-09-16T12:00:00.000Z",
    checkedAt: "2026-09-16T12:00:00.000Z", nextRefreshAt: "2026-10-16T12:00:00.000Z",
    refreshReason: "scheduled", factors: [], missingInfo: ["trim level"], understanding: null,
    errorCount: 0, error: null,
  };
}
function snapshot(mode: "auto" | "manual" | undefined, fresh = true): ValuationSnapshot {
  return {
    record: record(1330), supported: true, inputFingerprint: "fp",
    ...(mode ? { mode } : {}),
    freshness: fresh ? { fresh: true, reason: null, detail: "" } : { fresh: false, reason: "scheduled", detail: "" },
  };
}

beforeEach(() => {
  calls.length = 0;
  queryClient.clear();
  __resetValuationRefreshState();
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    return json({});
  });
});
afterEach(() => cleanup());

function mount(fields: Record<string, any> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CurrentValueCard profileId="a" fields={fields} />
    </QueryClientProvider>,
  );
}
const patches = () => calls.filter(c => c.method === "PATCH");

describe("CurrentValueCard — automatic value tracking switch", () => {
  it("auto (and a snapshot with no mode at all) renders today's estimate card plus the switch, switch ON", () => {
    for (const mode of ["auto", undefined] as const) {
      queryClient.setQueryData(valuationQueryKey("a"), snapshot(mode));
      mount();
      expect(screen.getByTestId("current-value-amount").textContent).toBe("$1,330");
      expect(screen.getByTestId("current-value-confidence")).toBeTruthy();
      expect(screen.getByTestId("current-value-refresh")).toBeTruthy();
      expect(screen.getByTestId("current-value-meta")).toBeTruthy();
      expect(screen.getByTestId("current-value-details-toggle").textContent).toContain("How this was estimated");
      expect(screen.getByTestId("valuation-mode-switch").getAttribute("aria-checked")).toBe("true");
      expect(screen.queryByTestId("current-value-manual-heading")).toBeNull();
      cleanup();
    }
  });

  it("turning the switch OFF writes valuationMode: manual through the profile PATCH", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot("auto"));
    mount();
    fireEvent.click(screen.getByTestId("valuation-mode-switch"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ url: "/api/profiles/a", body: { fields: { valuationMode: "manual" } } });
  });

  it("turning it back ON writes valuationMode: auto", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot("manual"));
    mount({ valuationMode: "manual" });
    expect(screen.getByTestId("valuation-mode-switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("valuation-mode-switch"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ fields: { valuationMode: "auto" } });
  });

  it("manual: the user's own value leads, the estimate machinery is gone, the old estimate is labelled history", () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot("manual"));
    mount({ valuationMode: "manual", currentValue: 1200, currentValueSource: "user" });

    expect(screen.getByTestId("current-value-manual-heading").textContent).toMatch(/Your current value/i);
    expect(screen.getByTestId("current-value-manual-amount").textContent).toBe("$1,200");
    expect(screen.getByTestId("current-value-set-by-you").textContent).toMatch(/Set by you/i);
    expect(screen.getByTestId("valuation-mode-help").textContent).toMatch(/Off — you set the value yourself/);

    expect(screen.queryByTestId("current-value-refresh")).toBeNull();
    expect(screen.queryByTestId("current-value-confidence")).toBeNull();
    expect(screen.queryByTestId("current-value-meta")).toBeNull();
    expect(screen.queryByTestId("current-value-amount")).toBeNull();

    const toggle = screen.getByTestId("current-value-details-toggle");
    expect(toggle.textContent).toMatch(/Last AI estimate \(not in use\)/);
    fireEvent.click(toggle);
    const note = screen.getByTestId("current-value-historical-note").textContent!;
    expect(note).toMatch(/\$1,330/);
    expect(note).toMatch(/history, not your current value/i);
  });

  it("manual: typing a value writes currentValue (the canonical user-value convention)", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot("manual"));
    mount({ valuationMode: "manual", currentValue: 1200, currentValueSource: "user" });
    fireEvent.click(screen.getByTestId("current-value-manual-amount"));
    const input = screen.getByTestId("current-value-manual-input") as HTMLInputElement;
    expect(input.value).toBe("1200");
    fireEvent.change(input, { target: { value: "1450" } });
    fireEvent.click(screen.getByTestId("current-value-manual-save"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ method: "PATCH", url: "/api/profiles/a", body: { fields: { currentValue: 1450 } } });
    // Provenance is stamped server-side (the one place that owns it), so the
    // card must NOT invent its own source/as-of keys here.
    expect(Object.keys(patches()[0].body.fields)).toEqual(["currentValue"]);
  });

  it("manual: a negative or non-numeric amount is refused and nothing is written", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot("manual"));
    mount({ valuationMode: "manual", currentValue: 1200 });
    fireEvent.click(screen.getByTestId("current-value-manual-amount"));
    const input = screen.getByTestId("current-value-manual-input");
    for (const bad of ["-5", "abc", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByTestId("current-value-manual-save"));
    }
    await new Promise(r => setTimeout(r, 30));
    expect(patches()).toHaveLength(0);
    expect(screen.getByTestId("current-value-manual-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("current-value-manual-cancel"));
    expect(screen.queryByTestId("current-value-manual-editor")).toBeNull();
  });

  it("manual: the card never fires a background refresh (the snapshot is never stale)", async () => {
    queryClient.setQueryData(valuationQueryKey("a"), snapshot("manual", true));
    mount({ valuationMode: "manual" });
    await new Promise(r => setTimeout(r, 40));
    expect(calls.filter(c => c.url.includes("/valuation"))).toHaveLength(0);
  });
});
