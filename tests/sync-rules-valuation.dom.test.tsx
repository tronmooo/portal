// @vitest-environment jsdom
//
// ASSET VALUATION REGRESSION — client half.
//
// One revaluation, applied through the real request path (apiRequest → write
// manifest → cache patch + domain invalidation), must move every on-screen
// reader at once with NO page refresh: the Assets list, net worth, and the
// asset's own value card. Then a LATE, OLDER response (a slower sweep run,
// another tab) arrives — it must not put the previous value back anywhere.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "../client/src/lib/queryClient";
import { refreshAssetValuation, valuationQueryKey, __resetValuationRefreshState } from "../client/src/hooks/useAssetValuation";
import { CurrentValueCard } from "../client/src/components/asset/CurrentValueCard";
import { resolveAssetValue } from "@shared/asset-value";
import { computeNetWorth } from "@shared/net-worth";
import { encodeWriteManifest, WRITE_MANIFEST_HEADER } from "@shared/write-manifest";
import { getSyncLog, clearSyncLog } from "@shared/sync-log";

const HONDA = "a0000000-0000-4000-8000-000000000005";
const T1 = "2026-10-09T18:57:47.000Z";
const T2 = "2026-10-09T18:58:09.000Z";

function hondaRow(value: number, at: string) {
  return {
    id: HONDA, name: "Honda CR-V 2021", type: "vehicle", parentProfileId: null, linkedProfiles: [], tags: [], notes: "",
    updatedAt: at, fields: { currentValue: value, currentValueSource: "estimate", currentValueAsOf: at, valuationMethod: "Comparable market analysis" },
  };
}
function snapshot(value: number, at: string) {
  return {
    supported: true, mode: "auto", inputFingerprint: "f",
    freshness: { fresh: true, reason: null, detail: "" },
    record: {
      schemaVersion: 1, profileId: HONDA, status: "valued", value, low: value * 0.9, high: value * 1.1,
      confidence: 0.6, confidenceLabel: "medium", methodology: ["comparable_market_analysis"], methodSummary: "Comparable market analysis",
      evidence: [], factors: [], missingInfo: [], valuedAt: at, checkedAt: at, inputFingerprint: "f",
    },
  };
}

/** What the server answers the next refresh POST with. */
let nextRefresh: { value: number; at: string } = { value: 22000, at: T2 };
let enhancedFetches = 0;
/** What the server holds (its own guard keeps the newest — tests/sync-rules-valuation.test.ts). */
let server = { row: hondaRow(22500, T1), snap: snapshot(22500, T1) };

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}

beforeEach(() => {
  queryClient.clear();
  __resetValuationRefreshState();
  clearSyncLog();
  enhancedFetches = 0;
  server = { row: hondaRow(22500, T1), snap: snapshot(22500, T1) };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "POST" && url.includes("/valuation/refresh")) {
      const { value, at } = nextRefresh;
      if (at >= server.snap.record.valuedAt) server = { row: hondaRow(value, at), snap: snapshot(value, at) };
      const manifest = encodeWriteManifest({
        domains: ["assets", "profiles"],
        changes: [{ op: "update", endpoint: "/api/profiles", id: HONDA, row: hondaRow(value, at) }],
      });
      return json({ snapshot: snapshot(value, at), ran: true, changed: true }, { [WRITE_MANIFEST_HEADER]: manifest });
    }
    if (url.includes("/api/dashboard-enhanced")) { enhancedFetches++; return json({ financeSnapshot: {} }); }
    if (url.includes(`/api/profiles/${HONDA}/valuation`)) {
      // The refetch an invalidation triggers returns what the SERVER holds now.
      return json(server.snap);
    }
    if (url.includes("/api/profiles")) return json([server.row]);
    return json([]);
  }));
  // The state on screen before the user revalues: the old estimate everywhere.
  queryClient.setQueryData(["/api/profiles"], [hondaRow(22500, T1)]);
  queryClient.setQueryData(valuationQueryKey(HONDA), snapshot(22500, T1));
  queryClient.setQueryData(["/api/dashboard-enhanced", "everyone"], { financeSnapshot: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Screen() {
  const { data: profiles = [] } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  useQuery({ queryKey: ["/api/dashboard-enhanced", "everyone"] });
  const honda = profiles.find(p => p.id === HONDA);
  const nw = computeNetWorth(profiles, { mode: "everyone", selectedIds: [] });
  return (
    <div>
      <span data-testid="overview">{honda ? resolveAssetValue(honda) : "-"}</span>
      <span data-testid="networth">{nw.assets}</span>
      {honda && <CurrentValueCard profileId={HONDA} fields={honda.fields} />}
    </div>
  );
}

const digits = (s: string | null | undefined) => (s || "").replace(/[^0-9.]/g, "");

describe("valuation propagation in the client (no refresh)", () => {
  it("one revaluation moves the Assets list, net worth and the value card together; a late older response changes nothing", async () => {
    render(<QueryClientProvider client={queryClient}><Screen /></QueryClientProvider>);
    expect(screen.getByTestId("overview").textContent).toBe("22500");
    expect(screen.getByTestId("networth").textContent).toBe("22500");
    await waitFor(() => expect(digits(screen.getByTestId("current-value-amount").textContent)).toMatch(/^22\.5|^22500/));

    const before = enhancedFetches;
    await act(async () => { await refreshAssetValuation(HONDA, { force: true }); });

    // Every reader, same number, no reload.
    await waitFor(() => expect(screen.getByTestId("overview").textContent).toBe("22000"));
    expect(screen.getByTestId("networth").textContent).toBe("22000");
    await waitFor(() => expect(digits(screen.getByTestId("current-value-amount").textContent)).toMatch(/^22(000)?$/));
    // The dashboard aggregate (net worth tile / KPI strip) was refetched by the write itself.
    await waitFor(() => expect(enhancedFetches).toBeGreaterThan(before));

    // A slower run that STARTED earlier answers last, with the old estimate.
    __resetValuationRefreshState();
    nextRefresh = { value: 22500, at: T1 };
    await act(async () => { await refreshAssetValuation(HONDA, { force: true }); });
    await new Promise(r => setTimeout(r, 20));

    expect(screen.getByTestId("overview").textContent).toBe("22000");
    expect(screen.getByTestId("networth").textContent).toBe("22000");
    expect(digits(screen.getByTestId("current-value-amount").textContent)).toMatch(/^22(000)?$/);
    expect((queryClient.getQueryData<any>(valuationQueryKey(HONDA)))?.record?.value).toBe(22000);
    // ...and the rejection is visible in the dev sync log.
    expect(getSyncLog("stale-reject").length).toBeGreaterThan(0);
    nextRefresh = { value: 22000, at: T2 };
  });
});
