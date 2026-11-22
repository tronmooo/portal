// OWNER REPORT (2026-11-22): the dashboard read "Spotify Premium · 115d overdue",
// "Netflix · 81d overdue" and Expenses $894, while the Finance tab — fixed the
// day before — showed the same bills as upcoming.
//
// A recurring bill's stored due date only moves when it is paid, so every
// surface that read the stored date showed a months-old occurrence. The rule
// (shared/bills-timeline): an elapsed date is assumed paid; a surface names the
// bill's NEXT date. These tests pin that rule and the three places that now
// read through it: the dashboard's upcoming bills, the month's still-to-pay
// total, and the bell.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { nextBillDate, rollBillsForward, buildBillsTimeline } from "../shared/bills-timeline";
import { sumBillsDueThroughMonth } from "../shared/obligation-windows";
import { startHarness, type Harness } from "./helpers/route-harness";

const TODAY = "2026-11-22";
const bill = (over: Record<string, unknown> = {}) => ({
  id: "b1", name: "Spotify Premium", amount: 11, frequency: "monthly",
  nextDueDate: "2026-07-30", status: "active", ...over,
});

describe("a bill's next date", () => {
  it("rolls a monthly bill last recorded in July to its next date", () => {
    expect(nextBillDate(bill(), TODAY)).toBe("2026-11-30");
  });
  it("keeps a date that is today or still ahead", () => {
    expect(nextBillDate(bill({ nextDueDate: TODAY }), TODAY)).toBe(TODAY);
    expect(nextBillDate(bill({ nextDueDate: "2026-12-02" }), TODAY)).toBe("2026-12-02");
  });
  it("follows the bill's own cadence", () => {
    expect(nextBillDate(bill({ frequency: "yearly", nextDueDate: "2025-12-15" }), TODAY)).toBe("2026-12-15");
    expect(nextBillDate(bill({ frequency: "weekly", nextDueDate: "2026-11-02" }), TODAY)).toBe("2026-11-23");
  });
  it("has nothing coming for a one-time bill whose day passed, or a series past its end", () => {
    expect(nextBillDate(bill({ frequency: "once", nextDueDate: "2026-10-01" }), TODAY)).toBeNull();
    expect(nextBillDate(bill({ recurrenceEnd: "2026-09-30" }), TODAY)).toBeNull();
    expect(nextBillDate(bill({ nextDueDate: "" }), TODAY)).toBeNull();
  });
  it("agrees with the Finance timeline's Upcoming row for the same bill", () => {
    const rows = [bill(), bill({ id: "b2", name: "Netflix", amount: 9.99, nextDueDate: "2026-09-02" })];
    const upcoming = buildBillsTimeline(rows as any, TODAY).upcoming;
    expect(upcoming.map((r) => [r.billId, r.date])).toEqual(
      [...rows].map((r) => [r.id, nextBillDate(r, TODAY)]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
  });
});

describe("rollBillsForward", () => {
  it("returns each active bill at its next date and drops the ones with nothing coming", () => {
    const rolled = rollBillsForward([
      bill(),
      bill({ id: "once", frequency: "once", nextDueDate: "2026-10-01" }),
      bill({ id: "ahead", nextDueDate: "2026-12-05" }),
    ], TODAY);
    expect(rolled.map((o) => [o.id, o.nextDueDate])).toEqual([["b1", "2026-11-30"], ["ahead", "2026-12-05"]]);
  });
  it("does not touch the stored rows, and passes paused bills through unchanged", () => {
    const stored = bill();
    const paused = bill({ id: "p", status: "paused" });
    const rolled = rollBillsForward([stored, paused], TODAY);
    expect(stored.nextDueDate).toBe("2026-07-30");
    expect(rolled.find((o) => o.id === "p")).toBe(paused);
  });
});

describe("the month's still-to-pay total", () => {
  it("counts a stale subscription once, not once per elapsed month", () => {
    // Read from the stored date, July 30 → Nov 30 is five cycles of $11.
    expect(sumBillsDueThroughMonth([bill()], "2026-11")).toBe(55);
    // Read from the next date, it is this month's one payment.
    expect(sumBillsDueThroughMonth(rollBillsForward([bill()], TODAY), "2026-11")).toBe(11);
  });
  it("the snapshot sums the rolled bills", () => {
    for (const file of ["../server/supabase-storage.ts", "../server/storage.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, file).toContain("sumBillsDueThroughMonth(rolledObligations as any[], userYearMonth)");
      expect(src, file).not.toMatch(/sumBillsDueThroughMonth\((allObligations|obligations) as any\[\]/);
      expect(src, file).toMatch(/const upcomingBills = rolledObligations/);
    }
  });
});

describe("the bell", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });

  const daysFromNow = (n: number) => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return d.toLocaleDateString("en-CA");
  };
  const billNotices = async (hh: Harness): Promise<Array<{ id: string; title: string }>> => {
    const r = await hh.api("GET", "/api/notifications");
    expect(r.status).toBe(200);
    if (!Array.isArray(r.data)) throw new Error("notifications is not a list");
    return r.data.filter((n: any) => n.type === "bill_due");
  };

  it("does not call a subscription overdue for a date months back", async () => {
    h = await startHarness({ obligations: [bill({ nextDueDate: daysFromNow(-115) })] });
    const notices = await billNotices(h);
    expect(notices.filter((n) => /overdue/i.test(n.title))).toEqual([]);
  });

  it("still says a bill is due soon, at its next date", async () => {
    // Stored one cycle back from a date two days out: the next date is in 2 days.
    const soon = daysFromNow(2);
    const prev = new Date(`${soon}T12:00:00`); prev.setDate(prev.getDate() - 7);
    h = await startHarness({ obligations: [bill({ frequency: "weekly", nextDueDate: prev.toLocaleDateString("en-CA") })] });
    const notices = await billNotices(h);
    expect(notices.map((n) => n.title)).toEqual(["Bill due soon: Spotify Premium"]);
    expect(notices[0].id).toBe(`bill-soon-b1-${soon}`);
  });
});
