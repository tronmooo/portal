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

// Item rows only — the table now also renders section-header <tr>s.
const itemRows = () =>
  Array.from(document.querySelectorAll('[data-testid^="review-row-"]'));
const sectionRows = () =>
  Array.from(document.querySelectorAll('[data-testid^="review-section-"]'));

describe("the review page shows everything the document produced", () => {
  afterEach(cleanup);

  it("renders one table row per extracted item, with the total in the header", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    expect(itemRows().length).toBe(extraction.items.length);
    expect(screen.getByTestId("review-extracted-count").textContent)
      .toContain(`(${extraction.items.length} total)`);
  });

  it("groups the rows into document-driven sections", () => {
    renderScreen();
    // An insurance declarations page is not one flat list: dates, policy
    // details and entity data come out as separate labelled sections.
    expect(sectionRows().length).toBeGreaterThan(2);
    const dates = document.querySelector('[data-testid="review-section-dates-deadlines"]');
    expect(dates?.textContent).toContain("Dates & Deadlines");
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
    const all = itemRows().length;

    fireEvent.click(screen.getByTestId("chip-dates"));
    const dates = itemRows().length;
    expect(dates).toBeGreaterThan(0);
    expect(dates).toBeLessThan(all);

    fireEvent.click(screen.getByTestId("chip-all"));
    expect(itemRows().length).toBe(all);
  });

  it("search narrows by label", () => {
    renderScreen();
    fireEvent.change(screen.getByTestId("input-review-search"), { target: { value: "Policy Number" } });
    const rows = itemRows();
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

  it("a re-routed row reaches the payload with the destination the user chose", async () => {
    const extraction = buildExtraction();
    // A loose row (no selected action claims it) that can be sent somewhere else.
    const claimed = new Set(
      extraction.actionPlan.actions
        .filter((a: any) => a.selected && a.operation !== "NO_ACTION")
        .flatMap((a: any) => a.itemIds),
    );
    const loose = extraction.items.find(
      (i: any) => !claimed.has(i.id) && i.destinationOptions.length > 1,
    );
    expect(loose).toBeTruthy();
    const newDest = loose.destinationOptions.find(
      (d: string) => d !== loose.destination && d !== "ignore",
    );
    expect(newDest).toBeTruthy();

    const { onConfirm } = renderScreen(extraction);
    fireEvent.change(screen.getByTestId(`review-destination-${loose.id}`), { target: { value: newDest } });
    fireEvent.click(screen.getByTestId("btn-confirm-all"));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const sent = (confirmPayload(onConfirm).items ?? []).find((i: any) => i.id === loose.id);
    expect(sent?.destination).toBe(newDest);
    expect(sent?.selected).toBe(true);
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

  it("off clears every row; on restores the routing", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const summary = () => screen.getByTestId("review-selected-summary").textContent || "";

    fireEvent.click(screen.getByTestId("switch-auto-map"));
    // Hand-pick mode starts from nothing selected — there is no floor of one.
    expect(summary()).toMatch(/0 of \d+ field/);

    fireEvent.click(screen.getByTestId("switch-auto-map"));
    expect(summary()).not.toMatch(/0 of \d+ field/);
  });

  it("off leaves the suggested actions alone — fields and actions are separate decisions", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const summary = () => screen.getByTestId("review-selected-summary").textContent || "";

    fireEvent.click(screen.getByTestId("switch-auto-map"));
    // The rail still carries its selections, so the footer still counts actions.
    expect(summary()).toMatch(/\d+ action/);
  });
});

// ─── The rail names each action the way the user named it ────────────────────
//
// USER REQUEST (2026-08-27): a list of 32 named action types. The engine thinks
// in destination/operation pairs; the rail has to say "Create recurring
// calendar rule". And every date under "Dates & Deadlines" in the table must be
// answered in the rail — including the ones deliberately left unscheduled,
// which used to be filtered out and so appeared nowhere at all.
describe("the rail speaks the action vocabulary", () => {
  afterEach(cleanup);

  it("prints the action's kind above its title", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const proposable = extraction.actionPlan.actions.filter((a: any) => a.operation !== "NO_ACTION");
    expect(proposable.length).toBeGreaterThan(0);
    const first = proposable[0];
    expect(first.kindLabel).toBeTruthy();
    expect(screen.getByTestId(`action-kind-${first.id}`).textContent).toBe(first.kindLabel);
  });

  it("lists the dates it read but deliberately did not schedule", () => {
    const extraction = buildExtraction();
    const kept = extraction.actionPlan.actions.filter(
      (a: any) => a.operation === "NO_ACTION" && a.destination === "reference" && a.payload?.date,
    );
    // The insurance fixture carries at least one informational date (an
    // effective date). If that ever stops being true this assertion is the
    // thing that says so, rather than the rail quietly going empty.
    expect(kept.length).toBeGreaterThan(0);
    renderScreen(extraction);
    const box = screen.getByTestId("review-kept-dates");
    expect(box.textContent).toMatch(/Dates kept, not scheduled/);
    for (const a of kept) expect(screen.getByTestId(`kept-date-${a.id}`)).toBeTruthy();
  });
});

// ─── No selection floor ──────────────────────────────────────────────────────
//
// USER REPORT (2026-08-27): "This message should not show up ... especially if
// you don't want to save anything to the AI extracted [data]." The middle table
// is "facts to save" and the rail is "things to do because of them"; emptying
// either one is a legitimate state, so nothing forces a selection any more.
describe("there is no selection floor", () => {
  afterEach(cleanup);

  it("the last remaining row can be skipped and reaches zero", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);
    const summary = () => screen.getByTestId("review-selected-summary").textContent || "";

    const selects = () => Array.from(
      document.querySelectorAll('select[data-testid^="review-action-"]'),
    ) as HTMLSelectElement[];

    // Skip every confirmed row, one at a time — nothing refuses the last one.
    for (let guard = 0; guard < 200; guard++) {
      const next = selects().find((s) => s.value === "confirm");
      if (!next) break;
      fireEvent.change(next, { target: { value: "skip" } });
    }
    expect(selects().some((s) => s.value === "confirm")).toBe(false);
    expect(summary()).toMatch(/0 of \d+ field/);
  });

  it("Confirm All stays enabled with zero fields while an action is selected", () => {
    const extraction = buildExtraction();
    renderScreen(extraction);

    fireEvent.click(screen.getByTestId("switch-auto-map"));
    const summary = screen.getByTestId("review-selected-summary").textContent || "";
    expect(summary).toMatch(/0 of \d+ field/);
    expect(summary).toMatch(/\d+ action/);
    expect((screen.getByTestId("btn-confirm-all") as HTMLButtonElement).disabled).toBe(false);
  });
});

// ─── The rail when the AI stage failed ───────────────────────────────────────
//
// USER REPORT (2026-08-26): "I do not see any changes, to the right make a box
// that's where all the actions go." A 63-field report whose understanding step
// degraded arrived with actionPlan and semantic both absent, so every block in
// the rail was gated off and the aside rendered as 320px of blank. The box is
// the rail's identity — it must state what it is and explain an empty list
// rather than disappear.

const degradedExtraction = () => ({
  extractionId: DOC,
  fileName: "biometric-report.pdf",
  documentType: "wellness_report",
  label: "Biometric Screening",
  extractedFields: [],
  items: [
    { id: "r1", key: "facilityPhone", label: "facility Phone", value: "(555) 019-8273",
      destination: "entity_field", destinationOptions: ["entity_field", "ignore"],
      selected: true, source: "field" },
  ],
  actionPlan: undefined,
  semantic: undefined,
  semanticDegraded: "the reasoning step returned malformed output",
  trackerEntries: [],
  calendarDates: [],
  documentName: "biometric-report.pdf",
}) as any;

describe("the actions rail is a box, always", () => {
  afterEach(cleanup);

  it("renders the box even when the document produced no actions", () => {
    renderScreen(degradedExtraction());
    const rail = screen.getByTestId("review-suggested-actions");
    expect(rail.textContent).toContain("Suggested Actions");
    expect(rail.textContent).toContain("(0)");
  });

  it("says why the list is empty instead of showing nothing", () => {
    renderScreen(degradedExtraction());
    expect(screen.getByTestId("review-actions-empty").textContent)
      .toMatch(/understanding step didn't finish/i);
  });

  it("puts the degraded notice in the rail, beside the actions it thinned out", () => {
    renderScreen(degradedExtraction());
    const notice = screen.getByTestId("review-degraded-notice");
    expect(notice.textContent).toMatch(/Understanding degraded/i);
    expect(notice.textContent).toContain("malformed output");
    // …and inside the rail, not the left-hand document panel.
    expect(screen.getByTestId("review-actions-rail").contains(notice)).toBe(true);
  });

  it("shows no confidence bar rather than a 0% one", () => {
    renderScreen(degradedExtraction());
    // The plan now always exists, so an empty understanding carries
    // confidence 0 — which must read as "no score", never as "0% confident".
    expect(screen.getByTestId("review-doc-info").textContent).not.toContain("Confidence Score");
  });

  it("a document WITH actions has no empty-state and no degraded notice", () => {
    renderScreen(buildExtraction());
    expect(screen.queryByTestId("review-actions-empty")).toBeNull();
    expect(screen.queryByTestId("review-degraded-notice")).toBeNull();
    expect(screen.getByTestId("btn-review-all-actions")).toBeTruthy();
  });
});
