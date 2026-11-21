// @vitest-environment jsdom
//
// Owner request 2026-11-21: the Finance tab's Bills card and Bills popup read
// "OVERDUE · Spotify · 235d overdue" with a red Pay button for every
// subscription whose stored due date never moved. The owner's rule: a
// recurring bill's elapsed due dates are ASSUMED PAID — the view shows the
// next date under "Upcoming", the elapsed ones under "Past", and has no Pay
// button. shared/bills-timeline is the rule; BillsTimelineView renders it in
// both places.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { Router } from "wouter";
import { buildBillsTimeline } from "../shared/bills-timeline";
import { BillsDuePopup } from "../client/src/components/finance/MoneyPopups";
import { MoneyOverview } from "../client/src/components/finance/MoneyOverview";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;
vi.stubGlobal("matchMedia", (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
}));
afterEach(cleanup);

const TODAY = "2026-11-21";
// The owner's six bills as the screenshot showed them.
const OBLIGATIONS = [
  { id: "spotify", name: "Spotify", amount: 11, frequency: "monthly", category: "general", nextDueDate: "2026-03-31", status: "active", linkedLiabilityId: "spotify", payments: [] },
  { id: "spotify-premium", name: "Spotify Premium", amount: 11, frequency: "monthly", kind: "subscription", nextDueDate: "2026-07-30", status: "active", linkedLiabilityId: "spotify-premium", payments: [] },
  { id: "progressive", name: "Progressive Auto Insurance", amount: 155, frequency: "monthly", category: "insurance", nextDueDate: "2026-08-30", status: "active", linkedLiabilityId: "progressive", payments: [] },
  { id: "netflix", name: "Netflix", amount: 10, frequency: "monthly", kind: "subscription", nextDueDate: "2026-09-02", status: "active", linkedLiabilityId: "netflix", payments: [] },
  { id: "lubi", name: "Lubi", amount: 10, frequency: "monthly", kind: "subscription", nextDueDate: "2026-09-03", status: "active", linkedLiabilityId: "lubi", payments: [] },
  { id: "chatgpt", name: "ChatGPT Pro", amount: 20, frequency: "monthly", kind: "subscription", nextDueDate: "2026-09-30", status: "active", linkedLiabilityId: "chatgpt", payments: [] },
];

describe("buildBillsTimeline — elapsed due dates are assumed paid", () => {
  it("rolls each stale monthly bill forward: nothing is overdue, each has its next date", () => {
    const t = buildBillsTimeline(OBLIGATIONS, TODAY);
    expect(t.upcoming.every((r) => r.daysUntil >= 0)).toBe(true);
    expect(t.upcoming.every((r) => r.state === "upcoming")).toBe(true);
    const next = Object.fromEntries(t.upcoming.map((r) => [r.billId, r.date]));
    expect(next).toEqual({
      spotify: "2026-11-30", // Mar 31 anchor: Nov has 30 days
      "spotify-premium": "2026-11-30",
      progressive: "2026-11-30",
      netflix: "2026-12-02",
      lubi: "2026-12-03",
      chatgpt: "2026-11-30",
    });
    // Soonest first.
    expect(t.upcoming.map((r) => r.date)).toEqual([...t.upcoming.map((r) => r.date)].sort());
  });

  it("lists the elapsed dates of the last 90 days under Past, newest first, as assumed", () => {
    const t = buildBillsTimeline(OBLIGATIONS, TODAY);
    const lubi = t.past.filter((r) => r.billId === "lubi").map((r) => r.date);
    expect(lubi).toEqual(["2026-11-03", "2026-10-03", "2026-09-03"]);
    // Aug 23 is 90 days back: Spotify's Jul 31 cycle is out, Aug 31 is in.
    const spotify = t.past.filter((r) => r.billId === "spotify").map((r) => r.date);
    expect(spotify).toEqual(["2026-10-31", "2026-09-30", "2026-08-31"]);
    expect(t.past.length).toBeGreaterThan(0);
    expect(t.past.every((r) => r.state === "assumed" && r.daysUntil < 0)).toBe(true);
    expect(t.past.map((r) => r.date)).toEqual([...t.past.map((r) => r.date)].sort().reverse());
  });

  it("a recorded payment is a paid Past row; a bill not yet due stays Upcoming with no invented history", () => {
    const t = buildBillsTimeline([
      { id: "rent", name: "Rent", amount: 2000, frequency: "monthly", nextDueDate: "2026-12-01", status: "active", payments: [{ id: "p1", amount: 2000, date: "2026-11-01" }] },
    ], TODAY);
    expect(t.upcoming.map((r) => [r.billId, r.date])).toEqual([["rent", "2026-12-01"]]);
    expect(t.past.map((r) => [r.date, r.state, r.amount])).toEqual([["2026-11-01", "paid", 2000]]);
  });

  it("a paused bill has nothing upcoming and nothing assumed; a one-time bill is assumed paid once", () => {
    const t = buildBillsTimeline([
      { id: "gym", name: "Gym", amount: 40, frequency: "monthly", nextDueDate: "2026-10-01", status: "paused" },
      { id: "fee", name: "DMV fee", amount: 60, frequency: "once", nextDueDate: "2026-11-10", status: "active" },
    ], TODAY);
    expect(t.upcoming).toHaveLength(0);
    expect(t.past.map((r) => [r.billId, r.date, r.state])).toEqual([["fee", "2026-11-10", "assumed"]]);
  });

  it("a bill whose next date is past the 30-day window is not Upcoming", () => {
    const t = buildBillsTimeline([
      { id: "car-reg", name: "Car registration", amount: 120, frequency: "yearly", nextDueDate: "2027-03-01", status: "active" },
    ], TODAY);
    expect(t.upcoming).toHaveLength(0);
    expect(t.past).toHaveLength(0);
  });
});

describe("Finance Bills card and popup — Upcoming / Past, no Pay button", () => {
  const timeline = buildBillsTimeline(OBLIGATIONS, TODAY);

  it("the popup shows both sections, no overdue wording and no Pay button", () => {
    render(<Router><BillsDuePopup open onOpenChange={() => {}} timeline={timeline} /></Router>);
    const el = screen.getByTestId("popup-bills");
    expect(el.textContent).toContain("Bills & Payments");
    expect(el.textContent).toContain("Upcoming Payments");
    expect(el.textContent).toContain("Past Payments");
    expect(el.textContent).not.toMatch(/overdue/i);
    expect(within(el).queryAllByRole("button", { name: /^pay$/i })).toHaveLength(0);
    expect(within(el).getAllByTestId(/^bill-timeline-upcoming-/)).toHaveLength(6);
    expect(within(el).getAllByTestId(/^bill-timeline-past-/)).toHaveLength(timeline.past.length);
    expect(screen.getByTestId("bills-summary-upcoming").textContent).toContain("6");
    const lubi = screen.getByTestId("bill-timeline-upcoming-lubi");
    expect(lubi.textContent).toContain("DEC");
    expect(lubi.textContent).toContain("3");
    expect(lubi.textContent).toContain("in 12 days");
    expect(lubi.textContent).toContain("Subscription • Monthly");
  });

  it("the Finance card renders the same view, its KPI counts the Upcoming rows, and there is no Pay button", () => {
    render(<Router><MoneyOverview
      netWorth={1} assets={1} liabilities={0} momPct={null} nwSeries={[]} cashIn={0} cashOut={0} spendMtd={0}
      budgets={[]} billsTimeline={timeline} assetBreakdown={[]} liabilityBreakdown={[]} monthLabel="NOV" /></Router>);
    const card = screen.getByTestId("money-bills");
    expect(card.textContent).toContain("Upcoming Payments");
    expect(card.textContent).toContain("Past Payments");
    expect(card.textContent).not.toMatch(/overdue/i);
    expect(within(card).queryAllByRole("button", { name: /^pay$/i })).toHaveLength(0);
    expect(card.querySelectorAll("[data-testid^='money-pay-']")).toHaveLength(0);
    expect(screen.getByTestId("money-bills-kpi").textContent).toContain("6");
  });
});
