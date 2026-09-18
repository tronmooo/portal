// Pure POST-payload builders for the dashboard quick-add dialogs.
//
// Extracted so the exact request body for each "add from the dashboard" action
// (expense, income, bill/obligation, note, timed task) is unit-testable and
// identical to what the existing page-level forms send (finance.tsx,
// journal.tsx, profile-detail.tsx). The dialogs are thin shells around these.
//
// Each builder returns a discriminated result: { ok: true, body } when the
// input is valid, or { ok: false, error } with a human message the dialog can
// surface. Owner-profile defaulting (active filter → single selected profile,
// else self) is handled by the caller passing `ownerProfileId`.

import { MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE, isWholeCents, SUB_CENT_AMOUNT_MESSAGE } from "./schema";
import { normalizeClockTime } from "./timezone";

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
  if (!isWholeCents(amount)) return SUB_CENT_AMOUNT_MESSAGE;
  return null;
}

export { isWholeCents, SUB_CENT_AMOUNT_MESSAGE, toCents } from "./schema";

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

/**
 * The quick-add "remind me" tile builds a TIMED TASK.
 *
 * Reminders were retired on 2026-08-09 — Portol has EVENTS and TASKS, and a
 * task carries its own clock time — so the tile keeps its familiar bell while
 * writing the entity that is actually visible on the calendar and can be
 * checked off. `at` (an ISO datetime, which is what the datetime-local input
 * produces) is split into the task's due date and its due time.
 */
export interface TimedTaskInput {
  title: string;
  at?: string; // ISO datetime or date
}

export function buildTimedTaskPayload(input: TimedTaskInput, ownerProfileId?: string): BuildResult {
  const title = (input.title || "").trim();
  if (!title) return { ok: false, error: "Title is required" };
  const raw = String(input.at || "").trim();
  const dueDate = raw.slice(0, 10);
  const dueTime = normalizeClockTime(raw);
  return {
    ok: true,
    body: {
      title,
      priority: "medium",
      ...(/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? { dueDate } : {}),
      ...(dueTime ? { dueTime } : {}),
      ...linkedProfiles(ownerProfileId),
    },
  };
}

// ── Natural-language due date in a quick-add title ──────────────────────────
//
// QA 2026-09-18 BUG-21: "Renew passport before December" typed into the
// Tasks "I want to…" box saved a task with NO due date, which the popup then
// filed under Today's priorities. The trailing time phrase is now read:
//
//   "… before December"     → the day before Dec 1 (Nov 30) of the upcoming December
//   "… by December"         → Dec 1
//   "… before Dec 1"        → Nov 30
//   "… by Dec 15" / "on Dec 15" / "due Dec 15" → Dec 15
//   "… tomorrow" / "today" / "next Friday" / "on Friday" / "in 3 days" / "in 2 weeks"
//
// The phrase is stripped from the title ("Renew passport"). A month with no
// year means the NEXT occurrence: on Sep 18, "December" is this December and
// "March" is next March. Anything not recognised leaves the title untouched
// and the task undated — an undated task is then shown as Unscheduled, never
// as due today (see TaskHabitPopups).

export interface ParsedQuickTask {
  title: string;
  /** YYYY-MM-DD when a due phrase was recognised. */
  dueDate?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");

const isoOf = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const shiftISO = (iso: string, days: number): string => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days, 12);
  return isoOf(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
};
const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate();

function cleanTitle(raw: string, matchStart: number, fallback: string): string {
  const t = raw.slice(0, matchStart).replace(/[\s,;:\-–—]+$/, "").trim();
  return t || fallback;
}

export function parseQuickTaskText(text: string, todayISO: string): ParsedQuickTask {
  const raw = String(text || "").trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(String(todayISO || ""))) return { title: raw };
  const [ty, tm, td] = todayISO.split("-").map(Number);
  const todayDow = new Date(ty, tm - 1, td, 12).getDay();

  // 1. "<prep> <Month> [day][, year]" — the QA case.
  const monthRe = new RegExp(
    `\\b(before|by|until|till|due|on|for)\\s+(?:the\\s+)?(?:end\\s+of\\s+)?(${MONTH_RE})\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?\\s*[.!]?\\s*$`, "i");
  const mm = monthRe.exec(raw);
  if (mm) {
    const prep = mm[1].toLowerCase();
    const month = MONTHS[mm[2].toLowerCase()];
    const day = mm[3] ? Number(mm[3]) : null;
    let year = mm[4] ? Number(mm[4]) : ty;
    if (day != null && (day < 1 || day > 31)) return { title: raw };
    // "end of December" → the month's last day; a bare month → its 1st.
    const endOf = /end\s+of/i.test(mm[0]);
    let dom = day ?? (endOf ? daysInMonth(year, month) : 1);
    let iso = isoOf(year, month, Math.min(dom, daysInMonth(year, month)));
    // No year given and the date has passed → the next occurrence.
    if (!mm[4] && iso < todayISO) {
      year += 1;
      dom = day ?? (endOf ? daysInMonth(year, month) : 1);
      iso = isoOf(year, month, Math.min(dom, daysInMonth(year, month)));
    }
    if (prep === "before") iso = shiftISO(iso, -1);
    return { title: cleanTitle(raw, mm.index, raw), dueDate: iso };
  }

  // 2. "today" / "tomorrow" / "in N days|weeks" / "next week".
  const relRe = /\b(?:(?:due|by|on|for)\s+)?(today|tonight|tomorrow|next\s+week|in\s+(\d+)\s+(day|days|week|weeks))\s*[.!]?\s*$/i;
  const rm = relRe.exec(raw);
  if (rm) {
    const word = rm[1].toLowerCase();
    let iso = todayISO;
    if (word === "tomorrow") iso = shiftISO(todayISO, 1);
    else if (word === "next week") iso = shiftISO(todayISO, 7);
    else if (rm[2]) iso = shiftISO(todayISO, Number(rm[2]) * (/week/i.test(rm[3]) ? 7 : 1));
    return { title: cleanTitle(raw, rm.index, raw), dueDate: iso };
  }

  // 3. "[next|this|on|by|before] <weekday>".
  const dowRe = new RegExp(`\\b(?:(before|by|on|due|for|next|this)\\s+)?(${WEEKDAY_RE})\\s*[.!]?\\s*$`, "i");
  const dm = dowRe.exec(raw);
  if (dm) {
    const prep = (dm[1] || "").toLowerCase();
    const target = WEEKDAYS[dm[2].toLowerCase()];
    let ahead = (target - todayDow + 7) % 7;
    if (ahead === 0 && prep === "next") ahead = 7;
    let iso = shiftISO(todayISO, ahead);
    if (prep === "before") iso = shiftISO(iso, -1);
    return { title: cleanTitle(raw, dm.index, raw), dueDate: iso };
  }

  return { title: raw };
}

/**
 * The money-carrying profile fields (asset values, balances, limits,
 * payments). A record's net worth, cash flow and payoff math read these as
 * numbers, so a value the number model cannot hold must not be stored: a
 * loan balance of "eight thousand" used to save and silently drop the loan
 * from net worth; an asset "worth" 1e12 used to save and swamp it.
 *
 * Returns an error message, or null after normalising each present value in
 * place ("$14,500" → 14500). Balances may be negative (an overdrawn account,
 * a credit); values, limits and payments may not.
 */
export const PROFILE_MONEY_FIELDS = [
  "estimatedValue", "currentValue", "marketValue", "value", "purchasePrice", "originalAmount", "principal",
  "balance", "currentBalance", "availableBalance", "creditLimit", "monthlyPayment", "monthlyAmount", "amount", "cost",
] as const;
const NEGATIVE_OK = new Set(["balance", "currentBalance", "availableBalance"]);

export function validateProfileMoneyFields(fields: Record<string, any> | null | undefined): string | null {
  if (!fields || typeof fields !== "object") return null;
  for (const key of PROFILE_MONEY_FIELDS) {
    const raw = fields[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[$,\s]/g, "")) : NaN;
    if (!Number.isFinite(n)) return `${key} must be a number`;
    if (n < 0 && !NEGATIVE_OK.has(key)) return `${key} cannot be negative`;
    if (Math.abs(n) > MAX_TRANSACTION_AMOUNT) return `${key} is too large (maximum ${MAX_TRANSACTION_AMOUNT.toLocaleString("en-US")})`;
    fields[key] = n;
  }
  return null;
}
