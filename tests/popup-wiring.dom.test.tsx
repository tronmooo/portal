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

const tlRow = (id: string, name: string, amount: number, date: string, daysUntil: number, state: string) =>
  ({ key: `${id}:${date}`, billId: id, name, amount, date, daysUntil, frequency: "monthly", category: "general", kind: "bill", autopay: false, linkedLiabilityId: id, state });
describe("BillsDuePopup — Upcoming / Past, no Pay (owner 2026-11-21)", () => {
  const timeline = {
    upcoming: [tlRow("b2", "Progressive Auto", 155, "2026-07-30", 0, "upcoming"), tlRow("b3", "ChatGPT Pro", 20, "2026-08-03", 4, "upcoming")],
    past: [tlRow("b1", "Lubi", 10, "2026-07-03", -27, "assumed")],
  } as any;

  it("has no Pay button: an elapsed due date is assumed paid", () => {
    wrap(<BillsDuePopup open onOpenChange={() => {}} timeline={timeline} />);
    expect(screen.queryAllByRole("button", { name: /^pay$/i })).toHaveLength(0);
  });

  it("labels an elapsed bill Past, not as overdue or a negative countdown", () => {
    wrap(<BillsDuePopup open onOpenChange={() => {}} timeline={timeline} />);
    const row = screen.getByTestId("bill-timeline-past-b1");
    expect(row.textContent).toContain("Past");
    expect(row.textContent).not.toMatch(/overdue|-27/);
    expect(screen.getByTestId("bill-timeline-upcoming-b2").textContent).toContain("today");
    expect(screen.getByTestId("bill-timeline-upcoming-b3").textContent).toContain("in 4 days");
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
