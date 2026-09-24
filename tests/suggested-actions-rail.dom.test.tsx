// @vitest-environment jsdom
//
// The Suggested Actions rail is the plan the confirmation executes.
//
// User report 2026-09-22: an auto insurance card (Progressive, Honda CR-V,
// expires 04/05/2027) produced an expiration rule the rail never showed. These
// tests pin the acceptance list from that report: the expiration appears with
// its downstream effects, unticking its row removes them, re-ticking restores
// them, and what Confirm sends is exactly what the rail shows.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async () => ({ json: async () => [] })),
  BROWSER_TIMEZONE: "America/Los_Angeles",
}));
vi.mock("@/lib/document-preview", () => ({
  useDocumentBlobUrl: () => ({ url: null, blob: null, loading: false, error: null }),
  classifyDocument: () => "pdf",
  prefetchDocumentBlob: () => {},
}));
vi.mock("@/lib/chat-sync", () => ({ applyChatMutations: vi.fn(async () => {}) }));

import { DocumentReviewScreen } from "../client/src/pages/document-review";
import { planExtractionActions, type EntityIndex } from "../shared/extraction-actions";
import type { ExtractionItem } from "../shared/extraction-destinations";
import type { SemanticDocument } from "../shared/semantic-document";

const DOC = "doc-card";

const item = (key: string, label: string, value: any): ExtractionItem => ({
  id: `field-${key.toLowerCase()}`, key, label, value,
  destination: "profile", destinationOptions: ["profile", "note", "ignore"], selected: true, source: "field",
});

function buildExtraction() {
  const items = [
    item("policyNumber", "Policy Number", "907344659"),
    item("effectiveDate", "Effective Date", "10/05/2026"),
    item("expirationDate", "Expiration Date", "04/05/2027"),
  ];
  const index: EntityIndex = {
    profiles: [{ id: "car-1", type: "vehicle", name: "Honda CR-V 2021", fields: {} }],
    obligations: [], expenses: [], trackers: [], links: [],
  };
  const semantic: SemanticDocument = {
    documentType: "Auto Insurance ID Card",
    primarySubject: "e-car",
    confidence: 0.93,
    summary: "",
    entities: [
      { ref: "e-car", kind: "vehicle", name: "Honda CR-V 2021", identifiers: {}, confidence: 0.95 },
      { ref: "e-policy", kind: "account", name: "Progressive Auto Policy 907344659", identifiers: {}, confidence: 0.9 },
    ],
    relationships: [],
    facts: [
      { id: "f-eff", itemIds: ["field-effectivedate"], label: "Effective Date", value: "10/05/2026", roles: ["document_metadata"], subject: { entityRef: "e-policy", confidence: 0.9 }, volatility: "changeable", confidence: 0.92 },
      { id: "f-exp", itemIds: ["field-expirationdate"], label: "Expiration Date", value: "04/05/2027", roles: ["document_metadata"], subject: { entityRef: "e-policy", confidence: 0.9 }, volatility: "changeable", confidence: 0.92 },
    ],
    recurrences: [],
    narrative: [],
  };
  const plan = planExtractionActions({
    semantic, items, index, documentId: DOC, documentName: "IMG_1199.jpeg", today: "2026-09-22",
  });
  return {
    extractionId: DOC,
    fileName: "IMG_1199.jpeg",
    documentType: "insurance_card",
    label: "Auto insurance card",
    extractedFields: [{ key: "expirationDate", label: "Expiration Date", value: "04/05/2027", selected: true, isDate: true }],
    items: plan.items,
    actionPlan: plan,
    semantic,
    trackerEntries: [],
    documentName: "IMG_1199.jpeg",
  } as any;
}

function renderScreen(onConfirm = vi.fn(async () => true)) {
  const extraction = buildExtraction();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DocumentReviewScreen documentId={DOC} extraction={extraction} onConfirm={onConfirm} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
  const expiry = extraction.actionPlan.actions.find(
    (a: any) => a.destination === "calendar" && a.itemIds.includes("field-expirationdate"),
  );
  return { onConfirm, expiry };
}

describe("the Suggested Actions rail shows the expiration and everything it causes", () => {
  afterEach(cleanup);

  it("lists the expiration date with its rule, calendar, upcoming and alert effects", () => {
    const { expiry } = renderScreen();
    expect(expiry).toBeTruthy();
    expect(screen.getByTestId(`suggested-action-${expiry.id}`)).toBeTruthy();
    const effects = screen.getByTestId(`action-effects-${expiry.id}`).textContent || "";
    expect(effects).toMatch(/Apr 5, 2027/);
    expect(effects).toMatch(/expiration rule/i);
    expect(effects).toMatch(/Calendar/);
    expect(effects).toMatch(/Upcoming/);
    expect(effects).toMatch(/Notify before it expires/);
  });

  it("unticking the Expiration Date row unticks its action; re-ticking restores it", () => {
    const { expiry } = renderScreen();
    const check = () => screen.getByTestId(`suggested-action-check-${expiry.id}`);
    expect(check().getAttribute("data-state")).toBe("checked");
    const row = () => screen.getByLabelText("Include Expiration Date");
    fireEvent.click(row());
    expect(check().getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(row());
    expect(check().getAttribute("data-state")).toBe("checked");
  });

  it("Confirm sends the rail's actions and no side-channel calendar dates", async () => {
    const { onConfirm, expiry } = renderScreen();
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const payload = (onConfirm.mock.calls.at(-1) as any)[0];
    expect(payload.calendarDates).toEqual([]);
    const sent = payload.actions.find((a: any) => a.id === expiry.id);
    expect(sent.selected).toBe(true);
  });
});
