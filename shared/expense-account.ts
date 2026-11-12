// The account an expense was "Paid from", and what deleting the expense owes it.
//
// Finance → Add Expense with "Paid from" links the expense to the account and
// moves the account's balance down by the amount; editing moves it back and
// forth. Deleting must return it, or the spend disappears from every total
// while the balance stays lower (2026-11-12).
//
// A bill-payment expense (tag `payment:<id>` / `bill-payment`) is NOT refunded
// here: the server reverses the payment — ledger row, paid stamp and the
// paying account — when that expense is deleted (retractPaymentOfExpense).
export interface ExpenseRefund {
  accountId: string;
  amount: number;
}

export function expenseRefund(
  expense: { amount?: unknown; linkedProfiles?: unknown; tags?: unknown } | null | undefined,
  accountIds: ReadonlySet<string>,
): ExpenseRefund | null {
  if (!expense) return null;
  const tags = Array.isArray(expense.tags) ? expense.tags : [];
  if (tags.some((t) => typeof t === "string" && (t === "bill-payment" || t.startsWith("payment:")))) return null;
  const linked = Array.isArray(expense.linkedProfiles) ? expense.linkedProfiles : [];
  const accountId = linked.find((id): id is string => typeof id === "string" && accountIds.has(id));
  if (!accountId) return null;
  const amount = Number(expense.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { accountId, amount };
}
