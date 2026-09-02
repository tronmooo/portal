// Regression coverage for the 2026-09 audit fixes:
//   - date-only due dates compared as calendar days (a bill due TODAY is not overdue)
//   - one upcoming-bill predicate for the KPI tile and the popup (status rule included)
//   - CSRF exemptions match the mount-stripped path Express actually hands the middleware
import { describe, it, expect, vi } from "vitest";
import { localDayOf, getUserToday, addDays } from "../shared/timezone";
import { isUpcomingBill, toMonthlyAmount, UPCOMING_BILL_WINDOW_DAYS } from "../shared/obligation-windows";
import { csrfOriginCheck } from "../server/security-headers";
import { generateSmartInsights } from "../server/insights-engine";

const TZ = "America/Los_Angeles";

describe("localDayOf", () => {
  it("returns a bare YYYY-MM-DD unchanged", () => {
    expect(localDayOf("2026-09-02", TZ)).toBe("2026-09-02");
  });
  it("maps an instant to the calendar day in the given zone", () => {
    // 03:00 UTC on Sep 3 is still Sep 2 in Los Angeles.
    expect(localDayOf("2026-09-03T03:00:00Z", TZ)).toBe("2026-09-02");
    expect(localDayOf(new Date("2026-09-03T03:00:00Z"), "UTC")).toBe("2026-09-03");
  });
  it("returns null for empty or invalid input", () => {
    expect(localDayOf(null, TZ)).toBeNull();
    expect(localDayOf("not a date", TZ)).toBeNull();
  });
});

describe("isUpcomingBill", () => {
  const now = new Date("2026-09-02T18:00:00Z");
  const due = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  it("includes bills due today, overdue bills, and bills inside the window", () => {
    expect(isUpcomingBill({ nextDueDate: due(0) }, now)).toBe(true);
    expect(isUpcomingBill({ nextDueDate: due(-5) }, now)).toBe(true);
    expect(isUpcomingBill({ nextDueDate: due(UPCOMING_BILL_WINDOW_DAYS - 1) }, now)).toBe(true);
  });
  it("excludes bills beyond the window", () => {
    expect(isUpcomingBill({ nextDueDate: due(UPCOMING_BILL_WINDOW_DAYS + 2) }, now)).toBe(false);
  });
  it("excludes paused and cancelled bills — the popup never listed them, the tile counted them", () => {
    expect(isUpcomingBill({ nextDueDate: due(3), status: "paused" }, now)).toBe(false);
    expect(isUpcomingBill({ nextDueDate: due(3), status: "cancelled" }, now)).toBe(false);
    expect(isUpcomingBill({ nextDueDate: due(3), status: "active" }, now)).toBe(true);
  });
  it("uses exact monthly multipliers, including biweekly", () => {
    expect(toMonthlyAmount(100, "biweekly")).toBeCloseTo(100 * 26 / 12, 6);
    expect(toMonthlyAmount(100, "weekly")).toBeCloseTo(100 * 52 / 12, 6);
  });
});

describe("csrfOriginCheck (mounted under /api, so req.path has no /api prefix)", () => {
  function run(path: string, headers: Record<string, string>) {
    const req: any = { method: "POST", path, headers };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res: any = { status, json };
    const next = vi.fn();
    csrfOriginCheck(req, res, next);
    return { next, status };
  }
  it("exempts auth routes even when reached from a foreign referer (webmail reset link)", () => {
    const { next, status } = run("/auth/reset-password", { referer: "https://mail.google.com/mail/u/0/" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
  it("still exempts the unstripped form", () => {
    const { next } = run("/api/auth/reset-password", { origin: "https://evil.example" });
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("blocks a cross-origin mutation on a data route", () => {
    const { next, status } = run("/expenses", { origin: "https://evil.example" });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
  it("allows same-origin mutations", () => {
    const { next } = run("/expenses", { origin: "https://portol.me" });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("insights: due today is not overdue", () => {
  const empty = { profiles: [], trackers: [], expenses: [], habits: [], journal: [], documents: [], goals: [], events: [] };
  const today = getUserToday(TZ);
  it("reports a bill due today as due this week, never as overdue", () => {
    const obligations: any[] = [
      { id: "ob-today", name: "Rent", amount: 100, frequency: "monthly", status: "active", nextDueDate: today },
      { id: "ob-late", name: "Water", amount: 50, frequency: "monthly", status: "active", nextDueDate: addDays(today, -3) },
    ];
    const insights = generateSmartInsights({ ...empty, tasks: [], obligations } as any, TZ);
    const dueThisWeek = insights.find(i => i.type === "obligation_due");
    expect(dueThisWeek?.data?.obligations).toContain("ob-today");
    const overdue = insights.find(i => /overdue/i.test(i.title) && Array.isArray(i.data?.obligations));
    expect(overdue?.data?.obligations).toEqual(["ob-late"]);
  });
  it("does not list a task due today as overdue", () => {
    const tasks: any[] = [
      { id: "t-today", title: "Call the bank", status: "todo", dueDate: today },
      { id: "t-late", title: "File taxes", status: "todo", dueDate: addDays(today, -1) },
    ];
    const insights = generateSmartInsights({ ...empty, tasks, obligations: [] } as any, TZ);
    const overdue = insights.find(i => i.type === "reminder" && /overdue/i.test(i.title));
    expect(overdue?.data?.taskIds).toEqual(["t-late"]);
  });
});
