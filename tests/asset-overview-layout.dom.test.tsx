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
//   · + Task / + Expense create ordinary records linked to this asset
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
import { AssetOverviewBody, AssetAlertMenuItems, AssetHeroValue, AssetQuickAdd } from "@/components/asset/AssetOverviewLayout";
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

beforeEach(() => {
  calls.length = 0;
  dismissed = [];
  queryClient.clear();
  __resetValuationRefreshState();
  queryClient.setQueryData(valuationQueryKey(ID), {
    record: { status: "valued", value: 306, low: 175, high: 437, confidence: 0.4, confidenceLabel: "low", valuedAt: new Date().toISOString() },
    supported: true, inputFingerprint: "fp", mode: "auto", freshness: { fresh: true, reason: null, detail: "" },
  });
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (url.endsWith("/overview")) return json(SPEC);
    if (url.endsWith("/documents")) return json([]);
    if (url.includes("history=1")) return json({ history: [] });
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
              onOpenOwnership={over.onOpenOwnership} onEdit={over.onEdit ?? (() => {})}
              summarySlot={<div data-testid="summary">summary</div>} tailSlot={<div data-testid="tail">tail</div>} />
          )}
        />
        <AssetHeroValue profile={PROFILE} />
        <AssetQuickAdd profileId={ID} onEdit={over.onEdit ?? (() => {})} />
        {/* The header's ⋯ menu, open, as the page renders it. */}
        <DropdownMenu open>
          <DropdownMenuTrigger>menu</DropdownMenuTrigger>
          <DropdownMenuContent><AssetAlertMenuItems profileId={ID} /></DropdownMenuContent>
        </DropdownMenu>
      </Router>
    </QueryClientProvider>,
  );
}

describe("asset profile layout", () => {
  it("opening the page writes nothing", async () => {
    mount();
    await screen.findByTestId("asset-details");
    await screen.findByTestId("asset-alert-row");
    expect(writes()).toEqual([]);
  });

  it("the header shows only the value; the other figures are the Value card's", async () => {
    mount();
    await screen.findByTestId("asset-details");
    expect(screen.getByTestId("hero-stat-current-value").textContent).toBe("$306");
    expect(screen.queryByTestId("hero-stat-purchase-price")).toBeNull();
    const card = screen.getByTestId("asset-value-card");
    expect(card.textContent).toContain("Value & Depreciation");
    expect(screen.getByTestId("asset-value-row-purchase-price").textContent).toBe("Purchase Price$500");
    expect(screen.getByTestId("asset-value-row-current-value").textContent).toBe("Current Value$306");
    expect(screen.getByTestId("asset-value-row-depreciation").textContent).toBe("Depreciation−$194");
    expect(screen.getByTestId("asset-value-row-change").textContent).toBe("Change−38.8%");
    expect(screen.getByTestId("asset-value-row-confidence").textContent).toBe("Confidence40%");
  });

  it("the page reads value, details, summary, characteristics — then the page's own cards", async () => {
    mount();
    await screen.findByTestId("asset-details");
    const order = ["asset-value-card", "asset-details", "summary", "asset-characteristics", "tail"].map((id) => screen.getByTestId(id));
    // Value comes first for a reader (CSS `order` on a phone); in the document
    // it follows Asset Details, which a wide screen draws beside it.
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(order[1], order[2])).toBe(true);
    expect(follows(order[0], order[2])).toBe(true);
    expect(follows(order[2], order[3])).toBe(true);
    expect(follows(order[3], order[4])).toBe(true);
    expect(screen.getByTestId("asset-section-details").className).toContain("order-2");
    expect(order[0].parentElement!.className).toContain("order-1");
  });

  it("the form saves what changed, in one write; money is stored as a number", async () => {
    mount();
    await screen.findByTestId("asset-details");
    const save = screen.getByTestId("asset-details-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing typed yet
    fireEvent.change(screen.getByTestId("asset-name-input"), { target: { value: "ZenBook 14" } });
    fireEvent.change(screen.getByTestId("overview-field-input-purchasePrice"), { target: { value: "$450" } });
    fireEvent.change(screen.getByTestId("overview-field-input-location"), { target: { value: "Office" } });
    fireEvent.change(screen.getByTestId("asset-notes-input"), { target: { value: "Work laptop" } });
    fireEvent.change(screen.getByTestId("overview-field-input-warrantyExpiration"), { target: { value: "2032-01-01" } });
    expect(writes()).toEqual([]); // typing writes nothing
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: `/api/profiles/${ID}` });
    expect(writes()[0].body).toEqual({
      name: "ZenBook 14", notes: "Work laptop",
      fields: { purchasePrice: 450, location: "Office", warrantyExpiration: "2032-01-01" },
    });
  });

  it("clearing a box removes that field; Undo puts back what was there", async () => {
    mount();
    const price = (await screen.findByTestId("overview-field-input-purchasePrice")) as HTMLInputElement;
    expect(price.value).toBe("500");
    fireEvent.change(price, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("asset-details-undo"));
    expect(price.value).toBe("500");
    expect(writes()).toEqual([]);
    fireEvent.change(price, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("asset-details-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fieldsToDelete: ["purchasePrice"] });
  });

  it("a characteristic is changed with its pencil and removed with its X in two taps", async () => {
    mount();
    const panel = await screen.findByTestId("asset-characteristics");
    expect(panel.textContent).toContain("ASUS");
    fireEvent.click(screen.getByTestId("overview-field-brand"));
    fireEvent.change(screen.getByTestId("overview-field-input-brand"), { target: { value: "Asus" } });
    fireEvent.click(screen.getByTestId("overview-field-save-brand"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { brand: "Asus" } });

    fireEvent.click(await screen.findByTestId("overview-field-remove-brand"));
    expect(writes()).toHaveLength(1); // the first tap only arms it
    fireEvent.click(screen.getByTestId("overview-field-remove-brand"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ fieldsToDelete: ["brand"] });
  });

  it("alerts are the rule engine's dates, cleared into the server's dismiss list", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    mount();
    const row = await screen.findByTestId("asset-alert-row");
    expect(row.textContent).toContain("Warranty Expiration");
    expect(screen.queryByTestId("button-restore-document-alerts")).toBeNull();

    fireEvent.click(screen.getByTestId("button-clear-document-alerts"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notifications/dismiss", body: { ids: [ALERT_ID] } });
    expect(local).not.toHaveBeenCalled();

    // A cleared alert leaves Quick Info, and can be brought back from the same place.
    await waitFor(() => expect(screen.queryByTestId("asset-alert-row")).toBeNull());
    fireEvent.click(await screen.findByTestId("button-restore-document-alerts"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ url: "/api/notifications/restore", body: { ids: [ALERT_ID] } });
  });

  it("+ Task and + Expense create ordinary records linked to this asset", async () => {
    mount();
    await screen.findByTestId("asset-details");
    fireEvent.click(screen.getByTestId("quick-add-task"));
    fireEvent.change(screen.getByTestId("quick-task-title"), { target: { value: "Renew warranty" } });
    fireEvent.change(screen.getByTestId("quick-task-due"), { target: { value: "2027-01-05" } });
    fireEvent.click(screen.getByTestId("quick-task-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/tasks", body: { title: "Renew warranty", dueDate: "2027-01-05", linkedProfiles: [ID] } });

    fireEvent.click(screen.getByTestId("quick-add-expense"));
    fireEvent.change(screen.getByTestId("quick-expense-amount"), { target: { value: "39.99" } });
    fireEvent.change(screen.getByTestId("quick-expense-what"), { target: { value: "Charger" } });
    fireEvent.change(screen.getByTestId("quick-expense-day"), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByTestId("quick-expense-save"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ method: "POST", url: "/api/expenses", body: { amount: 39.99, description: "Charger", date: "2026-11-20", linkedProfiles: [ID] } });
  });

  it("Edit and ownership open the page's own controls and write nothing", async () => {
    const onEdit = vi.fn(), onOpenOwnership = vi.fn();
    mount({ onEdit, onOpenOwnership });
    await screen.findByTestId("asset-details");
    fireEvent.click(screen.getByTestId("asset-details-edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("asset-detail-ownership"));
    expect(onOpenOwnership).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);

    // Add Characteristic is the same Field | Value | Add form as every profile.
    fireEvent.click(screen.getByTestId("asset-add-characteristic"));
    fireEvent.change(screen.getByTestId("add-field-key"), { target: { value: "Serial number" } });
    fireEvent.change(screen.getByTestId("add-field-value"), { target: { value: "ZX-1" } });
    fireEvent.click(screen.getByTestId("add-field-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { "Serial number": "ZX-1" } });
  });
});
