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

export type BuildResult =
  | { ok: true; body: Record<string, any> }
  | { ok: false; error: string };

/** Strip currency formatting and parse. Returns NaN on empty/garbage. */
export function parseAmount(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return raw;
  if (raw == null) return NaN;
  return parseFloat(String(raw).replace(/[^0-9.\-]/g, ""));
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
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: "Amount must be a positive number" };
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
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: "Amount must be a positive number" };
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
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: "Amount must be a positive number" };
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
}

export function buildNotePayload(input: NoteInput, ownerProfileId?: string): BuildResult {
  const content = (input.content || "").trim();
  if (!content) return { ok: false, error: "Note can't be empty" };
  return {
    ok: true,
    body: {
      content,
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
