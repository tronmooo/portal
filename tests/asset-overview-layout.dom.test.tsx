// @vitest-environment jsdom
//
// The asset profile's layout (owner's mock-up, 2026-11-23) is a new drawing of
// stores other screens already read. What is pinned here is the wiring:
//
//   · a "Not set" row writes the one field it names, with the page's PATCH
//   · the header's Current Value is currentAssetValue (the estimate while
//     Portol tracks it) against the purchase price
//   · the Alerts card is the date-rule engine's answer for this record, and
//     "Clear document alerts" dismisses into the SERVER's dismiss list under
//     the id the bell uses — never the browser-only snooze (Rule 8)
//   · opening the page writes nothing (Rule 3)
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { composeOverview } from "@shared/overview-compose";
import { dateAlertId } from "@shared/alert-ids";

const { apiRequest, calls, queryClient } = vi.hoisted(() => {
  const { QueryClient } = require("@tanstack/react-query");
  return {
    apiRequest: vi.fn(),
    calls: [] as Array<{ method: string; url: string; body: any }>,
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  };
});

vi.mock("@/lib/queryClient", () => ({ queryClient, apiRequest, BROWSER_TIMEZONE: "UTC" }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({
  invalidateDomain: vi.fn(async () => {}),
  invalidateDomains: vi.fn(async () => {}),
}));

import { DynamicOverview } from "@/components/overview/DynamicOverview";
import { AssetOverviewBody, AssetAlertMenuItems, AssetHeroValue, AssetAddDateDialog, ValueCard } from "@/components/asset/AssetOverviewLayout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { __resetValuationRefreshState, valuationQueryKey } from "@/hooks/useAssetValuation";

const ID = "zenbook";
const WARRANTY = "2031-03-14";
// Bought for $500; the estimator has since made $306 the current value.
const FIELDS = {
  brand: "ASUS", currentValue: 306, currentValueSource: "estimate", purchasePrice: 500,
  warrantyExpiration: WARRANTY,
};
const PROFILE = { id: ID, name: "ASUS ZenBook", type: "asset", notes: "", fields: FIELDS, relatedEvents: [] };
const SPEC = composeOverview({
  now: new Date("2026-11-22T12:00:00Z"),
  entity: { id: ID, name: "ASUS ZenBook", type: "asset", fields: FIELDS },
  related: [],
});
const ALERT_ID = dateAlertId({ sourceEntityType: "profile", sourceEntityId: ID, path: "warrantyExpiration", date: WARRANTY });

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let dismissed: string[] = [];
let history: any[] = [];

beforeEach(() => {
  calls.length = 0;
  dismissed = [];
  history = [];
  queryClient.clear();
  __resetValuationRefreshState();
  queryClient.setQueryData(valuationQueryKey(ID), {
    record: { status: "valued", value: 306, low: 175, high: 437, confidence: 0.4, confidenceLabel: "low", valuedAt: new Date().toISOString(), checkedAt: new Date().toISOString() },
    supported: true, inputFingerprint: "fp", mode: "auto", freshness: { fresh: true, reason: null, detail: "" },
  });
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (url.endsWith("/overview")) return json(SPEC);
    if (url.endsWith("/documents")) return json([]);
    if (url.includes("history=1")) return json({ history });
    if (url === "/api/profiles") return json([{ id: ID, name: "ASUS ZenBook", type: "asset", fields: FIELDS }]);
    if (url === "/api/preferences/dismissed_notifications") return json({ value: JSON.stringify(dismissed) });
    if (url === "/api/notifications/dismiss") { dismissed = [...dismissed, ...body.ids]; return json({ ids: dismissed }); }
    if (url === "/api/notifications/restore") { dismissed = dismissed.filter((i) => !body.ids.includes(i)); return json({ ids: dismissed }); }
    return json({ ok: true });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const writes = () => calls.filter((c) => c.method !== "GET");

function mount(over: { onEdit?: () => void; onDelete?: () => void; onOpenOwnership?: () => void } = {}) {
  const hook = () => [`/profiles/${ID}`, vi.fn()] as [string, (to: string) => void];
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook as any}>
        <DynamicOverview
          profileId={ID}
          renderBody={(spec) => (
            <AssetOverviewBody spec={spec} profile={PROFILE} autoValuation ownerLabel="You own this"
              onOpenOwnership={over.onOpenOwnership}
              summarySlot={<div data-testid="summary">summary</div>} tailSlot={<div data-testid="tail">tail</div>} />
          )}
        />
        <AssetHeroValue profile={PROFILE} />
        <AssetAddDateDialog profileId={ID} fields={FIELDS} open onOpenChange={() => {}} />
        {/* The header's ⋯ menu, open, as the page renders it. */}
        <DropdownMenu open>
          <DropdownMenuTrigger>menu</DropdownMenuTrigger>
          <DropdownMenuContent><AssetAlertMenuItems profileId={ID} /></DropdownMenuContent>
        </DropdownMenu>
      </Router>
    </QueryClientProvider>,
  );
}

describe("the asset page's AI summary is the small one", () => {
  // profile-detail.tsx is ~14k lines behind auth and routing, so this is a
  // source read (as tests/detail-hero.test.ts does): the asset Overview must
  // ask for the compact card, and the compact card must not draw the figure
  // tiles or the value lookup the Value card already has.
  const src = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../client/src/pages/profile-detail.tsx"), "utf8") as string;
  it("the asset Overview renders the compact summary", () => {
    expect(src).toMatch(/<AISummaryCard compact /);
  });
  it("the compact summary is a title and a clamped paragraph, nothing else", () => {
    const start = src.indexOf("  if (compact) {");
    const end = src.indexOf("  // No summary to show", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("AI Asset Summary");
    expect(block).toContain("line-clamp-4");
    expect(block).not.toContain("ai-summary-highlights");
    expect(block).not.toContain("ai-summary-actions");
    expect(block).not.toContain("headerActions");
    expect(block).not.toContain("lookupBanners");
    expect(block).toContain("if (!aiSummary?.summary) return null;"); // nothing to say: no card
  });
  it("an owned thing's summary is asked for as three short sentences", async () => {
    const { withAssetSummaryShape, ASSET_SUMMARY_SHAPE } = await import("@shared/asset-summary-prompt");
    for (const t of ["asset", "vehicle", "property", "investment"]) {
      expect(withAssetSummaryShape(t, "Summarize.")).toContain(ASSET_SUMMARY_SHAPE);
    }
    // People, pets and debts keep their own prompt.
    for (const t of ["person", "self", "pet", "liability", "account"]) {
      expect(withAssetSummaryShape(t, "Summarize.")).toBe("Summarize.");
    }
    expect(ASSET_SUMMARY_SHAPE).toMatch(/AT MOST three short sentences/);
    const routes = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../server/routes.ts"), "utf8") as string;
    expect(routes).toContain("typePrompt = withAssetSummaryShape(detail.type, typePrompt);");
  });
});

describe("asset profile layout", () => {
  it("opening the page writes nothing", async () => {
    mount();
    await screen.findByTestId("asset-details");
    expect(writes()).toEqual([]);
  });

  it("the value graph is the stored valuations on a time axis, with ranges", async () => {
    history = [
      { valuedAt: "2025-01-10T12:00:00.000Z", status: "valued", value: 460 },
      { valuedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), status: "valued", value: 320 },
    ];
    mount();
    await screen.findByTestId("asset-details");
    await waitFor(() => expect(screen.getByTestId("asset-value-graph-start").textContent).toContain("$460"));
    expect(screen.getByTestId("asset-value-graph-end").textContent).toBe("Today · $306");
    expect(screen.getByTestId("asset-value-recent-change").textContent).toContain("−$14");
    // One month: the line starts at the range's edge with the value held from before it.
    fireEvent.click(screen.getByTestId("asset-value-range-1m"));
    expect(screen.getByTestId("asset-value-graph-start").textContent).toContain("$460");
    expect(screen.getByTestId("asset-value-range-1m").getAttribute("aria-pressed")).toBe("true");
  });

  it("with no stored valuations the graph says so instead of drawing a line through nothing", async () => {
    mount();
    await screen.findByTestId("asset-details");
    expect((await screen.findByTestId("asset-value-graph-empty")).textContent).toContain("Not enough valuations");
  });

  it("the Value card says how much it has depreciated: a bar and no confidence", async () => {
    mount();
    await screen.findByTestId("asset-details");
    expect(screen.getByTestId("hero-stat-current-value").textContent).toBe("$306");
    const card = screen.getByTestId("asset-value-card");
    expect(card.textContent).toContain("Value & Depreciation");
    expect(screen.getByTestId("asset-depreciation").textContent).toContain("Depreciated since purchase");
    expect(screen.getByTestId("asset-depreciation-amount").textContent).toBe("−$194 (−38.8%)");
    // $194 of $500 is gone: the bar is 39% full (38.8).
    expect((screen.getByTestId("asset-depreciation-bar") as HTMLElement).style.width).toBe("38.8%");
    expect(screen.getByTestId("asset-depreciation").textContent).toContain("39% of the $500 paid is gone; $306 is left.");
    expect(screen.getByTestId("asset-value-row-current-value").textContent).toContain("$306");
    expect(card.textContent).not.toMatch(/Confidence/);
    // Saved figures and when they were last valued are on screen at once.
    expect(screen.getByTestId("asset-value-last-valued").textContent).toContain("Last valued");
  });

  it("with no purchase price the card asks for it instead of drawing anything", async () => {
    const hook = () => [`/profiles/${ID}`, vi.fn()] as [string, (to: string) => void];
    const bare = { ...PROFILE, fields: { currentValue: 306, currentValueSource: "estimate" } };
    render(<QueryClientProvider client={queryClient}><Router hook={hook as any}><ValueCard profile={bare} /></Router></QueryClientProvider>);
    const block = await screen.findByTestId("asset-depreciation");
    expect(block.textContent).toBe("Add the purchase price below to see how much it has depreciated.");
    expect(screen.queryByTestId("asset-depreciation-bar")).toBeNull();
  });

  it("salvage value is the user's own figure: stored as a number and marked on the bar", async () => {
    mount();
    const line = await screen.findByTestId("asset-value-salvage");
    expect(line.textContent).toContain("Not set");
    expect(screen.queryByTestId("asset-salvage-mark")).toBeNull();
    fireEvent.click(line);
    fireEvent.change(screen.getByTestId("overview-field-input-salvageValue"), { target: { value: "$80" } });
    fireEvent.click(screen.getByTestId("overview-field-input-salvageValue-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { salvageValue: 80 } });
  });

  it("the Overview is three things in order: Value, the summary, Asset details", async () => {
    mount();
    await screen.findByTestId("asset-details");
    const order = ["asset-value-card", "summary", "asset-details", "tail"].map((id) => screen.getByTestId(id));
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    for (let i = 0; i < order.length - 1; i++) expect(follows(order[i], order[i + 1])).toBe(true);
    // What was taken off the Overview stays off.
    for (const gone of ["asset-quick-info", "asset-characteristics", "asset-section-activity", "asset-details-save"]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  it("a line's pencil edits it in place; money is stored as a number", async () => {
    mount();
    const line = await screen.findByTestId("overview-missing-purchasePrice");
    expect(line.textContent).toContain("Purchase price");
    expect(line.textContent).toContain("$500");
    fireEvent.click(line);
    fireEvent.change(screen.getByTestId("overview-field-input-purchasePrice"), { target: { value: "$450" } });
    expect(writes()).toEqual([]); // typing writes nothing
    fireEvent.click(screen.getByTestId("overview-field-input-purchasePrice-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: `/api/profiles/${ID}`, body: { fields: { purchasePrice: 450 } } });
  });

  it("Name, Location and Notes are lines of the same list", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("asset-detail-name"));
    fireEvent.change(screen.getByTestId("asset-name-input"), { target: { value: "ZenBook 14" } });
    fireEvent.click(screen.getByTestId("asset-name-input-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ name: "ZenBook 14" });

    // Location: the same `location` field the chat's update_profile writes.
    fireEvent.click(screen.getByTestId("asset-detail-location"));
    fireEvent.change(screen.getByTestId("overview-field-input-location"), { target: { value: "Office" } });
    fireEvent.click(screen.getByTestId("overview-field-input-location-save"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ fields: { location: "Office" } });

    fireEvent.click(screen.getByTestId("asset-detail-notes"));
    fireEvent.change(screen.getByTestId("asset-notes-input"), { target: { value: "Work laptop" } });
    fireEvent.click(screen.getByTestId("asset-notes-input-save"));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[2].body).toEqual({ notes: "Work laptop" });
  });

  it("a characteristic and a date are lines too; removing one takes two taps", async () => {
    mount();
    const list = await screen.findByTestId("asset-details");
    expect(list.textContent).toContain("ASUS");
    fireEvent.click(screen.getByTestId("overview-field-warrantyExpiration"));
    fireEvent.change(screen.getByTestId("overview-field-input-warrantyExpiration"), { target: { value: "2032-01-01" } });
    fireEvent.click(screen.getByTestId("overview-field-input-warrantyExpiration-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { warrantyExpiration: "2032-01-01" } });

    fireEvent.click(screen.getByTestId("overview-field-brand"));
    fireEvent.click(screen.getByTestId("overview-field-remove-brand"));
    expect(writes()).toHaveLength(1); // the first tap only arms it
    fireEvent.click(screen.getByTestId("overview-field-remove-brand"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ fieldsToDelete: ["brand"] });
  });

  it("alerts are the rule engine's dates, cleared into the server's dismiss list", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    mount();
    const clear = await screen.findByTestId("button-clear-document-alerts");
    await waitFor(() => expect(clear.textContent).toContain("Clear 1 alert"));
    expect(screen.queryByTestId("button-restore-document-alerts")).toBeNull();
    fireEvent.click(clear);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notifications/dismiss", body: { ids: [ALERT_ID] } });
    expect(local).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("button-restore-document-alerts"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ url: "/api/notifications/restore", body: { ids: [ALERT_ID] } });
  });

  it("there is no + Task / + Expense / + Note row; a date is added from the menu's dialog", async () => {
    mount();
    await screen.findByTestId("asset-details");
    for (const gone of ["asset-quick-add", "quick-add-task", "quick-add-expense", "quick-add-note", "quick-add-more"]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
    // The warranty date is already on the record, so the form does not offer it again.
    const kind = screen.getByTestId("asset-add-date-kind") as HTMLSelectElement;
    expect(Array.from(kind.options).map((o) => o.value)).not.toContain("warrantyExpiration");
    fireEvent.change(kind, { target: { value: "insuranceExpiration" } });
    fireEvent.change(screen.getByTestId("asset-add-date-day"), { target: { value: "2027-06-01" } });
    fireEvent.click(screen.getByTestId("asset-add-date-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { insuranceExpiration: "2027-06-01" } });
  });

  it("Ownership opens its tab, and Add characteristic is the plain Field | Value form", async () => {
    const onOpenOwnership = vi.fn();
    mount({ onOpenOwnership });
    await screen.findByTestId("asset-details");
    fireEvent.click(screen.getByTestId("asset-detail-ownership"));
    expect(onOpenOwnership).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);

    fireEvent.click(screen.getByTestId("asset-add-characteristic"));
    fireEvent.change(screen.getByTestId("add-field-key"), { target: { value: "Serial number" } });
    fireEvent.change(screen.getByTestId("add-field-value"), { target: { value: "ZX-1" } });
    fireEvent.click(screen.getByTestId("add-field-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { "Serial number": "ZX-1" } });
  });
});
