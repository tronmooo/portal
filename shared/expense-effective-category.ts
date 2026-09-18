// The category an expense COUNTS under, as opposed to the one it was stored
// with. QA 2026-09-18 (F-17): two $912.40 car-loan payments were stored as
// "general" (their bill's "loan" category had no expense bucket at the time),
// so General was 63% of the month's spending chart and the anomaly engine
// raised "general spending up 543%". The rows already carry the join key the
// pay pipeline writes — a `liability:<id>` tag — so a payment logged against
// a debt, or against the bill that services one, renders as "debt" without a
// data migration. Pure; used by the finance snapshot and the anomaly engine.

import { canonicalExpenseCategory } from "./category-canon";
import { isPaymentBillOfListedDebt, isRecurringBillProfile } from "./liability-types";

export const DEBT_EXPENSE_CATEGORY = "debt";

/** The liability an expense was logged against (the pay pipeline's `liability:<id>` tag), or null. */
export function expenseLiabilityId(e: { tags?: readonly string[] | null } | null | undefined): string | null {
  for (const t of e?.tags || []) {
    if (typeof t === "string" && t.startsWith("liability:") && t.length > "liability:".length) return t.slice("liability:".length);
  }
  return null;
}

type Profileish = { id?: string; name?: string | null; type?: string | null; type_key?: string | null; typeKey?: string | null; fields?: any; deletedAt?: string | null; deleted_at?: string | null };

/**
 * Every liability id whose payments are debt payments: the loans and cards
 * themselves, plus the recurring bills that service one (by stored link or
 * by the "<loan> payment" name rule — shared/liability-types).
 */
export function debtPaymentLiabilityIds(profiles: readonly Profileish[] | null | undefined): Set<string> {
  const out = new Set<string>();
  const live = (profiles || []).filter((p) => p && p.id && !p.deletedAt && !p.deleted_at);
  for (const p of live) {
    if (p.type !== "liability" && p.type !== "loan") continue;
    if (!isRecurringBillProfile(p)) { out.add(String(p.id)); continue; }
    const linked = p.fields?.linkedLiabilityId;
    const linkedDebt = typeof linked === "string" && linked ? live.find((d) => d.id === linked) : undefined;
    if ((linkedDebt && (linkedDebt.type === "liability" || linkedDebt.type === "loan") && !isRecurringBillProfile(linkedDebt))
      || isPaymentBillOfListedDebt(p, live)) out.add(String(p.id));
  }
  return out;
}

/** The category this expense counts under: "debt" for a debt payment, else its canonical stored category. */
export function effectiveExpenseCategory(
  e: { category?: string | null; tags?: readonly string[] | null } | null | undefined,
  debtIds: ReadonlySet<string> | null | undefined,
): string {
  const liabilityId = expenseLiabilityId(e);
  if (liabilityId && debtIds?.has(liabilityId)) return DEBT_EXPENSE_CATEGORY;
  return canonicalExpenseCategory(e?.category);
}

/** The same rows with `category` replaced by the one they count under. */
export function withEffectiveCategories<T extends { category?: string | null; tags?: readonly string[] | null }>(
  expenses: readonly T[] | null | undefined,
  debtIds: ReadonlySet<string> | null | undefined,
): T[] {
  return (expenses || []).map((e) => {
    const liabilityId = expenseLiabilityId(e);
    if (!liabilityId || !debtIds?.has(liabilityId) || e?.category === DEBT_EXPENSE_CATEGORY) return e;
    return { ...e, category: DEBT_EXPENSE_CATEGORY };
  });
}
