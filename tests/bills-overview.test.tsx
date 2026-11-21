// @vitest-environment jsdom
// Bills overview (owner request 2026-11-21): due today, the next 30 days, and
// overdue within the last seven days — one split, drawn by one component, with
// no Pay button. Older overdue bills leave the overview but are counted and
// linked (Rule 4), and nothing here writes.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import fs from "fs";
import path from "path";
import {
  billsOverview, selectUpcomingBills, OVERDUE_BILL_VISIBLE_DAYS, UPCOMING_BILL_WINDOW_DAYS,
} from "../shared/obligation-windows";
import { BillsOverviewList } from "../client/src/components/finance/BillsOverviewList";

afterEach(cleanup);
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const bill = (id: string, daysUntil: number, extra: Record<string, any> = {}) =>
  ({ id, name: `Bill ${id}`, amount: 10, daysUntil, ...extra });

describe("billsOverview — the one split", () => {
  const rows = [
    bill("late30", -30), bill("late8", -8), bill("late7", -7), bill("late1", -1),
    bill("today", 0), bill("in1", 1), bill("in30", 30), bill("in31", 31),
  ];
  const o = billsOverview(rows);

  it("the windows are seven days back and thirty days ahead", () => {
    expect(OVERDUE_BILL_VISIBLE_DAYS).toBe(7);
    expect(UPCOMING_BILL_WINDOW_DAYS).toBe(30);
  });

  it("due today is its own group", () => {
    expect(o.dueToday.map((b) => b.id)).toEqual(["today"]);
  });

  it("the next 30 days are soonest first, and day 31 is not in yet", () => {
    expect(o.upcoming.map((b) => b.id)).toEqual(["in1", "in30"]);
  });

  it("recently overdue is 1–7 days late, most recent first; day 8 is out", () => {
    expect(o.recentlyOverdue.map((b) => b.id)).toEqual(["late1", "late7"]);
    expect(o.olderOverdue.map((b) => b.id)).toEqual(["late30", "late8"]);
  });

  it("visible is everything shown, by due date — and is what selectUpcomingBills returns", () => {
    expect(o.visible.map((b) => b.id)).toEqual(["late7", "late1", "today", "in1", "in30"]);
    expect(selectUpcomingBills(rows).map((b) => b.id)).toEqual(o.visible.map((b) => b.id));
  });

  it("a row without a numeric daysUntil is in no group (it cannot be placed)", () => {
    const odd = billsOverview([{ id: "x" } as any, { id: "y", daysUntil: null } as any, { id: "z", daysUntil: NaN } as any]);
    expect(odd.visible).toEqual([]);
    expect(odd.olderOverdue).toEqual([]);
  });

  it("a recurring bill is placed by its NEXT due date alone", () => {
    // Paying an occurrence moves the bill to its next due date; the overview
    // only ever sees that date.
    const paidAndMovedOn = billsOverview([bill("rent", 22, { frequency: "monthly" })]);
    expect(paidAndMovedOn.upcoming.map((b) => b.id)).toEqual(["rent"]);
  });
});

describe("BillsOverviewList — the readout", () => {
  const bills = [
    bill("old", -12, { name: "Storage" }),
    bill("late", -3, { name: "Gym", dueDate: "2026-11-18", amount: 42 }),
    bill("now", 0, { name: "Electric", dueDate: "2026-11-21", amount: 120.5 }),
    bill("soon", 10, { name: "Internet", dueDate: "2026-12-01", amount: 60, autopay: true }),
    bill("far", 45, { name: "Insurance" }),
  ];

  it("draws three labelled groups with name, amount, due date and status on each row", () => {
    render(<BillsOverviewList bills={bills} />);
    expect(screen.getByTestId("bills-group-today").textContent).toContain("Due today");
    expect(screen.getByTestId("bills-group-overdue").textContent).toContain("Recently overdue");
    expect(screen.getByTestId("bills-group-next").textContent).toContain("Next 30 days");
    const now = screen.getByTestId("bill-row-now").textContent || "";
    expect(now).toContain("Electric");
    expect(now).toContain("$120.50");
    expect(now).toContain("Due today");
    const late = screen.getByTestId("bill-row-late").textContent || "";
    expect(late).toContain("Was due Nov 18");
    expect(late).toContain("3d overdue");
    expect(screen.getByTestId("bill-status-late").textContent).toBe("Unpaid");
    const soon = screen.getByTestId("bill-row-soon").textContent || "";
    expect(soon).toContain("Dec 1");
    expect(soon).toContain("in 10d");
    expect(screen.getByTestId("bill-status-soon").textContent).toContain("Auto Pay");
  });

  it("due today comes first on the page", () => {
    render(<BillsOverviewList bills={bills} />);
    const order = Array.from(document.querySelectorAll("[data-testid^='bills-group-']")).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["bills-group-today", "bills-group-overdue", "bills-group-next"]);
  });

  it("leaves out what is more than seven days overdue or more than 30 days away", () => {
    render(<BillsOverviewList bills={bills} />);
    expect(screen.queryByTestId("bill-row-old")).toBeNull();
    expect(screen.queryByTestId("bill-row-far")).toBeNull();
  });

  it("says how many older overdue bills are not listed, and links to all bills", () => {
    const onViewAll = vi.fn();
    render(<BillsOverviewList bills={bills} onViewAll={onViewAll} />);
    expect(screen.getByTestId("bills-overview-older").textContent).toContain("1 unpaid bill more than 7 days overdue isn't listed here");
    fireEvent.click(screen.getByTestId("bills-overview-older-link"));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("has no older-bills line when there are none", () => {
    render(<BillsOverviewList bills={bills.filter((b) => b.id !== "old")} />);
    expect(screen.queryByTestId("bills-overview-older")).toBeNull();
  });

  it("has no Pay button; a row is at most a link to the bill", () => {
    const onOpenBill = vi.fn();
    render(<BillsOverviewList bills={bills} onOpenBill={onOpenBill} />);
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(buttons.some((b) => /\bPay\b/.test(b.textContent || "") && !/Auto Pay/.test(b.textContent || ""))).toBe(false);
    fireEvent.click(screen.getByTestId("bill-row-now"));
    expect(onOpenBill).toHaveBeenCalledWith(expect.objectContaining({ id: "now" }));
  });

  it("an empty overview says so plainly", () => {
    render(<BillsOverviewList bills={[bill("far", 60)]} />);
    expect(screen.getByTestId("bills-overview-empty").textContent).toContain("Nothing due today or in the next 30 days");
  });

  it("a card limit folds the rest into a count, never dropping them silently", () => {
    const many = [bill("a", 1), bill("b", 2), bill("c", 3), bill("d", 4), bill("e", 5)];
    render(<BillsOverviewList bills={many} limit={3} onViewAll={() => {}} />);
    expect(screen.getAllByTestId(/^bill-row-/)).toHaveLength(3);
    expect(screen.getByTestId("bills-overview-more").textContent).toContain("2 more");
  });
});

describe("the overview surfaces carry no payment code", () => {
  // Removing Pay must not be a hidden button: the three overview surfaces do
  // not call the pay endpoint at all. Recording a payment stays where it was —
  // payBillOccurrence behind the Bills panel, the bill's page, chat, Auto Pay.
  const SURFACES = [
    "client/src/components/finance/BillsOverviewList.tsx",
    "client/src/components/finance/MoneyOverview.tsx",
    "client/src/components/finance/MoneyPopups.tsx",
  ];
  it.each(SURFACES)("%s neither pays nor writes", (f) => {
    const src = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join("\n");
    expect(src).not.toMatch(/\/pay\b/);
    expect(src).not.toMatch(/onPayBill|payingId/);
  });

  it("every overview surface reads the one split", () => {
    expect(read("client/src/components/finance/MoneyOverview.tsx")).toContain("billsOverview(props.bills)");
    expect(read("client/src/components/finance/MoneyPopups.tsx")).toContain("billsOverview(bills)");
    expect(read("client/src/components/dashboard/ExecutiveBriefing.tsx")).toContain("<BillsOverviewList bills={allBills as any[]}");
  });

  it("the server's bill list, cron and pay pipeline are untouched by the window", () => {
    // The seven-day rule is a display rule. If it ever leaks into the server's
    // upcoming-bill check, Auto Pay and the monthly totals would lose bills.
    const shared = read("shared/obligation-windows.ts");
    const isUpcoming = shared.slice(shared.indexOf("export function isUpcomingBill"), shared.indexOf("export function toMonthlyAmount"));
    expect(isUpcoming).not.toContain("OVERDUE_BILL_VISIBLE_DAYS");
    expect(read("server/autopay.ts")).not.toContain("OVERDUE_BILL_VISIBLE_DAYS");
    expect(read("shared/autopay.ts")).not.toContain("OVERDUE_BILL_VISIBLE_DAYS");
  });
});
