/**
 * Regression ledger — one `it()` per shipped bug fix.
 *
 * The rule: every time we fix a user-visible bug, we add an `it("BUG-YYYYMMDD-...")`
 * block here that fails before the fix and passes after. This file is append-only.
 * Removing or weakening an entry requires the user's explicit sign-off.
 *
 * Naming convention:
 *   BUG-YYYYMMDD-short-kebab — date the bug was reported, not the date it was fixed.
 *
 * If the same bug recurs (a "regression"), do NOT add a second entry. Investigate
 * why the original assertion didn't catch it and strengthen it instead.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api, expectOk } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import type { SeedResult } from "../fixture/seed";

let fixture: SeedResult;

beforeAll(async () => {
  fixture = await ensureSeeded();
}, 120_000);

describe("contract: regressions", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // BUG-20260528-finance-tracker
  //
  // Report: Trackers page showed a "Finance" group filter chip and three
  //   finance-flavoured trackers (Gaming Expenses, Hawaii Savings, Pet
  //   Expenses) sitting alongside health/fitness trackers. The user pointed
  //   out: "there's no such thing as a finance tracker" — money lives in
  //   /expenses, /budgets, /obligations.
  //
  // Contract: the server rejects POST /api/trackers with a finance-flavoured
  //   category, and GET /api/trackers never returns rows with such a category.
  // ──────────────────────────────────────────────────────────────────────────
  it("BUG-20260528-finance-tracker: server rejects category=finance", async () => {
    const r = await api("POST", "/trackers", {
      name: `Regression Probe finance ${Date.now()}`,
      category: "finance",
      unit: "$",
      fields: [{ name: "value", type: "number" }],
      linkedProfiles: [fixture.selfId],
    });
    expect(r.status, `expected 4xx, got ${r.status} (${JSON.stringify(r.data).slice(0, 200)})`).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("BUG-20260528-finance-tracker: server rejects category=budget", async () => {
    const r = await api("POST", "/trackers", {
      name: `Regression Probe budget ${Date.now()}`,
      category: "budget",
      unit: "$",
      fields: [{ name: "value", type: "number" }],
      linkedProfiles: [fixture.selfId],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("BUG-20260528-finance-tracker: GET /api/trackers returns no finance-category rows", async () => {
    const r = expectOk(await api<any[]>("GET", "/trackers")) as any[];
    const offenders = r.filter(t => ["finance", "budget", "savings", "investment", "money", "spending"].includes(String(t.category || "").toLowerCase()));
    expect(offenders, `leaked: ${offenders.map(t => `${t.name}/${t.category}`).join(", ")}`).toHaveLength(0);
  });

  // Add future regressions BELOW this line. Do not delete previous entries.
});
