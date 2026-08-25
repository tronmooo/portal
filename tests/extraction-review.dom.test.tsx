// @vitest-environment jsdom
//
// The review pane, as a person actually meets it.
//
// The screen this replaces opened on "REVIEW EXTRACTED DATA · 75" and left the
// reader to work out from seventy-five key/value rows what the document even
// was, let alone what the app was about to do with it. These tests assert the
// three levels that replaced it — what it means, what will happen, what was
// found — and, more importantly, that the user's routing decisions actually
// reach the confirm payload. Automatic intelligence that cannot be corrected is
// worse than none.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async () => ({ json: async () => [] })),
  BROWSER_TIMEZONE: "America/Los_Angeles",
}));

import { ExtractionConfirmation } from "../client/src/components/chat/ExtractionReview";
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
    trackerEntries: [],
    calendarDates: [],
    documentName: "Declarations Page",
  } as any;
}

function renderPane(extraction: any, onConfirm = vi.fn(async () => true)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ExtractionConfirmation extraction={extraction} onConfirm={onConfirm} onSkip={() => {}} />
    </QueryClientProvider>,
  );
  return { ...utils, onConfirm };
}

const confirmPayload = (onConfirm: any) => onConfirm.mock.calls.at(-1)?.[0];

describe("the review pane leads with meaning, not with 75 rows", () => {
  afterEach(cleanup);

  it("says what the document is before it says what it found", () => {
    renderPane(buildExtraction());
    const understanding = screen.getByTestId("document-understanding");
    expect(within(understanding).getByTestId("understanding-type").textContent)
      .toBe("Homeowners Insurance Policy");
    expect(within(understanding).getByTestId("understanding-subject").textContent)
      .toMatch(/123 Evergreen Ln/);
    expect(screen.getByTestId("understanding-confidence").textContent).toBe("Confident");
  });

  it("summarises what will happen, in counts", () => {
    renderPane(buildExtraction());
    const summary = screen.getByTestId("proposed-actions-summary").textContent || "";
    expect(summary).toMatch(/Recurring obligation/);
    expect(summary).toMatch(/kept as reference only/);
  });

  it("groups the actions by where they go", () => {
    renderPane(buildExtraction());
    expect(screen.getByTestId("action-group-obligation")).toBeTruthy();
    expect(screen.getByTestId("action-group-entity_field")).toBeTruthy();
    expect(screen.getByTestId("action-group-reference")).toBeTruthy();
  });

  it("keeps every extracted row reachable rather than discarding it", () => {
    renderPane(buildExtraction());
    const section = screen.getByTestId("extracted-data-section");
    expect(section.textContent).toMatch(/Extracted data · 17/);
    // All seventeen rows are there — collapsed, not dropped.
    for (const item of insuranceDeclarations.items) {
      expect(screen.getByTestId(`extracted-row-${item.id}`)).toBeTruthy();
    }
  });

  it("shows the evidence behind a claim, so 'these five fields are one bill' is checkable", () => {
    renderPane(buildExtraction());
    const obligation = screen.getByTestId("action-group-obligation");
    const toggle = within(obligation).getByTestId(/action-evidence-toggle-/);
    expect(toggle.textContent).toMatch(/3 fields this came from/);
    fireEvent.click(toggle);
    const evidence = within(obligation).getByTestId(/^action-evidence-act-/);
    expect(evidence.textContent).toMatch(/Annual Premium/);
    expect(evidence.textContent).toMatch(/Payment Plan/);
  });
});

describe("the user's routing always wins", () => {
  afterEach(cleanup);

  it("sends the plan when confirmed", async () => {
    const { onConfirm } = renderPane(buildExtraction());
    fireEvent.click(screen.getByText("Confirm"));
    const payload = confirmPayload(onConfirm);
    expect(payload.actions.length).toBeGreaterThan(0);
    expect(payload.actions.some((a: any) => a.destination === "obligation")).toBe(true);
  });

  it("Don't save takes the action out of what gets written", async () => {
    const { onConfirm } = renderPane(buildExtraction());
    const obligation = screen.getByTestId("action-group-obligation");
    const toggle = within(obligation).getByTestId(/action-toggle-/);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByText("Confirm"));
    const written = confirmPayload(onConfirm).actions.filter(
      (a: any) => a.selected && a.operation !== "NO_ACTION",
    );
    expect(written.some((a: any) => a.destination === "obligation")).toBe(false);
  });

  it("changing a destination re-routes the write AND turns it on", async () => {
    const { onConfirm } = renderPane(buildExtraction());
    const obligation = screen.getByTestId("action-group-obligation");
    const select = within(obligation).getByTestId(/action-destination-/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "expense" } });

    fireEvent.click(screen.getByText("Confirm"));
    const actions = confirmPayload(onConfirm).actions;
    expect(actions.some((a: any) => a.destination === "obligation")).toBe(false);
    const moved = actions.find((a: any) => a.destination === "expense");
    expect(moved).toBeTruthy();
    // Re-routing something is an act of wanting it saved.
    expect(moved.selected).toBe(true);
  });

  it("a corrected number is the number that gets written", async () => {
    // The rows under an action are its evidence, and editing one is how a
    // misread figure is fixed before confirming. Showing 1,500 and saving
    // 1,428 would be the worst of both — a correction the user believes they
    // made.
    const { onConfirm } = renderPane(buildExtraction());
    const obligation = screen.getByTestId("action-group-obligation");
    fireEvent.click(within(obligation).getByTestId(/action-evidence-toggle-/));
    fireEvent.change(screen.getByTestId("action-evidence-value-field-annualpremium"), {
      target: { value: "1500.00" },
    });

    fireEvent.click(screen.getByText("Confirm"));
    const written = confirmPayload(onConfirm).actions.find((a: any) => a.destination === "obligation");
    expect(written.payload.amount).toBe(1500);
    expect((screen.getByTestId("extracted-value-field-annualpremium") as HTMLInputElement).value)
      .toBe("1500.00");
  });

  it("editing one row of a multi-row action leaves the rest alone", async () => {
    const { onConfirm } = renderPane(buildExtraction());
    const fieldsGroup = screen.getByTestId("action-group-entity_field");
    fireEvent.click(within(fieldsGroup).getByTestId(/action-evidence-toggle-/));
    fireEvent.change(screen.getByTestId("action-evidence-value-field-squarefeet"), {
      target: { value: "2680" },
    });

    fireEvent.click(screen.getByText("Confirm"));
    const written = confirmPayload(onConfirm).actions.find((a: any) => a.destination === "entity_field");
    expect(written.payload.fields.squareFeet).toBe("2680");
    expect(written.payload.fields.yearBuilt).toBe("2018");
  });
});

describe("+ Add action — routing the engine did not propose", () => {
  afterEach(cleanup);

  it("adds a second destination for a fact that already has one", async () => {
    const { onConfirm } = renderPane(buildExtraction());
    fireEvent.click(screen.getByTestId("add-action-open"));

    fireEvent.click(screen.getByTestId("add-action-row-field-annualpremium"));
    fireEvent.change(screen.getByTestId("add-action-destination"), { target: { value: "expense" } });
    fireEvent.change(screen.getByTestId("add-action-amount"), { target: { value: "1428" } });
    fireEvent.click(screen.getByTestId("add-action-submit"));

    fireEvent.click(screen.getByText("Confirm"));
    const actions = confirmPayload(onConfirm).actions;
    const manual = actions.find((a: any) => a.origin === "manual");
    expect(manual).toBeTruthy();
    expect(manual.destination).toBe("expense");
    expect(manual.itemIds).toEqual(["field-annualpremium"]);
    // The original obligation is untouched — this is an ADDITIONAL destination,
    // not a replacement.
    expect(actions.some((a: any) => a.destination === "obligation" && a.selected)).toBe(true);
  });

  it("will not add an action with nowhere to put it", async () => {
    renderPane(buildExtraction());
    fireEvent.click(screen.getByTestId("add-action-open"));
    // Nothing picked, no target — the button stays disabled rather than
    // producing a write aimed at nothing.
    expect((screen.getByTestId("add-action-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a document the engine could not interpret", () => {
  afterEach(cleanup);

  it("says so plainly and still shows everything it found", () => {
    renderPane({
      ...buildExtraction(),
      actionPlan: undefined,
      semantic: undefined,
      semanticDegraded: "the reasoning step did not complete",
      extractedFields: [],
    });
    const banner = screen.getByTestId("understanding-degraded");
    expect(banner.textContent).toMatch(/Couldn't work out what this document means/);
    expect(banner.textContent).toMatch(/route each row yourself/);
    // The per-field pane is what renders — nothing is lost to the failure.
    expect(screen.getByTestId("extraction-items")).toBeTruthy();
    expect(screen.queryByTestId("proposed-actions")).toBeNull();
  });
});

describe("blocking warnings hold the write open", () => {
  afterEach(cleanup);

  it("an action that needs a decision starts off and says why", () => {
    // An escrow-bundled premium: adding it again would count one real
    // commitment twice.
    const escrowed = {
      ...insuranceDeclarations,
      index: {
        ...insuranceDeclarations.index,
        profiles: insuranceDeclarations.index.profiles.map((p) =>
          p.id === "liab-1" ? { ...p, fields: { ...p.fields, escrowMonthly: 340 } } : p),
      },
    };
    const plan = planExtractionActions({
      semantic: escrowed.semantic,
      items: escrowed.items,
      index: escrowed.index,
      primaryProfileId: escrowed.primaryProfileId,
      documentId: DOC,
      today: "2026-08-25",
    });
    renderPane({ ...buildExtraction(), actionPlan: plan, items: plan.items });

    const obligation = screen.getByTestId("action-group-obligation");
    expect(within(obligation).getByTestId(/action-toggle-/).getAttribute("aria-checked")).toBe("false");
    expect(within(obligation).getByTestId(/action-warning-/).textContent)
      .toMatch(/already includes this cost/);
    expect(screen.getByTestId("proposed-actions-flagged").textContent)
      .toMatch(/needs a decision/);
  });
});
