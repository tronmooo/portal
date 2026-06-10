/**
 * Money-shaped tracker-entry detection — the "trackers are never money" rule.
 *
 * User report (2026-06-10): "$400 car repairs for Ford F150" auto-created a
 * "Vehicle Maintenance" tracker instead of only logging an expense. Money
 * lives in /expenses (see shared/hidden-tracker-categories.ts); a tracker
 * must never be auto-created from a monetary value.
 *
 * Used by server/ai-engine.ts log_tracker_entry BEFORE auto-creating a
 * tracker. Pure + dependency-free so the contract test can pin it.
 */

const EXPENSE_NAME_RE = /(expense|spend|spending|cost|purchase|repair|maintenance|payment|bill|fee|charge|shopping|bought)/i;
const MONEY_KEYS = new Set([
  "cost", "price", "amount", "total", "paid", "spent", "fee", "charge", "expense", "dollars",
]);
const CURRENCY_IN_MESSAGE_RE = /\$\s?\d|\b\d+(?:\.\d{1,2})?\s*(?:dollars|bucks)\b/i;
const CURRENCY_AMOUNT_RE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/;

export interface ExpenseShapedResult {
  /** Positive dollar amount to log as an expense. */
  amount: number;
  /** Best human description, derived from values/notes/tracker name. */
  description: string;
  /** Expense category when inferable from repair/maintenance wording. */
  category?: "repair" | "maintenance";
  /** Profile hint (e.g. values.vehicle = "Ford F150 2025") for linking. */
  profileHint?: string;
  /** YYYY-MM-DD when the values carried an explicit date. */
  date?: string;
}

export type ExpenseShapedVerdict =
  | { kind: "divert"; expense: ExpenseShapedResult }
  | { kind: "refuse"; reason: string }
  | { kind: "allow" };

/**
 * Decide what to do with a tracker AUTO-CREATE request.
 *  - "divert": money detected — log an expense instead, never create the tracker.
 *  - "refuse": the name is spending-flavored but no usable amount was found —
 *    ask for the amount rather than creating an off-category tracker.
 *  - "allow": genuinely non-monetary — tracker auto-creation may proceed.
 */
export function classifyTrackerAutoCreate(
  trackerName: string,
  values: Record<string, unknown> | null | undefined,
  userMessage: string,
): ExpenseShapedVerdict {
  const name = String(trackerName || "");
  const msg = String(userMessage || "");
  const vals: Record<string, unknown> = values && typeof values === "object" ? values : {};

  const numericVals = Object.entries(vals).filter(
    ([k, v]) => k !== "_notes" && typeof v === "number" && isFinite(v as number) && (v as number) > 0,
  ) as Array<[string, number]>;
  const moneyKeyVal = numericVals.find(([k]) => MONEY_KEYS.has(k.toLowerCase()));
  const nameIsExpenseFlavored = EXPENSE_NAME_RE.test(name);
  const msgHasCurrency = CURRENCY_IN_MESSAGE_RE.test(msg);

  let amount: number | undefined;
  if (moneyKeyVal) {
    amount = moneyKeyVal[1];
  } else if (nameIsExpenseFlavored && msgHasCurrency) {
    const m = msg.match(CURRENCY_AMOUNT_RE);
    if (m) amount = parseFloat(m[1].replace(/,/g, ""));
    if (!amount && numericVals.length === 1) amount = numericVals[0][1];
  }

  if (amount && amount > 0 && (moneyKeyVal || nameIsExpenseFlavored)) {
    const descCandidates = [vals.description, vals._notes, name].filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
    const profileHint = [vals.vehicle, vals.for, vals.profile, vals.asset].find(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
    const combined = `${name} ${descCandidates.join(" ")}`.toLowerCase();
    const category = /repair/.test(combined) ? "repair" as const
      : /mainten/.test(combined) ? "maintenance" as const
      : undefined;
    const date = typeof vals.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(vals.date)
      ? vals.date.slice(0, 10)
      : undefined;
    return {
      kind: "divert",
      expense: { amount, description: descCandidates[0] || name, category, profileHint, date },
    };
  }

  if (nameIsExpenseFlavored) {
    return {
      kind: "refuse",
      reason: `"${name}" looks like spending, and money is tracked as expenses, not trackers. Tell me the amount (e.g. "spent $120 on ${name.toLowerCase()}") and I'll log it as an expense on the right profile.`,
    };
  }

  return { kind: "allow" };
}
