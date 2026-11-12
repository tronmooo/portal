/**
 * "Smoke detector batteries" is a household chore, not test data (2026-11-12).
 *
 * Rows that look like QA debris are hidden from the dashboard and left out of
 * every total (Rule 27). The smoke pattern was `/^SMOKE[_ ]/i` — any name that
 * starts with the word. A real task "Smoke detector batteries" disappeared
 * from the dashboard's Tasks card ("No open tasks") while the Tasks page
 * listed it, and an expense "Smoke alarm replacement" was missing from Spend.
 * The pattern now names the fixture's own rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestDataRow, excludeTestData } from "../shared/test-data";

describe("real things that start with the word 'smoke'", () => {
  it.each([
    "Smoke detector batteries",
    "Smoke alarm — replace",
    "Smoke shop",
    "Smoke House BBQ dinner",
    "Smoke Child's school fees",
    "SMOKE DETECTOR",
  ])("%s is the user's own data", (name) => {
    expect(isTestDataRow(name)).toBe(false);
  });
  it("is counted in a total", () => {
    const rows = [{ description: "Smoke alarm replacement", amount: 40 }, { description: "Smoke Groceries", amount: 120 }];
    expect(excludeTestData(rows).map((r) => r.description)).toEqual(["Smoke alarm replacement"]);
  });
});

describe("the smoke fixture's own rows are still recognised", () => {
  // Every literal "Smoke …" name the fixture and the suites create.
  const seed = readFileSync(join(__dirname, "smoke/fixture/seed.ts"), "utf8");
  const names = Array.from(new Set(Array.from(seed.matchAll(/"(Smoke [^"]+)"/g)).map((m) => m[1])));
  it("reads names from the real seed", () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain("Smoke Internet Bill");
  });
  it.each(names)("%s", (name) => {
    expect(isTestDataRow(name)).toBe(true);
  });
  it.each(["SMOKE_1780532176_expense", "Smoke Task: file tax docs", "Smoke Event: dentist", "Smoke Child flossed today", "Smoke test task", "Smoke Test"])("%s", (name) => {
    expect(isTestDataRow(name)).toBe(true);
  });
});

// ── A row the lists hide is a row the totals do not count ────────────────────
import { SupabaseStorage } from "../server/supabase-storage";

describe("the dashboard snapshot applies the test-data rule to bills, like the Bills list does", () => {
  const SELF = { id: "self", type: "self", name: "Me", fields: {} };
  const today = new Date().toISOString().slice(0, 10);
  const bill = (name: string) => ({ id: name, name, amount: 75, frequency: "monthly", status: "active", nextDueDate: today, linkedProfiles: ["self"], payments: [] });
  function storageOver(obligations: any[]) {
    const real: any = Object.create(SupabaseStorage.prototype);
    real.userId = "user-1"; real._timezone = "UTC";
    const proto: any = SupabaseStorage.prototype;
    return new Proxy(real, { get(target, key: string) {
      if (key === "getProfiles") return async () => [SELF];
      if (key === "getObligations") return async () => obligations;
      if (key === "listAssetValuationHistories") return async () => ({});
      if (typeof key === "string" && key !== "getDashboardEnhanced" && typeof proto[key] === "function" && /^(get|list)[A-Z]/.test(key)) return async () => [];
      return target[key];
    } }) as any;
  }
  it("counts a real bill and leaves a fixture bill out, unless test data is asked for", async () => {
    const s = storageOver([bill("Internet"), bill("Smoke Internet Bill")]);
    const hidden = (await s.getDashboardEnhanced()).financeSnapshot;
    expect(hidden.upcomingBills.map((b: any) => b.name)).toEqual(["Internet"]);
    expect(hidden.unpaidBillsThisMonth).toBe(75);
    const shown = (await s.getDashboardEnhanced(undefined, undefined, { includeTestData: true })).financeSnapshot;
    expect(shown.upcomingBills.map((b: any) => b.name).sort()).toEqual(["Internet", "Smoke Internet Bill"]);
    expect(shown.unpaidBillsThisMonth).toBe(150);
  });
});
