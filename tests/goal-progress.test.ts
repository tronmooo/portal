// Audit 2026-07-29, finding U3: "A weight-loss goal claims 'Target reached'
// while the user is 21 lbs away."
//
// The audited goal read `170 / 160 lbs · 100% · 80d overdue · Target reached`
// while the linked Weight tracker's latest entry was 181 lbs. Every surface
// computed `current / target`, which only means anything when the number is
// supposed to go up; for weight loss it inverts, giving 106% — clamped to 100%
// and reported as success. The app congratulated the user for gaining weight.
//
// The same formula produced the Goals page's "0 Overdue" tile sitting directly
// above "OVERDUE — ACTION NEEDED (1)" (finding D2): a goal that computes
// >= 100% was counted as completed and skipped before the overdue check ran.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { goalProgress, goalStatus, goalDirection } from "../shared/goal-progress";

const WEIGHT_GOAL = {
  type: "weight_loss",
  startValue: 190,
  current: 181,   // the tracker's real latest weight
  target: 160,
  deadline: "2026-05-10",
  status: "active",
};

describe("goalDirection", () => {
  it("reads direction off the goal type that already encodes it", () => {
    expect(goalDirection("weight_loss")).toBe("decrease");
    expect(goalDirection("spending_limit")).toBe("cap");
    expect(goalDirection("weight_gain")).toBe("increase");
    expect(goalDirection("savings")).toBe("increase");
    expect(goalDirection("fitness_distance")).toBe("increase");
  });

  it("counts up for unknown or missing types rather than guessing", () => {
    expect(goalDirection("custom")).toBe("increase");
    expect(goalDirection(undefined)).toBe("increase");
  });
});

describe("goalProgress · decreasing targets (U3)", () => {
  it("measures ground covered, not the raw ratio", () => {
    // 190 → 160 is a 30 lb journey; at 181 the user has covered 9 lbs.
    const p = goalProgress(WEIGHT_GOAL);
    expect(p.percent).toBeCloseTo(30, 5);
    expect(p.direction).toBe("decrease");
  });

  it("does not call a goal complete while the user is above target", () => {
    expect(goalProgress(WEIGHT_GOAL).complete).toBe(false);
    // The audited card's own "current" of 170 was still 10 lbs above target
    // and was ALSO reported as reached.
    expect(goalProgress({ ...WEIGHT_GOAL, current: 170 }).complete).toBe(false);
  });

  it("never exceeds 100% — the old formula rendered 106%", () => {
    const old = (170 / 160) * 100;
    expect(Math.round(old)).toBe(106);
    expect(goalProgress({ ...WEIGHT_GOAL, current: 170 }).percent).toBeLessThanOrEqual(100);
  });

  it("completes when the target is actually met or beaten", () => {
    expect(goalProgress({ ...WEIGHT_GOAL, current: 160 }).complete).toBe(true);
    expect(goalProgress({ ...WEIGHT_GOAL, current: 155 }).complete).toBe(true);
    expect(goalProgress({ ...WEIGHT_GOAL, current: 155 }).percent).toBe(100);
  });

  it("reports 0% before any ground is covered", () => {
    expect(goalProgress({ ...WEIGHT_GOAL, current: 190 }).percent).toBe(0);
  });

  it("clamps rather than going negative when the user moves the wrong way", () => {
    const p = goalProgress({ ...WEIGHT_GOAL, current: 200 });
    expect(p.percent).toBe(0);
    expect(p.complete).toBe(false);
  });

  it("flags an unmeasurable goal instead of inventing a denominator", () => {
    // No startValue means there is no "distance to cover", so there is no
    // honest percentage — say so rather than render a made-up bar.
    const p = goalProgress({ type: "weight_loss", current: 181, target: 160 });
    expect(p.measurable).toBe(false);
    expect(p.complete).toBe(false);
    expect(p.percent).toBe(0);
  });
});

describe("goalProgress · increasing targets are unchanged", () => {
  it("keeps current/target for savings", () => {
    const p = goalProgress({ type: "savings", current: 2500, target: 10000 });
    expect(p.percent).toBe(25);
    expect(p.complete).toBe(false);
  });

  it("completes on reaching the target", () => {
    expect(goalProgress({ type: "savings", current: 10000, target: 10000 }).complete).toBe(true);
  });

  it("clamps an overshoot to 100%", () => {
    expect(goalProgress({ type: "savings", current: 12000, target: 10000 }).percent).toBe(100);
  });

  it("reports 0% for a goal with no target rather than dividing by zero", () => {
    const p = goalProgress({ type: "savings", current: 100, target: 0 });
    expect(p.percent).toBe(0);
    expect(p.measurable).toBe(false);
  });
});

describe("goalProgress · spending caps", () => {
  it("shows budget used but never celebrates blowing the cap", () => {
    const p = goalProgress({ type: "spending_limit", current: 450, target: 400 });
    expect(p.percent).toBe(100);      // fully consumed (clamped)
    expect(p.complete).toBe(false);   // exceeding a limit is not success
  });
});

describe("goalStatus", () => {
  const now = new Date("2026-07-29").getTime();

  it("never reports complete and overdue at once", () => {
    // The audited card managed "Target reached" AND "80d overdue" together.
    const s = goalStatus(WEIGHT_GOAL, now);
    expect(s).toBe("overdue");
    expect(s).not.toBe("complete");
  });

  it("prefers complete over overdue when the target was genuinely met", () => {
    expect(goalStatus({ ...WEIGHT_GOAL, current: 158 }, now)).toBe("complete");
  });

  it("honours an explicitly completed status", () => {
    expect(goalStatus({ ...WEIGHT_GOAL, status: "completed" }, now)).toBe("complete");
  });

  it("is active when in progress and not past deadline", () => {
    expect(goalStatus({ ...WEIGHT_GOAL, deadline: "2026-12-31" }, now)).toBe("active");
  });

  it("is active with no deadline at all", () => {
    expect(goalStatus({ ...WEIGHT_GOAL, deadline: undefined }, now)).toBe("active");
  });
});

describe("no surface recomputes the raw ratio", () => {
  // The formula lived in seven places. Any one of them reintroducing
  // `current / target` puts a weight-loss goal back above 100%, which is how
  // the Open Projects card came to show 106% while its own modal said 100%.
  const SURFACES = [
    "client/src/pages/goals.tsx",
    "client/src/pages/dashboard.tsx",
    "client/src/pages/trackers.tsx",
    "client/src/components/dashboard/ExecutiveBriefing.tsx",
    "client/src/components/dashboard/BriefingPopups.tsx",
    "server/insights-engine.ts",
  ];

  function code(rel: string): string {
    return fs.readFileSync(path.join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  for (const rel of SURFACES) {
    it(`${rel} uses goalProgress, not a hand-rolled ratio`, () => {
      const src = code(rel);
      expect(src, `${rel} must import goalProgress`).toMatch(/goalProgress/);
      expect(src, `${rel} still divides a goal current by its target`)
        .not.toMatch(/\bcurrent\s*(\?\?[^/]*)?\)?\s*\/\s*[\w.]*\btarget\b/);
    });
  }
});

describe("the Goals page counters can agree again (D2)", () => {
  // The tiles skipped anything computing >= 100% as "completed" before the
  // overdue branch, so the audited weight goal vanished from the overdue count
  // while the section below it still listed one overdue goal.
  it("counts an overdue weight goal as overdue, not completed", () => {
    const goals = [WEIGHT_GOAL];
    const now = new Date("2026-07-29").getTime();
    const overdue = goals.filter(g => goalStatus(g, now) === "overdue").length;
    const completed = goals.filter(g => goalStatus(g, now) === "complete").length;
    expect(overdue).toBe(1);
    expect(completed).toBe(0);
  });
});
