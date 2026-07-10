// ── Medication dose ledger unit tests (server/medication-doses.ts) ───────────
import { describe, it, expect } from "vitest";
import { resolveMedicationTracker, computeMissedDoses, doseHistory } from "../server/medication-doses";

const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function medTracker(overrides: Record<string, any> = {}): any {
  return {
    id: "tr1",
    name: "Lisinopril (twice daily)",
    category: "medication",
    fields: [{ name: "adherence", type: "select" }],
    entries: [],
    linkedProfiles: [],
    createdAt: daysAgo(30),
    ...overrides,
  };
}

const entry = (ago: number, adherence: string, extra: Record<string, any> = {}) => ({
  id: `e${ago}-${adherence}`,
  timestamp: daysAgo(ago),
  values: { adherence, ...extra },
  computed: {},
});

describe("resolveMedicationTracker", () => {
  it("errors with the tracker list when the name is ambiguous", () => {
    const meds = [medTracker(), medTracker({ id: "tr2", name: "Metformin" })];
    const res = resolveMedicationTracker(meds, undefined);
    expect(res.error).toMatch(/Which medication/);
    expect(res.error).toMatch(/Lisinopril.*Metformin/);
  });

  it("uses the only medication when none is named", () => {
    expect(resolveMedicationTracker([medTracker()], undefined).tracker?.id).toBe("tr1");
  });

  it("matches by partial name and ignores non-medication trackers", () => {
    const trackers = [
      { id: "w1", name: "Weight", category: "fitness", fields: [], entries: [], createdAt: daysAgo(10) } as any,
      medTracker(),
    ];
    expect(resolveMedicationTracker(trackers, "lisinopril").tracker?.id).toBe("tr1");
    expect(resolveMedicationTracker(trackers, "weight").error).toMatch(/No medication tracker matches/);
  });

  it("errors honestly with no medication trackers at all", () => {
    expect(resolveMedicationTracker([], undefined).error).toMatch(/No medication trackers/);
  });
});

describe("computeMissedDoses", () => {
  it("expects doses_per_day × window from the frequency in the name", () => {
    const t = medTracker({
      entries: [entry(0.2, "taken"), entry(0.7, "taken"), entry(1.2, "skipped"), entry(2.2, "missed")],
    });
    const res = computeMissedDoses(t, { days: 7 });
    expect(res.doses_per_day).toBe(2);
    expect(res.expected).toBe(14);
    expect(res.taken).toBe(2);
    expect(res.skipped).toBe(1);
    expect(res.explicit_missed).toBe(1);
    expect(res.unlogged_gap).toBe(10);
    expect(res.message).toMatch(/2\/14/);
  });

  it("clamps the expectation to the tracker's age", () => {
    const t = medTracker({ createdAt: daysAgo(2) }); // exists 2 days, asked for 7
    const res = computeMissedDoses(t, { days: 7 });
    expect(res.expected).toBeLessThanOrEqual(4); // 2 days × twice daily
  });

  it("reports gaps distinctly from confirmed misses", () => {
    const t = medTracker({ name: "Aspirin daily", entries: [] });
    const res = computeMissedDoses(t, { days: 3 });
    expect(res.explicit_missed).toBe(0);
    expect(res.unlogged_gap).toBeGreaterThan(0);
    expect(res.message).toMatch(/gap, not confirmed missed/);
  });
});

describe("doseHistory", () => {
  it("lists recent entries newest-first with adherence + side effects", () => {
    const t = medTracker({
      entries: [
        entry(5, "taken", { dosage: "10mg", timeTaken: "8am" }),
        entry(1, "skipped", { sideEffects: "nausea" }),
        entry(40, "taken"), // outside the 14-day default window
      ],
    });
    const res = doseHistory(t);
    expect(res.count).toBe(2);
    expect(res.doses[0].adherence).toBe("skipped");
    expect(res.doses[0].side_effects).toBe("nausea");
    expect(res.doses[1].dosage).toBe("10mg");
  });
});
