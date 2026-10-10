// Follow-ups from the 2026-10-09 synchronization audit — each one a different
// way two screens (or two devices, or two writes) ended up disagreeing:
//   · one cache key, two payloads (`?limit=500` vs the bare URL),
//   · a "Snooze" that rewrote the bill's real due date, and dismissals that
//     lived in one browser,
//   · one-tap destructive buttons,
//   · whole-array tag writes from a cached copy (lost updates),
//   · an editor draft seeded once and saved back stale,
//   · the valuation engine citing its own estimation noise as a trend,
//   · server-side value reads that bypassed the canonical resolver.
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { withFullLimit } from "../client/src/lib/list-limit";
import { parseSnoozes, activeSnoozes, isSnoozed, mergeSnooze, addDaysISO } from "@shared/alert-snoozes";
import { historyDrift, MAX_TREND_DRIFT } from "@shared/valuation/internal-evidence";
import { parseRecurringMeta } from "@shared/recurring-dates";
import { startHarness, type Harness } from "./helpers/route-harness";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
function clientSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push([path.relative(path.resolve(__dirname, ".."), p), fs.readFileSync(p, "utf8")]);
    }
  };
  walk(path.resolve(__dirname, "../client/src"));
  return out;
}

describe("one cache key, one payload", () => {
  it("the whole list is the bare URL — no `limit=500` cap competing with bare fetches of the same key", () => {
    expect(withFullLimit("/api/tasks?profileIds=a")).toBe("/api/tasks?profileIds=a");
    const offenders = clientSources().filter(([f, src]) => !f.endsWith("list-limit.ts") && /[?&]limit=500\b/.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("the KPI strip reads the slim profile list from the shared ['/api/profiles', 'lite'] slot", () => {
    const src = read("client/src/components/hub/HubKpiStrip.tsx");
    expect(src).not.toContain('queryKey: ["/api/profiles/lite"]');
    expect(src).toContain('queryKey: ["/api/profiles", "lite"]');
  });
});

describe("alert snoozes: hide the reminder, never move the record; one store for every device", () => {
  it("pure rules", () => {
    const today = "2026-10-09";
    expect(addDaysISO(today, 6)).toBe("2026-10-15");
    const m = mergeSnooze({ "bill-old": "2026-10-01" }, "bill-1", addDaysISO(today, 6), today);
    expect(m).toEqual({ "bill-1": "2026-10-15" }); // expired entry pruned, new one kept
    expect(isSnoozed(m, "bill-1", "2026-10-15")).toBe(true);
    expect(isSnoozed(m, "bill-1", "2026-10-16")).toBe(false);
    // Two devices: merging into the LATEST copy keeps the other device's snooze.
    expect(mergeSnooze({ "task-9": "2026-10-09" }, "bill-1", "2026-10-15", today)).toEqual({ "task-9": "2026-10-09", "bill-1": "2026-10-15" });
    expect(parseSnoozes("not json")).toEqual({});
    expect(activeSnoozes({ a: "2026-10-08", b: "2026-10-09" }, today)).toEqual({ b: "2026-10-09" });
  });

  it("the dashboard's bill snooze no longer PATCHes the obligation's due date, and dismissals are not per-browser", () => {
    const src = read("client/src/pages/dashboard.tsx");
    const body = src.slice(src.indexOf("const handleBillSnooze"), src.indexOf("const handleBillSnooze") + 900);
    expect(body).not.toMatch(/apiRequest\("PATCH", `\/api\/obligations/);
    expect(body).not.toContain("nextDueDate");
    expect(body).toContain("snooze(`bill-${billId}`, 7)");
    expect(src).not.toMatch(/localStorage\.setItem\(DISMISSED_LS_KEY/);
    expect(src).toContain("useAlertSnoozes()");
  });
});

describe("destructive buttons need a second tap", () => {
  it("bill, goal and budget deletes and the goal-complete circle go through useConfirmArm", () => {
    const src = read("client/src/pages/dashboard.tsx");
    for (const key of ["bill-del-", "goal-del-", "goal-done-", "budget-del-"]) {
      expect(src, key).toContain(`confirmArm.confirm(\`${key}`);
    }
    // No direct one-tap delete left on those buttons.
    expect(src).not.toMatch(/onClick=\{\(\) => deleteMutation\.mutate\(\{ id: (bill|editGoal)\.id/);
  });
});

describe("occurrence marks are applied server-side to the stored tags (no lost updates)", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  it("two surfaces marking different dates from the SAME stale copy both survive", async () => {
    h = await startHarness({ events: [{ id: "ev-1", title: "Water plants", date: "2026-09-01", recurrence: "weekly", allDay: true, category: "personal", tags: ["recurring-date"], linkedProfiles: [] }] });
    // Briefing checks off Oct 6; the calendar skips Oct 13 — neither has seen the other's write.
    const a = await h.api("POST", "/api/events/ev-1/occurrence", { date: "2026-10-06", state: "done" });
    const b = await h.api("POST", "/api/events/ev-1/occurrence", { date: "2026-10-13", state: "skip" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const meta = parseRecurringMeta(h.db.events[0].tags);
    expect(meta.completedDates).toContain("2026-10-06");
    expect(meta.skippedDates).toContain("2026-10-13");
    // Restore one: the other stays.
    await h.api("POST", "/api/events/ev-1/occurrence", { date: "2026-10-06", state: "clear" });
    const after = parseRecurringMeta(h.db.events[0].tags);
    expect(after.completedDates).not.toContain("2026-10-06");
    expect(after.skippedDates).toContain("2026-10-13");
  });

  it("pause/archive flip one flag on the stored tags", async () => {
    h = await startHarness({ events: [{ id: "ev-2", title: "Rent", date: "2026-01-01", recurrence: "monthly", allDay: true, category: "personal", tags: ["recurring-date"], linkedProfiles: [] }] });
    await h.api("POST", "/api/events/ev-2/occurrence", { date: "2026-10-01", state: "done" });
    await h.api("POST", "/api/events/ev-2/series-flag", { flag: "paused", on: true });
    const meta = parseRecurringMeta(h.db.events[0].tags);
    expect(meta.paused).toBe(true);
    expect(meta.completedDates).toContain("2026-10-01");
    expect((await h.api("POST", "/api/events/ev-2/occurrence", { date: "bad", state: "done" })).status).toBe(400);
  });

  it("no client surface rebuilds and PATCHes an event's whole tag list any more", () => {
    const offenders = clientSources()
      .filter(([, src]) => /markOccurrence\(|setSeriesFlag\(/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});

describe("editor drafts re-seed from the record", () => {
  it("LocationEditor uses useResyncedState, so a newer location is never saved over", () => {
    const src = read("client/src/pages/profile-detail.tsx");
    const body = src.slice(src.indexOf("function LocationEditor"), src.indexOf("function LocationEditor") + 800);
    expect(body).toContain("useResyncedState(String(profile.fields?.location");
  });
});

describe("valuation trend is measured, not invented from estimate noise", () => {
  const ctx = (history: Array<{ valuedAt: string; value: number }>) =>
    ({ history: history.map(h => ({ ...h, status: "valued" })) }) as any;

  it("two neighbouring estimates (the Honda: $20,600 → $22,500 in 17 days) imply NO trend", () => {
    expect(historyDrift(ctx([
      { valuedAt: "2026-09-19T21:40:03Z", value: 23800 },
      { valuedAt: "2026-09-22T22:27:37Z", value: 20600 },
      { valuedAt: "2026-10-09T18:57:47Z", value: 22500 },
    ]))).toBeNull();
  });

  it("a real six-month-plus history gives a plausible, clamped trend", () => {
    const d = historyDrift(ctx([
      { valuedAt: "2026-01-01T00:00:00Z", value: 26000 },
      { valuedAt: "2026-10-01T00:00:00Z", value: 22000 },
    ]))!;
    expect(d).toBeLessThan(0);
    expect(Math.abs(d)).toBeLessThanOrEqual(MAX_TREND_DRIFT);
  });
});

describe("server value reads go through the canonical resolver", () => {
  it("no inline currentValue fallback chains remain in the AI engine or the stale-valuation route", () => {
    const ai = read("server/ai-engine.ts");
    expect(ai).not.toMatch(/profile\.fields\?\.currentValue \|\| profile\.fields\?\.purchasePrice/);
    expect(ai).not.toMatch(/f\.currentValue \?\? f\.value \?\? f\.purchasePrice \?\? f\.balance/);
    expect(ai).not.toMatch(/p\.fields\?\.currentValue \|\| p\.fields\?\.value \|\| p\.fields\?\.balance/);
    expect(read("server/routes.ts")).not.toMatch(/Number\(f\.currentValue \|\| f\.purchasePrice \|\| 0\)/);
  });
});

describe("accounts are never estimated", () => {
  it("isValuableProfile: owned things yes, cash accounts no (their value is the balance)", async () => {
    const { isValuableProfile } = await import("../server/valuation/service");
    expect(isValuableProfile({ type: "vehicle", fields: {} })).toBe(true);
    expect(isValuableProfile({ type: "asset", fields: {} })).toBe(true);
    expect(isValuableProfile({ type: "account", fields: { accountKind: "savings", balance: 8500.25 } })).toBe(false);
    expect(isValuableProfile({ type: "account", fields: { accountKind: "checking", balance: 1285 } })).toBe(false);
  });
});

describe("deleting a profile never leaves records pointing at it", () => {
  it("a failed cascade keeps the profile instead of deleting it (no dangling owner ids)", () => {
    const src = read("server/supabase-storage.ts");
    const body = src.slice(src.indexOf("  async deleteProfile(id: string)"), src.indexOf("// Finally, delete the profile itself"));
    expect(body).toMatch(/if \(errors\.length > 0\) \{[\s\S]*?return false;\s*\}\s*$/);
  });
});
