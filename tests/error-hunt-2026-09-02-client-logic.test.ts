// Regression coverage for the 2026-09-02 error-hunting round — CLIENT half
// (pure logic; the component mounts live in error-hunt-2026-09-02-client.test.tsx).
// Item numbers match the audit list.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { QueryClient } from "@tanstack/react-query";

// The cache bus talks to the app-wide queryClient singleton; give it a real,
// empty QueryClient so the helpers under test patch a cache we can inspect.
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest: vi.fn(), BROWSER_TIMEZONE: "America/Los_Angeles" };
});

import { queryClient } from "@/lib/queryClient";
import {
  invalidateDomains, patchQueries, patchProfileDetailList, dropUpcomingBillFromDashboard, composeRestores,
} from "../client/src/lib/cache-bus";
import { formatLocalDate, daysFromToday, isPast, localTodayISO } from "../client/src/lib/dates";
import { FULL_LIST_LIMIT, withFullLimit } from "../client/src/lib/list-limit";
import { formatMoneyRound } from "../client/src/lib/format";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const qc = queryClient as QueryClient;

// A US zone: every bare "YYYY-MM-DD" parsed by `new Date()` lands on the
// evening of the PREVIOUS local day here. Vitest runs with TZ unset (UTC),
// where the bug is invisible.
beforeAll(() => { process.env.TZ = "America/Los_Angeles"; });

// ── Item 2: bare YYYY-MM-DD values render / compare as LOCAL days ──────────
describe("item 2: date-only strings are local calendar days, not UTC midnight", () => {
  it("formatLocalDate renders the day the row carries (new Date() would show the day before)", () => {
    expect(formatLocalDate("2026-09-02", { month: "short", day: "numeric" })).toBe("Sep 2");
    // The exact defect: the engine's UTC parse of the same string is Sep 1 in LA.
    expect(new Date("2026-09-02").toLocaleDateString("en-US", { month: "short", day: "numeric" })).toBe("Sep 1");
    // Timestamps still parse as instants; junk renders as "".
    expect(formatLocalDate("2026-09-02T20:00:00Z", { month: "short", day: "numeric" })).toBe("Sep 2");
    expect(formatLocalDate("nope")).toBe("");
    expect(formatLocalDate(undefined)).toBe("");
  });

  it("a due date of TODAY is neither overdue nor 'yesterday'", () => {
    const today = localTodayISO();
    expect(daysFromToday(today)).toBe(0);
    expect(isPast(today)).toBe(false);
    // ...while the raw UTC parse already sits in the past for a US user.
    expect(new Date(today).getTime() < Date.now()).toBe(true);
  });
});

// ── Items 1 / 4 / 5 / 8: prefix-patch helpers with rollback ─────────────────
describe("patchQueries: prefix-matched optimistic patch with a restore", () => {
  it("reaches every scoped variant of a key and restores exactly those (items 4, 8)", () => {
    qc.clear();
    qc.setQueryData(["/api/budgets", "2026-09", "everyone"], { month: "2026-09", budgets: [{ id: "b1" }, { id: "b2" }] });
    qc.setQueryData(["/api/budgets", "2026-09", "selected", "p1"], { month: "2026-09", budgets: [{ id: "b1" }] });
    qc.setQueryData(["/api/budgets", "2026-08", "everyone"], { month: "2026-08", budgets: [{ id: "b1" }] });

    const restore = patchQueries(["/api/budgets", "2026-09"], (old: any) =>
      old?.budgets ? { ...old, budgets: old.budgets.filter((b: any) => b.id !== "b1") } : undefined);

    expect((qc.getQueryData(["/api/budgets", "2026-09", "everyone"]) as any).budgets).toEqual([{ id: "b2" }]);
    expect((qc.getQueryData(["/api/budgets", "2026-09", "selected", "p1"]) as any).budgets).toEqual([]);
    // Other months are untouched.
    expect((qc.getQueryData(["/api/budgets", "2026-08", "everyone"]) as any).budgets).toEqual([{ id: "b1" }]);
    // The exact-key slot the old code wrote never existed; nothing was created there.
    expect(qc.getQueryData(["/api/budgets", "2026-09"])).toBeUndefined();

    restore();
    expect((qc.getQueryData(["/api/budgets", "2026-09", "everyone"]) as any).budgets).toEqual([{ id: "b1" }, { id: "b2" }]);
    expect((qc.getQueryData(["/api/budgets", "2026-09", "selected", "p1"]) as any).budgets).toEqual([{ id: "b1" }]);
  });

  it("leaves slots alone when the updater returns undefined", () => {
    qc.clear();
    qc.setQueryData(["/api/trackers", "everyone"], [{ id: "t1" }]);
    qc.setQueryData(["/api/trackers", "t1"], { id: "t1", entries: [] }); // a single-tracker slot, not a list
    patchQueries(["/api/trackers"], (old) => Array.isArray(old) ? old.filter((t: any) => t.id !== "t1") : undefined);
    expect(qc.getQueryData(["/api/trackers", "everyone"])).toEqual([]);
    expect(qc.getQueryData(["/api/trackers", "t1"])).toEqual({ id: "t1", entries: [] });
  });

  it("composeRestores runs every restore", () => {
    qc.clear();
    qc.setQueryData(["/api/a"], [1]);
    qc.setQueryData(["/api/b"], [2]);
    const restore = composeRestores(
      patchQueries(["/api/a"], () => []),
      patchQueries(["/api/b"], () => []),
      undefined,
    );
    expect(qc.getQueryData(["/api/a"])).toEqual([]);
    restore();
    expect(qc.getQueryData(["/api/a"])).toEqual([1]);
    expect(qc.getQueryData(["/api/b"])).toEqual([2]);
  });
});

describe("item 1: profile-detail embeds are patched under the field the page renders", () => {
  it("writes relatedTasks / relatedTrackers (not `tasks` / `trackers`) and rolls back", () => {
    qc.clear();
    const key = ["/api/profiles", "p1", "detail"];
    qc.setQueryData(key, {
      id: "p1", name: "Bob",
      relatedTasks: [{ id: "t1", status: "todo" }, { id: "t2", status: "todo" }],
      relatedTrackers: [{ id: "tr1", entries: [{ id: "e1" }, { id: "e2" }] }],
    });

    const restoreTask = patchProfileDetailList(
      "p1", "relatedTasks", (list) => list.map((t: any) => t.id === "t1" ? { ...t, status: "done" } : t));
    const restoreTracker = patchProfileDetailList(
      "p1", "relatedTrackers", (list) => list.map((t: any) => ({ ...t, entries: t.entries.filter((e: any) => e.id !== "e1") })));

    const patched = qc.getQueryData<any>(key);
    expect(patched.relatedTasks[0].status).toBe("done");
    expect(patched.relatedTrackers[0].entries).toEqual([{ id: "e2" }]);
    // The stray fields the old code wrote never appear.
    expect(patched.tasks).toBeUndefined();
    expect(patched.trackers).toBeUndefined();

    restoreTracker(); restoreTask();
    const back = qc.getQueryData<any>(key);
    expect(back.relatedTasks[0].status).toBe("todo");
    expect(back.relatedTrackers[0].entries).toHaveLength(2);
  });

  it("is a no-op when nothing is cached for that profile", () => {
    qc.clear();
    const restore = patchProfileDetailList("ghost", "relatedTasks", (list) => list);
    expect(qc.getQueryData(["/api/profiles", "ghost", "detail"])).toBeUndefined();
    restore();
    expect(qc.getQueryData(["/api/profiles", "ghost", "detail"])).toBeUndefined();
  });
});

describe("item 5: marking a bill paid patches the aggregate the section renders", () => {
  it("drops the bill from every dashboard-enhanced variant and leaves /api/obligations alone", () => {
    qc.clear();
    const bills = [{ id: "o1", name: "Rent" }, { id: "o2", name: "Power" }];
    qc.setQueryData(["/api/dashboard-enhanced", "everyone"], { financeSnapshot: { upcomingBills: bills, totalMonthlySpend: 5 } });
    qc.setQueryData(["/api/dashboard-enhanced", "selected", "p1"], { financeSnapshot: { upcomingBills: bills } });
    qc.setQueryData(["/api/obligations", "everyone"], [{ id: "o1" }, { id: "o2" }]);

    const restore = dropUpcomingBillFromDashboard("o1");
    expect(qc.getQueryData<any>(["/api/dashboard-enhanced", "everyone"]).financeSnapshot.upcomingBills).toEqual([{ id: "o2", name: "Power" }]);
    expect(qc.getQueryData<any>(["/api/dashboard-enhanced", "everyone"]).financeSnapshot.totalMonthlySpend).toBe(5);
    expect(qc.getQueryData<any>(["/api/dashboard-enhanced", "selected", "p1"]).financeSnapshot.upcomingBills).toEqual([{ id: "o2", name: "Power" }]);
    // The obligation is still live (it advanced to its next due date): the entity list keeps it.
    expect(qc.getQueryData(["/api/obligations", "everyone"])).toEqual([{ id: "o1" }, { id: "o2" }]);

    restore();
    expect(qc.getQueryData<any>(["/api/dashboard-enhanced", "everyone"]).financeSnapshot.upcomingBills).toEqual(bills);
  });

  it("dashboard ObligationsSection.payMutation no longer filters the obligations entity lists", () => {
    const src = read("client/src/pages/dashboard.tsx");
    const start = src.indexOf("function ObligationsSection(");
    const end = src.indexOf("const deleteMutation", start);
    const pay = src.slice(start, end);
    expect(pay).toContain("dropUpcomingBillFromDashboard(");
    expect(pay).not.toMatch(/setQueriesData\(\s*\{\s*queryKey:\s*\["\/api\/obligations"\]/);
  });
});

// ── Item 6: the Now queue's `acted` veil lifts on failure ───────────────────
describe("item 6: Now-queue row is not hidden behind a success toast on failure", () => {
  const src = read("client/src/pages/dashboard.tsx");
  const start = src.indexOf("function NowQueueSection(");
  const end = src.indexOf("const KIND_ICON", start);
  const body = src.slice(start, end);

  it("doAction no longer toasts before the request resolves", () => {
    const da = body.slice(body.indexOf("const doAction"), body.indexOf("};", body.indexOf("const doAction")));
    expect(da).not.toContain("toast(");
  });
  it("both mutations toast on success and un-act the row on error", () => {
    for (const name of ["completeTask", "payBill"]) {
      const m = body.slice(body.indexOf(`const ${name} = useMutation(`), body.indexOf("onSettled", body.indexOf(`const ${name} = useMutation(`)));
      expect(m, name).toMatch(/onSuccess:[^\n]*toast\(/);
      const onError = m.slice(m.indexOf("onError"));
      expect(onError, name).toContain("unact(key)");
    }
  });
});

// ── Item 3: one bill list feeds the KPI, the card and the popup ─────────────
describe("item 3: Bills Due tile and popup read the same list", () => {
  it("finance.tsx no longer slices a 14-day / 8-row window for the tile", () => {
    const src = read("client/src/pages/finance.tsx");
    expect(src).not.toMatch(/daysUntil\s*<=\s*14/);
    expect(src).not.toContain("bills14");
    // Both the overview and the popup receive the untrimmed snapshot window.
    expect(src).toContain("bills={upcomingBillsList}");
    expect(src).toContain("bills={upcomingBills}");
  });
});

// ── Item 10: ownership link tables belong to the profile-ish domains ────────
describe("item 10: asset-party-links / liability-profile-links are invalidated with their domains", () => {
  it.each(["profiles", "assets", "liabilities"] as const)("domain %s busts both link tables", async (domain) => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    spy.mockClear();
    await invalidateDomains(domain);
    // The bus invalidates with ONE combined predicate per call (one refetch per
    // active query — tests/cache-bus-single-refetch.test.ts), so ask that
    // predicate about each key instead of reading a queryKey argument.
    const invalidated = (key: unknown[]) => spy.mock.calls.some((c: any[]) => {
      const a = c[0];
      if (typeof a?.predicate === "function") return a.predicate({ queryKey: key });
      return JSON.stringify(a?.queryKey) === JSON.stringify(key);
    });
    expect(invalidated(["/api/asset-party-links"])).toBe(true);
    expect(invalidated(["/api/liability-profile-links"])).toBe(true);
    spy.mockRestore();
  });
});

// ── Item 11: whole-set pages ask for the whole set ──────────────────────────
describe("item 11: list pages pass the full-list limit", () => {
  it("withFullLimit appends the shared limit whatever the query string", () => {
    expect(withFullLimit("/api/tasks")).toBe(`/api/tasks?limit=${FULL_LIST_LIMIT}`);
    expect(withFullLimit("/api/tasks?profileIds=a,b")).toBe(`/api/tasks?profileIds=a,b&limit=${FULL_LIST_LIMIT}`);
    // The server's paginate() caps at 500; asking for more would change nothing.
    expect(FULL_LIST_LIMIT).toBe(500);
  });

  it("every whole-set list fetch on the dashboard / tabs / calendar carries it", () => {
    const files = [
      "client/src/pages/dashboard.tsx", "client/src/pages/tasks.tsx", "client/src/pages/habits.tsx",
      "client/src/pages/wellness.tsx", "client/src/hooks/useCalendarOccurrences.ts",
      "client/src/components/CalendarManagerPanel.tsx",
    ];
    // A GET of a paginate()-backed list route built without withFullLimit(...).
    const bare = /apiRequest\("GET",\s*`\/api\/(tasks|habits|obligations|goals|events)[^`]*`\)/g;
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      let m: RegExpExecArray | null;
      while ((m = bare.exec(src)) !== null) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${f}:${line} ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the query keys the bootstrap seeds (the limit lives in the URL only)", () => {
    // The seed keys are pinned by tests/bootstrap-seed-keys.test.ts; here we
    // just make sure no list key grew a "limit" discriminator.
    for (const f of ["client/src/pages/dashboard.tsx", "client/src/pages/tasks.tsx", "client/src/pages/habits.tsx", "client/src/pages/wellness.tsx"]) {
      expect(read(f)).not.toMatch(/queryKey:\s*\[[^\]]*limit/);
    }
  });
});

// D87 — the hub KPI strip rounded -23.5 to "-$23" (Math.round rounds toward
// +∞) while the hero card counted up Math.round(Math.abs(n)) = 24. Same
// number, two dollar figures on one screen. Rounding the magnitude fixes both
// tiles at the one formatter; the wellness strip printed "$-23.5" outright.
describe("D87: one rounding rule for every money tile", () => {
  it("rounds the magnitude, so negatives round away from zero", () => {
    expect(formatMoneyRound(-23.5)).toBe("-$24");
    expect(formatMoneyRound(23.5)).toBe("$24");
    expect(formatMoneyRound(-0.4)).toBe("$0");
    expect(formatMoneyRound(-1234.5)).toBe("-$1,235");
    expect(formatMoneyRound(null)).toBe("$0");
  });
  it("the wellness strip no longer prints a raw signed number after the dollar sign", () => {
    const src = read("client/src/pages/dashboard.tsx");
    expect(src).not.toMatch(/\$\{cashFlow\.toLocaleString\(\)\}/);
    expect(src).not.toMatch(/\$\{monthly(Spend|Income)\.toLocaleString\(\)\}/);
  });
});

// D96 — cash trend: month-aware inflow and string-bucketed outflow.
import { buildCashTrend, monthKeyBack } from "../client/src/lib/cash-trend";
describe("D96: buildCashTrend", () => {
  it("steps months back across a year boundary", () => {
    expect(monthKeyBack("2026-09-02", 0)).toBe("2026-09");
    expect(monthKeyBack("2026-09-02", 5)).toBe("2026-04");
    expect(monthKeyBack("2026-01-15", 1)).toBe("2025-12");
  });
  it("buckets an expense dated the 1st in its own month and only paints income from its start month", () => {
    const expenses = [
      { amount: 100, date: "2026-09-01" },   // September, not Aug 31
      { amount: 40, date: "2026-08-15" },
      { amount: 7, createdAt: "2026-07-01T03:00:00.000Z" }, // Jun 30 20:00 in LA
    ];
    const incomes = [{ amount: 1200, frequency: "monthly", date: "2026-08-28" }];
    const t = buildCashTrend(expenses, incomes, "2026-09-02", "America/Los_Angeles");
    expect(t.map(p => p.month)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
    expect(t.map(p => p.inflow)).toEqual([0, 0, 0, 0, 1200, 1200]);
    expect(t.map(p => p.outflow)).toEqual([0, 0, 7, 0, 40, 100]);
    expect(t[5].net).toBe(1100);
  });
});

// D117 — four pages handed passesProfileFilter a profile list stripped to
// { id, type }, so the owner chain (D88) was lost there: the Tasks page hid
// the "Bill due" tasks (linked to a bill whose parent is Self) that the
// dashboard counted, and the two "completed" figures disagreed.
describe("D117: every client scope filter keeps parentProfileId", () => {
  it("no caller maps profiles down to { id, type } only", () => {
    const files = ["client/src/pages/finance.tsx", "client/src/pages/journal.tsx", "client/src/pages/tasks.tsx", "client/src/pages/artifacts.tsx"];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/allProfiles:\s*[^\n]*\.map\([^)]*=>\s*\(\{\s*id:\s*p\.id,\s*type:\s*p\.type\s*\}\)\)/);
      expect(src, f).toMatch(/parentProfileId/);
    }
  });
});
