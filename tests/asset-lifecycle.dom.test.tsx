// @vitest-environment jsdom
//
// Asset Lifecycle Intelligence on screen: the Value card draws the engine's
// answer (GET /api/assets/lifecycle) — recommendation, figures, reasons,
// confidence and sources, salvage from the engine (AI / typical / disposal
// cost), and the graph's projection, salvage line and selling window. A failed
// request is an error with a retry (Rule 7). Opening writes nothing (Rule 3).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { computeAssetLifecycle, type LifecycleAssumptions } from "@shared/asset-lifecycle";

const { apiRequest, calls, queryClient } = vi.hoisted(() => {
  const { QueryClient } = require("@tanstack/react-query");
  return {
    apiRequest: vi.fn(),
    calls: [] as Array<{ method: string; url: string }>,
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  };
});
vi.mock("@/lib/queryClient", () => ({ queryClient, apiRequest, BROWSER_TIMEZONE: "UTC" }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}), invalidateDomains: vi.fn(async () => {}) }));

import { ValueCard } from "@/components/asset/AssetOverviewLayout";
import { LIFECYCLE_QUERY_KEY, LifecycleFinanceSummary } from "@/components/asset/AssetLifecycle";
import { __resetValuationRefreshState, valuationQueryKey } from "@/hooks/useAssetValuation";

const ID = "civic";
const NOW = new Date();
const iso = (yearsAgo: number) => new Date(NOW.getTime() - yearsAgo * 365.25 * 86_400_000).toISOString().slice(0, 10);
const FIELDS = { make: "Honda", model: "Civic", purchasePrice: 19000, purchaseDate: iso(10.5), currentValue: 7000, currentValueSource: "estimate" };
const PROFILE = { id: ID, name: "Honda Civic", type: "vehicle", notes: "", fields: FIELDS, relatedEvents: [] };
const A = (over: Partial<LifecycleAssumptions> = {}): LifecycleAssumptions => ({
  source: "ai", valueModel: "depreciating", usefulLifeYears: 15, annualChangePct: -0.12, salvageValue: 1500, disposal: "scrap",
  replacementCost: 30000, confidence: "high", basis: "Compact sedan, typical wear.", assumptions: ["15-year useful life for a compact sedan"], asOf: NOW.toISOString(), ...over,
});
const row = (over: Partial<LifecycleAssumptions> = {}, input: Record<string, unknown> = {}) => ({
  profileId: ID, name: "Honda Civic", parentProfileId: null, repairs: { last12m: 0, total: 0, count: 0 }, nested: null,
  lifecycle: computeAssetLifecycle({
    now: NOW, category: "vehicle", purchasePrice: 19000, purchaseDate: FIELDS.purchaseDate, ageYears: null, currentValue: 7000, currentValueSource: "estimate",
    valuation: { valuedAt: NOW.toISOString(), confidenceLabel: "high", sources: ["https://www.kbb.com/honda/civic"] }, assumptions: A(over), ...input,
  } as any),
});

function json(body: any, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

beforeEach(() => {
  calls.length = 0;
  queryClient.clear();
  __resetValuationRefreshState();
  queryClient.setQueryData(valuationQueryKey(ID), {
    record: { status: "valued", value: 7000, low: 6500, high: 7500, confidence: 0.8, confidenceLabel: "high", valuedAt: NOW.toISOString(), checkedAt: NOW.toISOString() },
    supported: true, inputFingerprint: "fp", mode: "auto", freshness: { fresh: true, reason: null, detail: "" },
  });
  apiRequest.mockImplementation(async (method: string, url: string) => {
    calls.push({ method, url });
    if (url.includes("history=1")) return json({ history: [] });
    return json({ ok: true });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(profile = PROFILE) {
  const hook = () => [`/profiles/${ID}`, vi.fn()] as [string, (to: string) => void];
  render(<QueryClientProvider client={queryClient}><Router hook={hook as any}><ValueCard profile={profile} /></Router></QueryClientProvider>);
}

describe("the Value card draws the lifecycle engine's answer", () => {
  it("recommendation, figures, and the reasons, assumptions, confidence and sources behind a tap", async () => {
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [row()], computedAt: NOW.toISOString() });
    mount();
    const card = await screen.findByTestId("asset-lifecycle");
    expect(screen.getByTestId("lifecycle-pill-consider_selling").textContent).toBe("Consider Selling");
    expect(screen.getByTestId("lifecycle-headline").textContent).toContain("best selling window");
    expect(screen.getByTestId("lifecycle-remaining").textContent).toContain("4.5 yrs");
    expect(screen.getByTestId("lifecycle-replacement").textContent).toContain("$30,000");
    expect(screen.getByTestId("lifecycle-why-toggle").textContent).toContain("Confidence: High · AI assumptions");
    expect(screen.queryByTestId("lifecycle-why")).toBeNull();
    fireEvent.click(screen.getByTestId("lifecycle-why-toggle"));
    const why = screen.getByTestId("lifecycle-why");
    expect(why.textContent).toContain("15-year useful life for a compact sedan");
    expect(why.textContent).toContain("These are estimates, not quotes");
    expect(screen.getByTestId("lifecycle-sources").textContent).toContain("kbb.com");
    expect(card).toBeTruthy();
    // Opening and expanding wrote nothing.
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("the salvage line is the engine's, labelled AI; the graph shows the projection, the salvage line and the selling window", async () => {
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [row()], computedAt: NOW.toISOString() });
    mount();
    await screen.findByTestId("asset-lifecycle");
    expect(screen.getByTestId("asset-value-salvage").textContent).toContain("$1,500");
    expect(screen.getByTestId("asset-salvage-ai").textContent).toBe("AI");
    expect(screen.getByTestId("asset-graph-projection")).toBeTruthy();
    expect(screen.getByTestId("asset-graph-salvage")).toBeTruthy();
    expect(screen.getByTestId("asset-graph-window")).toBeTruthy();
    expect(screen.getByTestId("asset-value-graph-end").textContent).toContain("projected");
    expect(screen.getByTestId("asset-value-projection").textContent).toContain("a year from now");
    // History only on the 1Y range: no projection.
    fireEvent.click(screen.getByTestId("asset-value-range-1y"));
    expect(screen.queryByTestId("asset-graph-projection")).toBeNull();
  });

  it("the Optimal Disposal Point: a money line between Current value and Salvage value, marked on the graph, the AI's inputs behind a tap", async () => {
    const r = row({ annualUpkeep: 1400, upkeepGrowthPct: 0.15 });
    const od = r.lifecycle.optimalDisposal!;
    expect(od).toBeTruthy();
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [r], computedAt: NOW.toISOString() });
    mount();
    await screen.findByTestId("asset-lifecycle");
    const when = od.decision === "sell_now" ? "Sell now" : new Date(`${od.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
    expect(screen.getByTestId("asset-optimal-disposal-date").textContent).toBe(when);
    expect(screen.getByTestId("asset-optimal-disposal-value").textContent).toBe("$" + od.valueAt.toLocaleString("en-US"));
    // It sits between Current value and Salvage value.
    const order = Array.from(screen.getByTestId("asset-value-card").querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
    const cur = order.indexOf("asset-value-row-current-value");
    const odIdx = order.indexOf("asset-optimal-disposal");
    const sal = order.indexOf("asset-value-salvage");
    expect(cur).toBeGreaterThanOrEqual(0);
    expect(odIdx).toBeGreaterThan(cur);
    expect(sal).toBeGreaterThan(odIdx);
    expect(screen.getByTestId("lifecycle-optimal-disposal").textContent).toContain(when);
    if (od.monthsFromNow > 0) {
      expect(screen.getByTestId("asset-graph-disposal")).toBeTruthy();
      expect(screen.getByTestId("asset-graph-disposal-legend").textContent).toContain("optimal disposal");
    }
    expect(screen.queryByTestId("asset-optimal-disposal-why")).toBeNull();
    fireEvent.click(screen.getByTestId("asset-optimal-disposal-toggle"));
    const why = screen.getByTestId("asset-optimal-disposal-why").textContent!;
    expect(why).toContain("$1,400 a year now");
    expect(why).toContain("15% a year");
    // Every factor it weighed is listed with its yearly figures.
    for (const k of ["depreciation", "upkeep", "major_failure", "carrying", "capital", "selling"]) {
      expect(screen.getByTestId(`asset-disposal-factor-${k}`)).toBeTruthy();
    }
    expect(screen.getByTestId("asset-disposal-factor-upkeep").textContent).toContain("AI");
    // The decision model's figures, the decision, the explanation and the intervals compared.
    for (const id of ["od-fig-value", "od-fig-date", "od-fig-life", "od-fig-depreciation", "od-fig-confidence", "asset-optimal-disposal-decision", "asset-optimal-disposal-explanation", "asset-optimal-disposal-schedule"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId("od-fig-confidence").textContent).toMatch(/High|Medium|Low/);
    // Never the salvage value ($1,500).
    expect(od.valueAt).toBeGreaterThan(1500);
    expect(screen.getByTestId("asset-optimal-disposal-value").textContent).not.toBe("$1,500");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("every asset has the line: None for something that gains value, a retry when the lifecycle failed", async () => {
    const house = row({ valueModel: "appreciating", usefulLifeYears: null, annualChangePct: 0.04, salvageValue: null, replacementCost: null });
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [house], computedAt: NOW.toISOString() });
    mount();
    await screen.findByTestId("asset-lifecycle");
    expect(screen.getByTestId("asset-optimal-disposal-value").textContent).toBe("None \u2014 it gains value");
  });

  it("before the AI has answered, the category's typical salvage shows, labelled Typical", async () => {
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [{ ...row(), lifecycle: computeAssetLifecycle({ ...(row().lifecycle as any), now: NOW, category: "vehicle", purchasePrice: 19000, purchaseDate: FIELDS.purchaseDate, ageYears: null, currentValue: 7000, currentValueSource: "estimate", assumptions: null }) }], computedAt: NOW.toISOString() });
    mount();
    await screen.findByTestId("asset-lifecycle");
    expect(screen.getByTestId("asset-salvage-typical").textContent).toBe("Typical");
    expect(screen.getByTestId("lifecycle-why-toggle").textContent).toContain("Typical figures");
  });

  it("a net disposal cost reads as a cost, never a negative value", async () => {
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [row({ salvageValue: -120, disposal: "dispose" })], computedAt: NOW.toISOString() });
    mount();
    await screen.findByTestId("asset-lifecycle");
    expect(screen.getByTestId("asset-value-salvage").textContent).toContain("Disposal cost");
    expect(screen.getByTestId("asset-salvage-disposal").textContent).toContain("$120");
  });

  it("a house that gains value: Keep, and no salvage value to plan for", async () => {
    const house = { ...row({ valueModel: "appreciating", usefulLifeYears: null, annualChangePct: 0.04, salvageValue: null, replacementCost: null }) };
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [house], computedAt: NOW.toISOString() });
    mount();
    await screen.findByTestId("asset-lifecycle");
    expect(screen.getByTestId("lifecycle-pill-keep")).toBeTruthy();
    expect(screen.getByTestId("asset-salvage-basis").textContent).toContain("tends to gain its value");
  });

  it("a failed lifecycle request is an error with a retry, never a blank (Rule 7)", async () => {
    apiRequest.mockImplementation(async (_m: string, url: string) => {
      if (url.startsWith("/api/assets/lifecycle")) throw new Error("500");
      if (url.includes("history=1")) return json({ history: [] });
      return json({ ok: true });
    });
    mount();
    expect(await screen.findByTestId("asset-lifecycle-error")).toBeTruthy();
    // The Optimal disposal line says so too, with its own retry.
    expect(screen.getByTestId("asset-optimal-disposal-value").textContent).toBe("Couldn't load");
    expect(screen.getByTestId("asset-optimal-disposal-retry")).toBeTruthy();
  });
});

describe("Finance", () => {
  it("sums each asset's projected loss once and names the biggest", async () => {
    const tv = { ...row(), profileId: "tv", name: "TV" };
    queryClient.setQueryData(LIFECYCLE_QUERY_KEY, { rows: [row(), tv], computedAt: NOW.toISOString() });
    const hook = () => ["/finance", vi.fn()] as [string, (to: string) => void];
    render(<QueryClientProvider client={queryClient}><Router hook={hook as any}><LifecycleFinanceSummary filterMode="everyone" filterIds={[]} /></Router></QueryClientProvider>);
    const total = await screen.findByTestId("finance-lifecycle-total");
    const each = row().lifecycle.depreciationNext12m!;
    expect(total.textContent).toBe(`−$${(each * 2).toLocaleString("en-US")}`);
    await waitFor(() => expect(screen.getByTestId("finance-lifecycle").textContent).toContain("2 assets"));
  });
});
