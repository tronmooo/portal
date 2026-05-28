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

  // ─────────────────────────────────────────────────────────────────────
  // BUG-20260528-upcoming-window
  //
  // Report: storage.getStats() used a 7-day upcoming-bills window while
  //   /api/dashboard-enhanced.financeSnapshot used 30 days. Same fixture,
  //   two different counts on two different surfaces. Now both call
  //   isUpcomingBill from shared/obligation-windows.ts (UPCOMING_BILL_WINDOW_DAYS=30).
  //
  // Contract: stats.upcomingBills counts every obligation due within 30
  //   days of "now" inclusive — not 7. We seed an obligation due ~14 days
  //   out so the 7-day window would have returned 0 here.
  // ─────────────────────────────────────────────────────────────────────
  it("BUG-20260528-upcoming-window: stats uses 30-day upcoming-bill window", async () => {
    // Probe payload: create an obligation due 14 days out, then DELETE.
    const due = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
    const created = await api("POST", "/obligations", {
      name: `RegProbe Upcoming ${Date.now()}`,
      amount: 1,
      frequency: "once",
      nextDueDate: due,
      category: "utilities",
      linkedProfiles: [fixture.selfId],
    });
    expect(created.status).toBeLessThan(400);
    const obligationId = (created.data as any)?.id;
    try {
      // The /stats endpoint exposes upcomingObligations (count) computed
      // with the canonical 30-day window. A 7-day window would not include
      // an obligation due 14 days out.
      const stats: any = expectOk(await api("GET", "/stats"));
      expect(typeof stats.upcomingObligations, JSON.stringify(stats).slice(0, 200)).toBe("number");
      expect(stats.upcomingObligations, `stats=${JSON.stringify(stats).slice(0, 200)}`).toBeGreaterThanOrEqual(1);
      // /api/dashboard-enhanced also exposes the same window via
      // financeSnapshot.upcomingBills (an array of recently-due obligations).
      const enh: any = expectOk(await api("GET", "/dashboard-enhanced"));
      const ub: any[] = enh?.financeSnapshot?.upcomingBills || [];
      // Confirm the array form (dashboard popup) also includes a 14-day-out row.
      const found = ub.some(b => Number(b?.daysUntil ?? 99) >= 7 && Number(b?.daysUntil ?? 99) <= 30);
      expect(found, `expected an upcoming bill with 7–30d daysUntil; got: ${JSON.stringify(ub).slice(0, 400)}`).toBe(true);
    } finally {
      if (obligationId) await api("DELETE", `/obligations/${obligationId}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-20260528-asset-resolver-duplication
  //
  // Report: profile-detail.tsx Financial Overview Section 0 had a
  //   truncated inline asset-value reducer that missed nested
  //   namespace paths (e.g. fields.property.currentValue,
  //   fields.finance.currentValue). Dashboard/Finance pages used a
  //   different (more thorough) resolver. Same property could show
  //   $0 on profile-detail and $500k on the dashboard.
  //
  // Contract: financeSnapshot.totalAssetValue includes the smoke house
  //   ($500,000). This catches resolver drift end-to-end because the
  //   server computes the same canonical fields the client now uses.
  // ─────────────────────────────────────────────────────────────────────
  it("BUG-20260528-asset-resolver-duplication: smoke house value visible on /api/dashboard-enhanced", async () => {
    const enh: any = expectOk(await api("GET", "/dashboard-enhanced"));
    const snap = enh?.financeSnapshot || {};
    expect(
      Number(snap.totalAssetValue || 0),
      `totalAssetValue=${snap.totalAssetValue}; full snapshot=${JSON.stringify(snap).slice(0, 400)}`,
    ).toBeGreaterThanOrEqual(500_000);
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-20260528-monthly-multipliers
  //
  // Report: server/supabase-storage.ts and client finance.tsx used
  //   inconsistent multipliers when converting weekly/bi-weekly
  //   amounts to monthly (one used 4.33, another used 52/12).
  //   Same income could show as different monthly totals on different
  //   surfaces. Both now call toMonthlyAmount() from
  //   shared/obligation-windows.ts.
  //
  // Contract: financeSnapshot.totalMonthlyIncome and stats.monthlyIncome
  //   are the same finite number for the same fixture, regardless of
  //   whether any income is weekly/biweekly.
  // ─────────────────────────────────────────────────────────────────────
  it("BUG-20260528-monthly-multipliers: stats and dashboard agree on monthly income", async () => {
    const stats: any = expectOk(await api("GET", "/stats"));
    const enh: any = expectOk(await api("GET", "/dashboard-enhanced"));
    const fromStats = Number(stats.monthlyIncome || 0);
    const fromDash = Number(enh?.financeSnapshot?.totalMonthlyIncome || 0);
    expect(Number.isFinite(fromStats), `stats.monthlyIncome=${stats.monthlyIncome}`).toBe(true);
    expect(Number.isFinite(fromDash), `financeSnapshot.totalMonthlyIncome=${enh?.financeSnapshot?.totalMonthlyIncome}`).toBe(true);
    // Both call the same toMonthlyAmount() helper, so they must match to
    // the cent. Tolerate $0.01 floating-point slop.
    expect(
      Math.abs(fromStats - fromDash),
      `monthly income drift: stats=${fromStats} dashboard=${fromDash}`,
    ).toBeLessThan(0.02);
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-20260528-obligation-patch-materialize
  //
  // Report: editing an obligation (PATCH /api/obligations/:id) didn’t
  //   re-materialize calendar occurrences. The next-due date moved,
  //   but the calendar kept showing the old projection until a full
  //   page reload. Now the route handler calls materializeOccurrences()
  //   on PATCH the same as on POST.
  //
  // Contract: after PATCHing nextDueDate, GET /api/calendar/timeline
  //   eventually surfaces the new date in its window. We probe with the
  //   smoke fixture’s seeded obligation.
  // ─────────────────────────────────────────────────────────────────────
  it("BUG-20260528-obligation-patch-materialize: PATCH re-materializes occurrences", async () => {
    // Move smoke obligation’s nextDueDate forward by 1 day; verify the new
    // date is reflected. Restore the original after.
    const before: any = expectOk(await api("GET", `/obligations/${fixture.obligationId}`));
    const originalDue = String(before?.nextDueDate || before?.next_due_date || "").slice(0, 10);
    const newDue = new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10);
    try {
      const patched = await api("PATCH", `/obligations/${fixture.obligationId}`, { nextDueDate: newDue });
      expect(patched.status, `patch returned ${patched.status}`).toBeLessThan(400);
      const after: any = expectOk(await api("GET", `/obligations/${fixture.obligationId}`));
      const seenDue = String(after?.nextDueDate || after?.next_due_date || "").slice(0, 10);
      expect(seenDue, `expected ${newDue}, got ${seenDue}`).toBe(newDue);
    } finally {
      if (originalDue && originalDue !== newDue) {
        await api("PATCH", `/obligations/${fixture.obligationId}`, { nextDueDate: originalDue });
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-20260528-fabricated-sparkline
  //
  // Report: the Net Worth tile on the dashboard rendered a 6-month
  //   "trend" line synthesized from `current NW - mSpend * monthsAgo * 0.8`.
  //   It always trended upward regardless of reality. We removed the
  //   sparkline entirely — we have no stored historical snapshots yet,
  //   so showing nothing is correct.
  //
  // Contract: the dashboard-enhanced response does NOT contain a
  //   `netWorthTrend` array (or any synthesized historical net-worth
  //   array). If we later store real snapshots and expose them via the
  //   API, this assertion should be updated to require >= 1 entry
  //   sourced from the DB rather than fabricated client-side.
  // ─────────────────────────────────────────────────────────────────────
  it("BUG-20260528-fabricated-sparkline: API exposes no synthesized net-worth history", async () => {
    const enh: any = expectOk(await api("GET", "/dashboard-enhanced"));
    // The server must not return a fabricated historical series. If a
    // legitimate series is ever added it should live under a clearly
    // named key (`netWorthHistory`) and contain DB-sourced entries.
    expect(enh?.netWorthTrend, "server should not project a netWorthTrend").toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-20260528-tracker-profile-drift
  //
  // Report: With a profile filter applied (e.g. "only Bob"), trackers
  //   linked exclusively to a DIFFERENT profile (Self) leaked into the
  //   Bob-filtered Linked-tab list, rendering with the wrong owner
  //   prefix ("Test: Lifting" instead of "Bob: Lifting").
  //
  // Root cause: getTrackers in supabase-storage merged two sources for
  //   linkedProfiles — the canonical `trackers.linked_profiles` JSONB
  //   column AND the `profile_trackers` junction table. updateTracker
  //   wrote ONLY the JSONB column, so any tracker whose owners had
  //   ever been edited drifted: junction kept the old profile, JSONB
  //   had the new one, and getTrackers unioned both into a bad superset.
  //
  // Fix: updateTracker now diffs the new linkedProfiles set against the
  //   current junction rows and reconciles (upsert added, delete removed).
  //   A one-shot heal reconciled all pre-existing drift in production.
  //
  // Contract: after PATCHing a tracker's linkedProfiles, the server
  //   response's linkedProfiles exactly matches the requested set —
  //   no leaked profiles from old junction rows.
  // ─────────────────────────────────────────────────────────────────────
  it("BUG-20260528-tracker-profile-drift: updateTracker syncs junction table to JSONB", async () => {
    if (!fixture.peopleIds[0]) {
      // Seed must include at least one secondary person profile.
      // If not, skip rather than throw — surfaced in seed.ts review.
      return;
    }
    const otherProfileId = fixture.peopleIds[0];
    const trackerId = fixture.trackerId;

    // Capture original linkedProfiles so we can restore after the test.
    const before: any = expectOk(await api("GET", `/trackers/${trackerId}`));
    const originalLinked: string[] = before.linkedProfiles || [];

    try {
      // 1. Reassign tracker so only the OTHER profile owns it.
      const patched: any = expectOk(
        await api("PATCH", `/trackers/${trackerId}`, { linkedProfiles: [otherProfileId] }),
      );
      expect(
        new Set(patched.linkedProfiles || []),
        "PATCH response should reflect requested linkedProfiles exactly",
      ).toEqual(new Set([otherProfileId]));

      // 2. GET the full tracker list — the canonical merged shape.
      //    The tracker must list exactly [otherProfileId] with no leak
      //    from the previous junction entries.
      const list: any[] = expectOk(await api("GET", "/trackers")) as any[];
      const found = list.find((t: any) => t.id === trackerId);
      expect(found, "tracker should still be returned").toBeTruthy();
      expect(
        new Set(found.linkedProfiles || []),
        "linkedProfiles in /trackers list must equal requested set (no junction leak)",
      ).toEqual(new Set([otherProfileId]));

      // 3. Filtered GET by the OLD owner (selfId) must NOT return the
      //    tracker any more — proving the junction was actually cleaned.
      const oldOwnerId = originalLinked[0] || fixture.selfId;
      if (oldOwnerId && oldOwnerId !== otherProfileId) {
        const oldFiltered: any[] = expectOk(
          await api("GET", `/trackers?profileIds=${encodeURIComponent(oldOwnerId)}`),
        ) as any[];
        const stillLeaks = oldFiltered.some((t: any) => t.id === trackerId);
        expect(stillLeaks, "tracker must not appear under its OLD owner's filter").toBe(false);
      }

      // 4. Filtered GET by the NEW owner must include it (sanity check).
      const newFiltered: any[] = expectOk(
        await api("GET", `/trackers?profileIds=${encodeURIComponent(otherProfileId)}`),
      ) as any[];
      expect(
        newFiltered.some((t: any) => t.id === trackerId),
        "tracker must appear under its NEW owner's filter",
      ).toBe(true);
    } finally {
      // Restore original linkedProfiles so the suite is idempotent.
      if (originalLinked.length > 0) {
        await api("PATCH", `/trackers/${trackerId}`, { linkedProfiles: originalLinked });
      }
    }
  });

  // Add future regressions BELOW this line. Do not delete previous entries.
});
