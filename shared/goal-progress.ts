// shared/goal-progress.ts — Direction-aware goal progress.
//
// Every surface computed progress as `current / target`, which is only correct
// when the number is supposed to go UP. For a weight-loss goal it inverts the
// meaning: 170 lbs against a 160 lb target reads as 106%, and clamping that to
// 100% produced a goal card that said "100% · Target reached" while the user
// was 10 lbs above target and the linked tracker's latest weight was 181 lbs.
// The app was congratulating someone for gaining weight (audit finding U3).
//
// The same formula also broke the Goals page counters (audit finding D2): the
// summary treated `pct >= 100` as completed and skipped it before the overdue
// check, so the tiles reported "0 Overdue" directly above a section headed
// "OVERDUE — ACTION NEEDED (1)".
//
// Direction is already in the data — `Goal.type` distinguishes weight_loss
// from weight_gain — so nothing new needs storing to get this right.
//
// Pure and dependency-free: client cards, page summaries and server insights
// all import this rather than reimplementing the ratio.

/**
 * Which way "better" points for a goal.
 *
 *  - `increase` — savings, distance, streaks. Progress is current/target.
 *  - `decrease` — weight loss. Progress is ground covered from the starting
 *    value toward the target.
 *  - `cap`      — a spending limit. `current` is consumption against a ceiling,
 *    so the percentage is "how much of the budget is used". Exceeding a cap is
 *    not an achievement, so a cap never reports complete.
 */
export type GoalDirection = "increase" | "decrease" | "cap";

const DECREASE_TYPES = new Set(["weight_loss"]);
const CAP_TYPES = new Set(["spending_limit"]);

/** The direction implied by a goal's type. Unknown types count up. */
export function goalDirection(type: string | null | undefined): GoalDirection {
  const t = String(type || "").toLowerCase();
  if (DECREASE_TYPES.has(t)) return "decrease";
  if (CAP_TYPES.has(t)) return "cap";
  return "increase";
}

/** The minimum a goal must carry for progress to be computable. */
export interface GoalLike {
  type?: string | null;
  target?: number | string | null;
  current?: number | string | null;
  startValue?: number | string | null;
}

export interface GoalProgress {
  /** 0–100, clamped. Safe to render directly. */
  percent: number;
  /** True only when the target is genuinely met, direction considered. */
  complete: boolean;
  direction: GoalDirection;
  /**
   * False when the percentage is a placeholder rather than a measurement —
   * a decrease goal with no usable starting value has no denominator, so
   * there is no honest "42% of the way there". Callers should show the
   * raw current → target values instead of a fabricated bar.
   */
  measurable: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Progress toward a goal, honouring its direction.
 *
 * Decreasing goals measure ground covered: `(start − current) / (start −
 * target)`. A goal to go 190 → 160 that currently reads 181 is 30% of the way,
 * not 113%.
 */
export function goalProgress(goal: GoalLike | null | undefined): GoalProgress {
  const direction = goalDirection(goal?.type);
  const target = num(goal?.target);
  const current = num(goal?.current);
  const start = num(goal?.startValue);

  if (direction === "decrease") {
    const complete = target > 0 && current > 0 && current <= target;
    // The span only exists when the user genuinely started above the target.
    const span = start - target;
    if (!(span > 0)) {
      // No denominator: report the honest binary rather than inventing a ratio.
      return { percent: complete ? 100 : 0, complete, direction, measurable: false };
    }
    return {
      percent: clampPct(((start - current) / span) * 100),
      complete,
      direction,
      measurable: true,
    };
  }

  if (direction === "cap") {
    // Usage against a ceiling. Blowing a budget is not an achievement, so a
    // cap never reports complete — it would have rendered a breached spending
    // limit as "100% · Target reached 🎉".
    return {
      percent: target > 0 ? clampPct((current / target) * 100) : 0,
      complete: false,
      direction,
      measurable: target > 0,
    };
  }

  return {
    percent: target > 0 ? clampPct((current / target) * 100) : 0,
    complete: target > 0 && current >= target,
    direction,
    measurable: target > 0,
  };
}

/**
 * The status a goal card should display.
 *
 * A goal cannot be both finished and late. The audited weight goal rendered
 * "100%", "Target reached" and "80d overdue" simultaneously; completion is
 * checked first here so that combination is unrepresentable.
 */
export type GoalStatus = "complete" | "overdue" | "active";

export function goalStatus(
  goal: GoalLike & { status?: string | null; deadline?: string | null },
  now: number = Date.now(),
): GoalStatus {
  const declared = String(goal?.status || "").toLowerCase();
  if (declared === "completed") return "complete";
  if (goalProgress(goal).complete) return "complete";
  if (goal?.deadline) {
    const ms = new Date(goal.deadline).getTime();
    if (Number.isFinite(ms) && ms < now) return "overdue";
  }
  return "active";
}
