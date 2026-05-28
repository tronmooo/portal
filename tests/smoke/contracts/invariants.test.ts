/**
 * Invariant contracts — the rules that MUST hold across every release.
 *
 * Each `it()` corresponds to a real-world rule the app's UX depends on. If a
 * test here breaks, do not weaken the assertion: the user-facing contract is
 * what's wrong, and the code needs to be fixed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api, expectOk } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import type { SeedResult } from "../fixture/seed";

// Categories that the server's expense schema currently accepts. Mirrored here
// so the suite catches an accidental silent removal/addition on either side.
const ALLOWED_EXPENSE_CATEGORIES = new Set([
  "food", "transport", "health", "entertainment", "pet", "vehicle",
  "housing", "utilities", "general", "education", "shopping", "insurance",
  "travel", "subscription", "utility", "other",
]);

// Tracker categories that are no longer first-class — anything that rolls up
// into "Finance" lives in /expenses, /budgets or /obligations, not /trackers.
// Server should reject these on POST and they must never appear in any GET
// /api/trackers payload.
const HIDDEN_TRACKER_CATEGORIES = new Set([
  "finance", "budget", "savings", "investment", "money", "spending",
]);

let fixture: SeedResult;

beforeAll(async () => {
  fixture = await ensureSeeded();
}, 120_000);

describe("contract: invariants", () => {
  it("INV-01: every expense category returned by /api/expenses is in the allow-list", async () => {
    const r = expectOk(await api<any[]>("GET", "/expenses"));
    const cats = new Set((r as any[]).map((e) => String(e.category || "").toLowerCase()));
    for (const c of cats) {
      expect(ALLOWED_EXPENSE_CATEGORIES.has(c), `unexpected expense category: ${c}`).toBe(true);
    }
  });

  it("BUG-20260528-finance-tracker: server rejects creating a tracker whose category is in HIDDEN_TRACKER_CATEGORIES", async () => {
    for (const cat of HIDDEN_TRACKER_CATEGORIES) {
      const r = await api("POST", "/trackers", {
        name: `Invariant Probe ${cat} ${Date.now()}`,
        category: cat,
        unit: "x",
        fields: [{ name: "value", type: "number" }],
        linkedProfiles: [fixture.selfId],
      });
      expect(r.status, `category ${cat} should be rejected (got ${r.status})`).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });

  it("BUG-20260528-finance-tracker: GET /api/trackers never returns a tracker whose category resolves to a hidden group", async () => {
    const r = expectOk(await api<any[]>("GET", "/trackers"));
    const offenders = (r as any[]).filter(t =>
      HIDDEN_TRACKER_CATEGORIES.has(String(t.category || "").toLowerCase()),
    );
    expect(offenders, `hidden-category trackers leaked: ${offenders.map(t => t.name + "/" + t.category).join(", ")}`).toHaveLength(0);
  });

  it("INV-02: self profile is unique per user", async () => {
    const profs = expectOk(await api<any[]>("GET", "/profiles")) as any[];
    const selves = profs.filter(p => p.type === "self");
    expect(selves.length, "more than one self profile").toBe(1);
  });

  it("INV-03: every linked entity points to a profile the user actually owns", async () => {
    const profs = expectOk(await api<any[]>("GET", "/profiles")) as any[];
    const ownedIds = new Set(profs.map(p => p.id));
    const expenses = expectOk(await api<any[]>("GET", "/expenses")) as any[];
    for (const e of expenses) {
      for (const pid of (e.linkedProfiles || [])) {
        expect(ownedIds.has(pid), `expense ${e.id} links to non-owned profile ${pid}`).toBe(true);
      }
    }
  });

  it("INV-04: /api/stats responds and has expected top-level keys", async () => {
    const r = expectOk(await api<any>("GET", "/stats"));
    // Lock the response shape so a refactor that drops a key gets caught.
    for (const k of ["totalProfiles", "totalExpenses", "monthlySpend", "monthlyObligationTotal", "totalObligations"]) {
      expect(r, `missing key ${k} on /api/stats`).toHaveProperty(k);
    }
  });

  it("INV-05: /api/dashboard-enhanced.financeSnapshot has totalAssetValue and totalLiabilities", async () => {
    const r = expectOk(await api<any>("GET", "/dashboard-enhanced"));
    expect(r, "missing financeSnapshot block").toHaveProperty("financeSnapshot");
    for (const k of ["totalAssetValue", "totalLiabilities", "totalMonthlySpend"]) {
      expect(r.financeSnapshot, `missing financeSnapshot.${k}`).toHaveProperty(k);
    }
  });
});

export { HIDDEN_TRACKER_CATEGORIES, ALLOWED_EXPENSE_CATEGORIES };
