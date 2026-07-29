// Pure POST-payload builders for the dashboard quick-add dialogs.
//
// Extracted so the exact request body for each "add from the dashboard" action
// (expense, income, bill/obligation, note, reminder) is unit-testable and
// identical to what the existing page-level forms send (finance.tsx,
// journal.tsx, profile-detail.tsx). The dialogs are thin shells around these.
//
// Each builder returns a discriminated result: { ok: true, body } when the
// input is valid, or { ok: false, error } with a human message the dialog can
// surface. Owner-profile defaulting (active filter → single selected profile,
// else self) is handled by the caller passing `ownerProfileId`.

import { MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE } from "./schema";

export type BuildResult =
  | { ok: true; body: Record<string, any> }
  | { ok: false; error: string };

/**
 * Strip currency formatting and parse. Returns NaN on empty/garbage.
 *
 * Exponent notation is preserved. The old regex dropped every character
 * outside `[0-9.-]`, which quietly turned the QA report's `1e10` into the
 * string "110" — so the dialog would have saved $110 for an input the user
 * could reasonably read as ten billion, and either number is a wrong answer
 * given silently. `1e10` now parses to 1e10 and is REJECTED by the amount
 * ceiling, which is the honest outcome: the app says no rather than picking a
 * number the user did not type.
 */
export function parseAmount(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return raw;
  if (raw == null) return NaN;
  return parseFloat(String(raw).replace(/[^0-9.eE+\-]/g, ""));
}

/**
 * The single amount check every quick-add builder runs. Returns an error
 * message, or null when the amount is a plausible transaction.
 *
 * `allowZero` is for obligations, whose schema accepts 0 (a placeholder bill).
 *
 * The upper bound is the point of this helper. Before it, `1e10` parsed to a
 * finite positive number, passed every guard, and became a -$10,000,000,000
 * line in Cash Flow (QA 2026-07-29 EDGE-001). Rejecting at the builder means
 * the dialog says so inline, without a round trip — and the identical bound in
 * `shared/schema.ts` means a direct API caller gets the same answer.
 */
export function validateTransactionAmount(
  amount: number,
  { allowZero = false }: { allowZero?: boolean } = {},
): string | null {
  if (!isFinite(amount)) return "Amount must be a positive number";
  if (allowZero ? amount < 0 : amount <= 0) {
    return allowZero ? "Amount must be 0 or a positive number" : "Amount must be a positive number";
  }
  if (amount > MAX_TRANSACTION_AMOUNT) return TRANSACTION_TOO_LARGE_MESSAGE;
  return null;
}

function linkedProfiles(ownerProfileId?: string): Record<string, any> {
  return ownerProfileId ? { linkedProfiles: [ownerProfileId] } : {};
}

export interface ExpenseInput {
  description: string;
  amount: string | number;
  category?: string;
  vendor?: string;
  date?: string;
}

export function buildExpensePayload(input: ExpenseInput, ownerProfileId?: string): BuildResult {
  const description = (input.description || "").trim();
  if (!description) return { ok: false, error: "Description is required" };
  const amount = parseAmount(input.amount);
  const amountError = validateTransactionAmount(amount);
  if (amountError) return { ok: false, error: amountError };
  return {
    ok: true,
    body: {
      description,
      amount,
      category: input.category || "general",
      ...(input.vendor && input.vendor.trim() ? { vendor: input.vendor.trim() } : {}),
      ...(input.date ? { date: input.date } : {}),
      tags: [],
      ...linkedProfiles(ownerProfileId),
    },
  };
}

export interface IncomeInput {
  description: string;
  amount: string | number;
  category?: string;
  frequency?: string;
  date?: string;
}

export function buildIncomePayload(input: IncomeInput, ownerProfileId?: string): BuildResult {
  const description = (input.description || "").trim();
  if (!description) return { ok: false, error: "Description is required" };
  const amount = parseAmount(input.amount);
  const amountError = validateTransactionAmount(amount);
  if (amountError) return { ok: false, error: amountError };
  return {
    ok: true,
    body: {
      description,
      amount,
      category: input.category || "salary",
      frequency: input.frequency || "monthly",
      ...(input.date ? { date: input.date } : {}),
      tags: [],
      ...linkedProfiles(ownerProfileId),
    },
  };
}

export interface BillInput {
  name: string;
  amount: string | number;
  frequency?: string;
  category?: string;
  nextDueDate?: string;
  autopay?: boolean;
}

export function buildBillPayload(input: BillInput, ownerProfileId?: string): BuildResult {
  const name = (input.name || "").trim();
  if (!name) return { ok: false, error: "Name is required" };
  const amount = parseAmount(input.amount);
  const amountError = validateTransactionAmount(amount);
  if (amountError) return { ok: false, error: amountError };
  return {
    ok: true,
    body: {
      name,
      amount,
      frequency: input.frequency || "monthly",
      category: input.category || "bill",
      ...(input.nextDueDate ? { nextDueDate: input.nextDueDate } : {}),
      autopay: !!input.autopay,
      ...linkedProfiles(ownerProfileId),
    },
  };
}

export interface NoteInput {
  content: string;
  date?: string;
  mood?: string;
}

export function buildNotePayload(input: NoteInput, ownerProfileId?: string): BuildResult {
  const content = (input.content || "").trim();
  if (!content) return { ok: false, error: "Note can't be empty" };
  return {
    ok: true,
    body: {
      content,
      // /api/journal requires a mood (insertJournalEntrySchema); default to
      // "neutral" for a plain note so the quick-add doesn't 400.
      mood: input.mood || "neutral",
      ...(input.date ? { date: input.date } : {}),
      tags: [],
      ...linkedProfiles(ownerProfileId),
    },
  };
}

export interface ReminderInput {
  title: string;
  fireAt?: string; // ISO datetime or date
}

export function buildReminderPayload(input: ReminderInput, ownerProfileId?: string): BuildResult {
  const title = (input.title || "").trim();
  if (!title) return { ok: false, error: "Title is required" };
  return {
    ok: true,
    body: {
      title,
      ...(input.fireAt ? { fireAt: input.fireAt } : {}),
      ...(ownerProfileId ? { profileId: ownerProfileId } : {}),
    },
  };
}
