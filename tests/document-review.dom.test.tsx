// @vitest-environment jsdom
//
// The full-screen extraction review (#/documents/:id/review) — the page a
// single upload lands on after the user picks which profile it belongs to.
//
// These tests pin the page's contract, not its pixels: every extracted row is
// on the table with its confidence and proposed destination; the category
// chips filter without losing rows; and — the part that matters — the user's
// choices reach the confirm payload under the same partition rule as the
// inline pane: a row a selected action is writing never also travels as a
// loose item.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async () => ({ json: async () => [] })),
  BROWSER_TIMEZONE: "America/Los_Angeles",
}));

// The preview pulls the binary through an authenticated blob hook — pure
// plumbing this suite is not about.
vi.mock("@/lib/document-preview", () => ({
  useDocumentBlobUrl: () => ({ url: null, blob: null, loading: false, error: null }),
  classifyDocument: () => "pdf",
  prefetchDocumentBlob: () => {},
}));

vi.mock("@/lib/chat-sync", () => ({
  applyChatMutations: vi.fn(async () => {}),
}));

import { DocumentReviewScreen } from "../client/src/pages/document-review";
import { planExtractionActions } from "../shared/extraction-actions";
import { insuranceDeclarations } from "./document-fixtures";

const DOC = "doc-1";

function buildExtraction() {
  const plan = planExtractionActions({
    semantic: insuranceDeclarations.semantic,
    items: insuranceDeclarations.items,
    index: insuranceDeclarations.index,
    primaryProfileId: insuranceDeclarations.primaryProfileId,
    documentId: DOC,
    documentName: "Declarations Page",
    today: "2026-08-25",
  });
  return {
    extractionId: DOC,
    fileName: "declarations.pdf",
    documentType: "insurance_policy",
    label: "Summit Peak — Declarations Page",
    extractedFields: [],
    items: plan.items,
    actionPlan: plan,
    semantic: insuranceDeclarations.semantic,
    trackerEntries: [],
    calendarDates: [],
    documentName: "Declarations Page",
  } as any;
}

function renderScreen(
  extraction = buildExtraction(),
  onConfirm = vi.fn(async () => true),
  onDone = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <DocumentReviewScreen
        documentId={DOC}
        extraction={extraction}
        onConfirm={onConfirm}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onConfirm, onDone };
}

const confirmPayload = (onConfirm: any) => onConfirm.mock.calls.at(-1)?.[0];

describe("the review page shows everything the document produced", () => {
  afterEach(cleanup);

  it("renders one table row per extracted item, with the total in the header", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const rows = within(screen.getByTestId("review-rows")).getAllByRole("row");
    expect(rows.length).toBe(extraction.items.length);
    expect(screen.getByTestId("review-extracted-count").textContent)
      .toContain(`(${extraction.items.length} total)`);
  });

  it("shows a confidence percentage sourced from the semantic facts", () => {
    renderScreen();
    // f-policy carries 0.95 → the Policy Number row must say 95%.
    const row = screen.getByTestId("review-row-field-policynumber");
    expect(row.textContent).toContain("95%");
  });

  it("lists the document's related entities", () => {
    renderScreen();
    const rail = screen.getByTestId("review-entities");
    expect(rail.textContent).toContain("Summit Peak Insurance Group");
    expect(rail.textContent).toContain("Pinnacle Home Loans, LLC");
    expect(rail.textContent).toContain(`(${insuranceDeclarations.semantic.entities.length})`);
  });

  it("lists the proposed actions in the rail", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const rail = screen.getByTestId("review-suggested-actions");
    const proposable = extraction.actionPlan.actions.filter((a: any) => a.operation !== "NO_ACTION");
    expect(rail.textContent).toContain(`(${proposable.length})`);
  });
});

describe("the category chips filter without destroying state", () => {
  afterEach(cleanup);

  it("filters to date rows and back to everything", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const all = within(screen.getByTestId("review-rows")).getAllByRole("row").length;

    fireEvent.click(screen.getByTestId("chip-dates"));
    const dates = within(screen.getByTestId("review-rows")).getAllByRole("row").length;
    expect(dates).toBeGreaterThan(0);
    expect(dates).toBeLessThan(all);

    fireEvent.click(screen.getByTestId("chip-all"));
    expect(within(screen.getByTestId("review-rows")).getAllByRole("row").length).toBe(all);
  });

  it("search narrows by label", () => {
    renderScreen();
    fireEvent.change(screen.getByTestId("input-review-search"), { target: { value: "Policy Number" } });
    const rows = within(screen.getByTestId("review-rows")).getAllByRole("row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Policy Number");
  });
});

describe("confirm sends the reviewed decisions, exactly once each", () => {
  afterEach(cleanup);

  it("partitions: a row a selected action claims never travels as a loose item", async () => {
    const { onConfirm } = renderScreen();
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const payload = confirmPayload(onConfirm);
    expect(payload.extractionId).toBe(DOC);
    expect(Array.isArray(payload.actions)).toBe(true);
    const claimed = new Set(
      payload.actions
        .filter((a: any) => a.selected && a.operation !== "NO_ACTION")
        .flatMap((a: any) => a.itemIds),
    );
    for (const item of payload.items ?? []) {
      expect(claimed.has(item.id)).toBe(false);
    }
  });

  it("a row skipped in the table stays out of the loose items", async () => {
    const extraction = buildExtraction();
    // Pick a row no action claims, so it would otherwise travel as an item.
    const claimed = new Set(extraction.actionPlan.actions.flatMap((a: any) => a.itemIds));
    const loose = extraction.items.find((i: any) => !claimed.has(i.id) && i.selected);
    expect(loose).toBeTruthy();

    const { onConfirm } = renderScreen(extraction);
    fireEvent.change(screen.getByTestId(`review-action-${loose.id}`), { target: { value: "skip" } });
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const sent = (confirmPayload(onConfirm).items ?? []).find((i: any) => i.id === loose.id);
    expect(sent?.selected).toBe(false);
  });

  it("editing a value sends the edited value, not the extracted one", async () => {
    const { onConfirm } = renderScreen();
    fireEvent.change(screen.getByTestId("review-value-field-squarefeet"), { target: { value: "2500" } });
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const payload = confirmPayload(onConfirm);
    const everywhere = [
      ...(payload.items ?? []),
      ...(payload.actions ?? []).flatMap((a: any) =>
        a.payload?.fields ? Object.entries(a.payload.fields).map(([key, value]) => ({ key, value })) : []),
    ];
    const sqft = everywhere.filter((r: any) => r.key === "squareFeet");
    expect(sqft.length).toBeGreaterThan(0);
    for (const r of sqft) expect(String(r.value)).toBe("2500");
  });

  it("Skip All leaves without confirming", () => {
    const { onConfirm, onDone } = renderScreen();
    fireEvent.click(screen.getByTestId("btn-skip-all"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith("skipped");
  });

  it("a successful confirm leaves the page", async () => {
    const { onDone } = renderScreen();
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("confirmed"));
  });
});

describe("auto-map is the one switch between proposed and manual", () => {
  afterEach(cleanup);

  it("off deselects everything; on restores the proposed routing", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const summary = () => screen.getByTestId("review-selected-summary").textContent || "";

    fireEvent.click(screen.getByTestId("switch-auto-map"));
    expect(summary()).toContain(`0 of ${extraction.items.length} selected`);

    fireEvent.click(screen.getByTestId("switch-auto-map"));
    expect(summary()).not.toContain(`0 of ${extraction.items.length} selected`);
  });
});
