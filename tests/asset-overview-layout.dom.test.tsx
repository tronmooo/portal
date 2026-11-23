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
//   · Delete only asks; it never deletes on its own (Rule 8)
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
import { AssetOverviewBody, AssetProfileActions, AssetHeroStats, AssetQuickAdd } from "@/components/asset/AssetOverviewLayout";
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
              onOpenOwnership={over.onOpenOwnership} onEdit={over.onEdit ?? (() => {})} />
          )}
        />
        <AssetHeroStats profile={PROFILE} />
        <AssetQuickAdd profileId={ID} onEdit={over.onEdit ?? (() => {})} />
        <AssetProfileActions profileId={ID} onEdit={over.onEdit ?? (() => {})} onDelete={over.onDelete ?? (() => {})} />
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

  it("the header shows the estimate as Current Value, against the purchase price", async () => {
    mount();
    await screen.findByTestId("asset-details");
    expect(screen.getByTestId("hero-stat-current-value").textContent).toBe("Current Value$306");
    expect(screen.getByTestId("hero-stat-purchase-price").textContent).toBe("Purchase Price$500");
    expect(screen.getByTestId("hero-stat-change").textContent).toBe("Depreciation−$194 (39%)");
    expect(screen.getByTestId("hero-stat-confidence").textContent).toBe("Confidence40%");
    // The same numbers, as the Value & Depreciation table.
    const card = screen.getByTestId("asset-value-card");
    expect(card.textContent).toContain("Value & Depreciation");
    expect(screen.getByTestId("asset-value-row-change").textContent).toBe("Change−38.8%");
  });

  it("a row writes the field it names; money is stored as a number", async () => {
    mount();
    const row = await screen.findByTestId("overview-missing-purchasePrice");
    expect(row.textContent).toContain("Purchase Price");
    fireEvent.click(row);
    fireEvent.change(screen.getByTestId("overview-field-input-purchasePrice"), { target: { value: "$450" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: `/api/profiles/${ID}`, body: { fields: { purchasePrice: 450 } } });
  });

  it("a characteristic can be removed in two taps", async () => {
    mount();
    const panel = await screen.findByTestId("asset-characteristics");
    expect(panel.textContent).toContain("ASUS");
    fireEvent.click(screen.getByTestId("overview-field-brand"));
    fireEvent.click(screen.getByTestId("overview-field-remove-brand"));
    expect(writes()).toEqual([]); // the first tap only arms it
    fireEvent.click(screen.getByTestId("overview-field-remove-brand"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fieldsToDelete: ["brand"] });
  });

  it("Name, Location and Notes are edited where they are shown", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("asset-detail-name"));
    fireEvent.change(screen.getByTestId("asset-name-input"), { target: { value: "ZenBook 14" } });
    fireEvent.click(screen.getByTestId("asset-name-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: `/api/profiles/${ID}`, body: { name: "ZenBook 14" } });

    // Location: the same `location` field the chat's update_profile writes.
    fireEvent.click(screen.getByTestId("asset-detail-location"));
    fireEvent.change(screen.getByTestId("overview-field-input-location"), { target: { value: "Office" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ fields: { location: "Office" } });

    fireEvent.click(screen.getByTestId("asset-detail-notes"));
    fireEvent.change(screen.getByTestId("asset-notes-input"), { target: { value: "Work laptop" } });
    fireEvent.click(screen.getByTestId("asset-notes-save"));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[2].body).toEqual({ notes: "Work laptop" });
  });

  it("an odd row out takes the whole row, so the panel has no empty half", async () => {
    mount();
    const grid = (await screen.findByTestId("asset-detail-location")).parentElement!;
    // Name and Notes are always full width; of the rows between, the last of an odd count spans.
    const cells = Array.from(grid.children).slice(1, -1);
    const spans = cells.filter((c) => c.className.includes("sm:col-span-2"));
    expect(spans.length).toBe(cells.length % 2);
    if (spans.length) expect(spans[0]).toBe(cells[cells.length - 1]);
  });

  it("a date on the record is a row that can be changed, and one can be added", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("overview-field-warrantyExpiration"));
    fireEvent.change(screen.getByTestId("overview-field-input-warrantyExpiration"), { target: { value: "2032-01-01" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { warrantyExpiration: "2032-01-01" } });

    fireEvent.click(screen.getByTestId("asset-add-date"));
    fireEvent.change(screen.getByTestId("asset-add-date-kind"), { target: { value: "insuranceExpiration" } });
    fireEvent.change(screen.getByTestId("asset-add-date-day"), { target: { value: "2027-06-01" } });
    fireEvent.click(screen.getByTestId("asset-add-date-save"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ fields: { insuranceExpiration: "2027-06-01" } });
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

  it("Edit, ownership and delete open the page's own controls; nothing is deleted here", async () => {
    const onEdit = vi.fn(), onDelete = vi.fn(), onOpenOwnership = vi.fn();
    mount({ onEdit, onDelete, onOpenOwnership });
    await screen.findByTestId("asset-details");
    fireEvent.click(screen.getByTestId("asset-details-edit"));
    fireEvent.click(screen.getByTestId("action-edit-profile"));
    expect(onEdit).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("asset-detail-ownership"));
    expect(onOpenOwnership).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("button-delete-profile-info-tab"));
    expect(onDelete).toHaveBeenCalledTimes(1);
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
