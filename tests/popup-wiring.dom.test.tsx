// @vitest-environment jsdom
//
// Every popup in the app moved onto one shell (BubbleModal) in a single pass,
// which meant rewriting the JSX around actions that talk to the server: the
// Pay button, the quick-add bar, the "View all" footer, the form Save.
//
// A restructure like that can leave a control rendering perfectly and wired to
// nothing, and neither tsc nor a source-grep guard would notice. These tests
// press the controls.
//
// Scope is deliberately the WIRING, not the visuals: does the button exist,
// is it reachable, and does pressing it call the handler with the right thing.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { BubbleModal, BubbleRow } from "../client/src/components/ui/bubble-modal";
import { EmptyState } from "../client/src/components/ui/empty-state";
import { BillsDuePopup } from "../client/src/components/finance/MoneyPopups";
import { Receipt } from "lucide-react";

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
}

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stubMatchMedia();
  fetchStub = vi.fn(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const wrap = (ui: React.ReactNode) => render(<Router>{ui}</Router>);

describe("BubbleModal keeps its actions connected", () => {
  it("renders a footer link that navigates AND closes", () => {
    // The old per-file shells each had a footer <Button> with an explicit
    // onClose()+navigate(). BubbleModal replaces that with a <Link> wrapping a
    // span that closes — the count of onClick handlers in BriefingPopups went
    // down by exactly one during the migration, and this is that one.
    const onClose = vi.fn();
    wrap(
      <BubbleModal open onClose={onClose} title="Bills" icon={Receipt} accent="25 90% 58%"
        footerLabel="View all bills" footerHref="/obligations" testId="bm">
        body
      </BubbleModal>,
    );
    const footer = screen.getByTestId("bm-footer");
    expect(footer.textContent).toContain("View all bills");
    // wouter renders the Link as an anchor with the real href, so navigation
    // is the browser's job and cannot be silently dropped.
    expect(footer.closest("a")?.getAttribute("href")).toBe("/obligations");
    fireEvent.click(footer);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders an arbitrary footer (form actions) and fires it", () => {
    // The wellness quick-log and the tasks quick-add bar both live here.
    const onSave = vi.fn();
    wrap(
      <BubbleModal open onClose={() => {}} title="Log weight" icon={Receipt} accent="199 89% 60%"
        footer={<button onClick={onSave} data-testid="save">Log</button>} testId="bm2">
        body
      </BubbleModal>,
    );
    fireEvent.click(screen.getByTestId("save"));
    expect(onSave).toHaveBeenCalled();
  });

  it("fires a row's handler by click and by keyboard", () => {
    const onClick = vi.fn();
    wrap(<BubbleRow title="ChatGPT Pro" onClick={onClick} testId="row" />);
    const row = screen.getByTestId("row");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("does not fetch when opened", () => {
    // Popups are handed data the page already loaded. A popup that fetches
    // reintroduces the loading state the redesign removed.
    wrap(
      <BubbleModal open onClose={() => {}} title="Bills" icon={Receipt} accent="25 90% 58%" testId="bm3">
        body
      </BubbleModal>,
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("BillsDuePopup — a readout whose rows still go somewhere", () => {
  // 2026-11-21 (owner request): the Bills overview has no Pay button. What
  // must survive is that a row is a working control, and that the labels are
  // right.
  const bills = [
    { id: "b1", name: "Lubi", amount: 10, daysUntil: -4, dueDate: "2026-07-26", category: "subscriptions" },
    { id: "b2", name: "Progressive Auto", amount: 155, daysUntil: 0, dueDate: "2026-07-30", category: "insurance" },
    { id: "b3", name: "ChatGPT Pro", amount: 20, daysUntil: 4, dueDate: "2026-08-03", category: "subscriptions" },
    { id: "b4", name: "Old gym", amount: 30, daysUntil: -27, dueDate: "2026-07-03", category: "subscriptions" },
  ] as any;

  it("has no Pay button, and each row is a button that closes the popup to open the bill", () => {
    const onOpenChange = vi.fn();
    wrap(<BillsDuePopup open onOpenChange={onOpenChange} bills={bills} />);
    expect(screen.getByTestId("popup-bills").textContent).not.toMatch(/\bPay\b/);
    const row = screen.getByTestId("bill-row-b2");
    expect(row.tagName).toBe("BUTTON");
    fireEvent.click(row);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("labels an overdue bill as overdue, not as a negative countdown", () => {
    // Regression: a bill with a negative daysUntil and no status rendered
    // "in -27d".
    wrap(<BillsDuePopup open onOpenChange={() => {}} bills={bills} />);
    const row = screen.getByTestId("bill-row-b1");
    expect(row.textContent).toContain("4d overdue");
    expect(row.textContent).not.toContain("-4d");
    expect(screen.getByTestId("bill-row-b2").textContent).toContain("Due today");
    expect(screen.getByTestId("bill-row-b3").textContent).toContain("in 4d");
  });

  it("leaves a bill more than seven days overdue out, and says so", () => {
    wrap(<BillsDuePopup open onOpenChange={() => {}} bills={bills} />);
    expect(screen.queryByTestId("bill-row-b4")).toBeNull();
    expect(screen.getByTestId("bills-overview-older").textContent).toContain("1 unpaid bill more than 7 days overdue");
    expect(screen.getByTestId("bills-overview-older-link")).toBeTruthy();
  });
});

describe("EmptyState CTA", () => {
  it("fires the action that would fill it", () => {
    // Every first-run empty state moved to this component and kept its CTA;
    // a decorative empty state would be a dead end on an empty account.
    const onCta = vi.fn();
    wrap(<EmptyState label="Nothing on your list" ctaLabel="Create your first task" onCta={onCta} />);
    fireEvent.click(screen.getByTestId("empty-state-cta"));
    expect(onCta).toHaveBeenCalled();
  });
});
