/**
 * A loan's balance is debt — on the SERVER's balance sheet too (2026-11-12).
 *
 * `resolveAssetValue` knows a `type: "loan"` profile's `balance` is what is
 * owed, not what it is worth — but only when it is handed the PROFILE. Every
 * server caller handed it `p.fields`, where there is no type to read, so the
 * rule never fired: a $350,000 mortgage was added to assets and subtracted as
 * debt, and the dashboard's Net Worth read $525,000 for a household worth
 * $175,000 (house $500k + car $25k − mortgage $350k). The client-side
 * `computeNetWorth` had been right since 2026-09; the server figure — the one
 * the KPI strip, the Balance Sheet popup and the 30-day baseline show — was not.
 *
 * These tests drive the real `SupabaseStorage` methods over fixture reads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SupabaseStorage } from "../server/supabase-storage";
import { profileValueFingerprint } from "../shared/profile-summary-fingerprint";

const SELF = { id: "self", type: "self", name: "Me", fields: {}, createdAt: "2026-01-01T00:00:00Z" };
const HOUSE = { id: "house", type: "property", name: "House", fields: { currentValue: 500000 }, parentProfileId: "self", createdAt: "2026-01-01T00:00:00Z" };
const CAR = { id: "car", type: "vehicle", name: "Car", fields: { currentValue: 25000 }, parentProfileId: "self", createdAt: "2026-01-01T00:00:00Z" };
// Exactly what the server stores for a mortgage created through the app.
const MORTGAGE = { id: "mortgage", type: "loan", name: "Mortgage", fields: { balance: 350000, interestRate: 6.5, monthlyPayment: 2200 }, parentProfileId: "self", createdAt: "2026-01-01T00:00:00Z" };

/** The real storage class with every table read answered from fixtures. */
function makeStorage(profiles: any[]) {
  const real: any = Object.create(SupabaseStorage.prototype);
  real.userId = "user-1";
  real._timezone = "UTC";
  const proto: any = SupabaseStorage.prototype;
  const RUN_REAL = new Set(["getDashboardEnhanced", "getProfileAssetValue"]);
  return new Proxy(real, {
    get(target, key: string) {
      if (key === "getProfiles") return async () => profiles;
      if (key === "getProfile") return async (id: string) => profiles.find((p) => p.id === id);
      if (key === "listAssetValuationHistories") return async () => ({});
      if (typeof key === "string" && !RUN_REAL.has(key) && typeof proto[key] === "function" && /^(get|list)[A-Z]/.test(key)) {
        return async () => [];
      }
      return target[key];
    },
  }) as any;
}

describe("the server balance sheet", () => {
  it("counts a mortgage once, as debt: net worth is assets minus the loan", async () => {
    const s = makeStorage([SELF, HOUSE, CAR, MORTGAGE]);
    const { financeSnapshot: f } = await s.getDashboardEnhanced();
    expect(f.totalAssetValue).toBe(525000);
    expect(f.totalLiabilities).toBe(350000);
    expect(f.assetBreakdown.map((r: any) => r.id).sort()).toEqual(["car", "house"]);
    expect(f.liabilityBreakdown.map((r: any) => r.id)).toEqual(["mortgage"]);
    // The rows the popup renders sum to the totals the KPI shows.
    expect(f.assetBreakdown.reduce((t: number, r: any) => t + r.value, 0)).toBe(f.totalAssetValue);
  });

  it("still counts the financed item's own value when the loan profile carries one", async () => {
    const financed = { ...MORTGAGE, id: "carloan", fields: { balance: 20000, currentValue: 30000 } };
    const s = makeStorage([SELF, financed]);
    const { financeSnapshot: f } = await s.getDashboardEnhanced();
    expect(f.totalAssetValue).toBe(30000);
    expect(f.totalLiabilities).toBe(20000);
  });

  it("a person's own asset list leaves the loan balance out too", async () => {
    const s = makeStorage([SELF, HOUSE, CAR, MORTGAGE]);
    const r = await s.getProfileAssetValue("self");
    expect(r.assets.map((a: any) => a.id).sort()).toEqual(["car", "house"]);
    expect(r.liabilities.map((a: any) => a.id)).toEqual(["mortgage"]);
  });

  it("the AI-summary fingerprint reads a loan as debt only", () => {
    expect(profileValueFingerprint(MORTGAGE)).toMatch(/^v0\|d350000\|/);
  });
});

describe("no server caller hands resolveAssetValue bare fields", () => {
  // `resolveAssetValue(p.fields)` compiles and returns a number; it just cannot
  // see `p.type`. Keep the type-dependent rule reachable from every caller.
  const files = [
    ...readdirSync(join(__dirname, "../server")).filter((f) => f.endsWith(".ts")).map((f) => join(__dirname, "../server", f)),
    join(__dirname, "../shared/profile-summary-fingerprint.ts"),
  ];
  it("scans a non-empty set of files that do call the resolver", () => {
    const callers = files.filter((f) => /resolveAssetValue\(/.test(readFileSync(f, "utf8")));
    expect(callers.length).toBeGreaterThan(1);
  });
  it.each(files)("%s", (file) => {
    const src = readFileSync(file, "utf8");
    const bad = src.split("\n").map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /resolveAssetValue\(\s*(\([^)]*\)|[\w.?]+)\s*\.\s*fields\s*\)/.test(line.replace(/\s+as\s+any/g, "")));
    expect(bad.map((b) => `${b.n}: ${b.line.trim()}`)).toEqual([]);
  });
});
