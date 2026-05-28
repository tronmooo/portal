/**
 * Dashboard contracts — the numbers shown on the dashboard must match the
 * sums of the rows you'd see if you opened the drilldown.
 *
 * The fixture seed is deliberately tiny and known so we can compute the
 * expected values up-front and lock them in.
 *
 * Shape notes (locked 2026-05-28):
 *   GET /api/stats              → totalProfiles, totalExpenses, monthlySpend, monthlyObligationTotal, …
 *   GET /api/dashboard-enhanced → { financeSnapshot: { totalAssetValue, totalLiabilities, totalMonthlySpend, … }, healthSnapshot, … }
 *
 * If either response shape changes, fix the assertion *and* update the UI
 * consumers — never weaken the test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api, expectOk } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import { FIXTURE } from "../fixture/seed";
import type { SeedResult } from "../fixture/seed";

let fixture: SeedResult;

beforeAll(async () => {
  fixture = await ensureSeeded();
}, 120_000);

describe("contract: dashboard math", () => {
  it("DASH-01: financeSnapshot.totalAssetValue >= sum of fixture asset values", async () => {
    const dash = expectOk(await api<any>("GET", "/dashboard-enhanced"));
    const totalAssets = Number(dash?.financeSnapshot?.totalAssetValue ?? -1);
    const expectedMin = FIXTURE.asset.fields.currentValue + FIXTURE.vehicle.fields.currentValue;
    expect(totalAssets, "missing financeSnapshot.totalAssetValue").toBeGreaterThanOrEqual(expectedMin);
  });

  it("DASH-02: financeSnapshot.totalLiabilities >= fixture mortgage balance", async () => {
    const dash = expectOk(await api<any>("GET", "/dashboard-enhanced"));
    const totalLiabilities = Number(dash?.financeSnapshot?.totalLiabilities ?? -1);
    expect(totalLiabilities).toBeGreaterThanOrEqual(FIXTURE.liability.fields.currentBalance);
  });

  it("DASH-03: derived net worth (assets - liabilities) is finite and reflects fixture", async () => {
    const dash = expectOk(await api<any>("GET", "/dashboard-enhanced"));
    const assets = Number(dash?.financeSnapshot?.totalAssetValue ?? 0);
    const liab = Number(dash?.financeSnapshot?.totalLiabilities ?? 0);
    const net = assets - liab;
    expect(Number.isFinite(net)).toBe(true);
    // The fixture's net is 525k - 350k = 175k. Other test data may push this
    // higher, so we just lock the lower bound.
    const expectedMinNet =
      FIXTURE.asset.fields.currentValue +
      FIXTURE.vehicle.fields.currentValue -
      FIXTURE.liability.fields.currentBalance;
    expect(net).toBeGreaterThanOrEqual(expectedMinNet);
  });

  it("DASH-04: /api/stats.monthlySpend equals sum of current-month expenses", async () => {
    const stats = expectOk(await api<any>("GET", "/stats"));
    const expenses = expectOk(await api<any[]>("GET", "/expenses")) as any[];
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const sum = expenses
      .filter(e => String(e.date || "").startsWith(month))
      .reduce((acc, e) => acc + Number(e.amount || 0), 0);
    expect(Math.abs(Number(stats.monthlySpend ?? 0) - sum), `monthlySpend ${stats.monthlySpend} != expenses sum ${sum}`).toBeLessThan(0.01);
  });

  it("DASH-05: financeSnapshot.spendByCategory sums equal monthlySpend", async () => {
    const dash = expectOk(await api<any>("GET", "/dashboard-enhanced"));
    const stats = expectOk(await api<any>("GET", "/stats"));
    const catMap = dash?.financeSnapshot?.spendByCategory ?? {};
    const catSum = Object.values(catMap).reduce((a: number, v: any) => a + Number(v), 0);
    const monthly = Number(stats.monthlySpend ?? 0);
    expect(Math.abs(catSum - monthly), `category-sum ${catSum} != monthlySpend ${monthly}`).toBeLessThan(0.01);
  });
});
