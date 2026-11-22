// @vitest-environment jsdom
//
// The asset profile's layout (owner's mock-up, 2026-11-22) is a new drawing of
// stores other screens already read. What is pinned here is the wiring:
//
//   · a "Not set" tile writes the one field it names, with the page's PATCH
//   · Financial position is the user's number against currentAssetValue
//   · the Alerts card is the date-rule engine's answer for this record, and
//     "Clear document alerts" dismisses into the SERVER's dismiss list under
//     the id the bell uses — never the browser-only snooze (Rule 8)
//   · opening the page writes nothing (Rule 3)
//   · a failed documents load is not "No documents yet" (Rule 7)
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
import { AssetOverviewBody, AssetProfileActions } from "@/components/asset/AssetOverviewLayout";
import { __resetValuationRefreshState, valuationQueryKey } from "@/hooks/useAssetValuation";

const ID = "zenbook";
const WARRANTY = "2031-03-14";
// The user typed $500; the estimator has since made $306 the current value.
const FIELDS = {
  brand: "ASUS", currentValue: 306, currentValueSource: "estimate", userEnteredValue: 500,
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

let failDocuments = false;
let dismissed: string[] = [];

beforeEach(() => {
  calls.length = 0;
  failDocuments = false;
  dismissed = [];
  queryClient.clear();
  __resetValuationRefreshState();
  queryClient.setQueryData(valuationQueryKey(ID), {
    record: { status: "valued", value: 306, low: 175, high: 437, valuedAt: new Date().toISOString() },
    supported: true, inputFingerprint: "fp", mode: "auto", freshness: { fresh: true, reason: null, detail: "" },
  });
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (url.endsWith("/overview")) return json(SPEC);
    if (url.endsWith("/documents")) { if (failDocuments) throw new Error("500"); return json([]); }
    if (url === "/api/profiles") return json([{ id: ID, name: "ASUS ZenBook", type: "asset", fields: FIELDS }]);
    if (url === "/api/preferences/dismissed_notifications") return json({ value: JSON.stringify(dismissed) });
    if (url === "/api/notifications/dismiss") { dismissed = [...dismissed, ...body.ids]; return json({ ids: dismissed }); }
    if (url === "/api/notifications/restore") { dismissed = dismissed.filter((i) => !body.ids.includes(i)); return json({ ids: dismissed }); }
    return json({ ok: true });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const writes = () => calls.filter((c) => c.method !== "GET");

function mount(over: { onEdit?: () => void; onDelete?: () => void; onOpenDocuments?: () => void } = {}) {
  const hook = () => [`/profiles/${ID}`, vi.fn()] as [string, (to: string) => void];
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook as any}>
        <DynamicOverview
          profileId={ID}
          renderBody={(spec) => (
            <AssetOverviewBody spec={spec} profile={PROFILE} autoValuation onEdit={over.onEdit ?? (() => {})} onOpenDocuments={over.onOpenDocuments} />
          )}
        />
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

  it("a Not set tile writes the field it names", async () => {
    mount();
    const tile = await screen.findByTestId("overview-missing-purchasePrice");
    expect(tile.textContent).toContain("Purchase price");
    expect(tile.textContent).toContain("Not set");
    fireEvent.click(tile);
    fireEvent.change(screen.getByTestId("overview-field-input-purchasePrice"), { target: { value: "$450" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: `/api/profiles/${ID}`, body: { fields: { purchasePrice: "450" } } });
  });

  it("an existing field opens as a tile that can be removed in two taps", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("overview-field-brand"));
    const remove = screen.getByTestId("overview-field-remove-brand");
    fireEvent.click(remove);
    expect(writes()).toEqual([]); // the first tap only arms it
    fireEvent.click(screen.getByTestId("overview-field-remove-brand"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fieldsToDelete: ["brand"] });
  });

  it("Financial position is the user's number against the current value", async () => {
    mount();
    await screen.findByTestId("asset-financial-position");
    expect(screen.getByTestId("asset-detail-entered-value").textContent).toContain("$500");
    expect(screen.getByTestId("asset-position-start").textContent).toBe("$500");
    expect(screen.getByTestId("asset-position-now").textContent).toBe("$306");
    expect(screen.getByTestId("asset-position-change").textContent).toBe("−38.8% (−$194)");
  });

  it("Alerts are the rule engine's dates, cleared into the server's dismiss list", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    mount();
    const row = await screen.findByTestId("asset-alert-row");
    expect(row.textContent).toContain("Warranty Expiration");
    expect(screen.queryByTestId("button-restore-document-alerts")).toBeNull();

    fireEvent.click(screen.getByTestId("button-clear-document-alerts"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/api/notifications/dismiss", body: { ids: [ALERT_ID] } });
    expect(local).not.toHaveBeenCalled();

    // Cleared is shown, and can be undone from the same place.
    await screen.findByTestId("asset-alerts-cleared");
    expect(screen.queryByTestId("asset-alert-row")).toBeNull();
    fireEvent.click(await screen.findByTestId("button-restore-document-alerts"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ url: "/api/notifications/restore", body: { ids: [ALERT_ID] } });
  });

  it("a date added from Calendar & reminders is written as that field", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("asset-add-date"));
    fireEvent.change(screen.getByTestId("asset-add-date-kind"), { target: { value: "insuranceExpiration" } });
    fireEvent.change(screen.getByTestId("asset-add-date-day"), { target: { value: "2027-06-01" } });
    fireEvent.click(screen.getByTestId("asset-add-date-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { insuranceExpiration: "2027-06-01" } });
  });

  it("a failed documents load is not an empty list", async () => {
    failDocuments = true;
    mount();
    const card = await screen.findByTestId("asset-documents-card");
    await waitFor(() => expect(card.textContent).toContain("Couldn't load documents"));
    expect(card.textContent).not.toContain("No documents yet");
  });

  it("Profile actions open the page's own edit and delete; nothing is deleted here", async () => {
    const onEdit = vi.fn(), onDelete = vi.fn(), onOpenDocuments = vi.fn();
    mount({ onEdit, onDelete, onOpenDocuments });
    await screen.findByTestId("asset-details");
    fireEvent.click(screen.getByTestId("action-edit-profile"));
    fireEvent.click(screen.getByTestId("asset-detail-notes"));
    expect(onEdit).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("asset-add-document"));
    expect(onOpenDocuments).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("button-delete-profile-info-tab"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);

    // Add custom field opens the same Field | Value | Add form as every profile.
    fireEvent.click(screen.getByTestId("action-add-field"));
    fireEvent.change(screen.getByTestId("add-field-key"), { target: { value: "Serial number" } });
    fireEvent.change(screen.getByTestId("add-field-value"), { target: { value: "ZX-1" } });
    fireEvent.click(screen.getByTestId("add-field-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { "Serial number": "ZX-1" } });
  });
});
