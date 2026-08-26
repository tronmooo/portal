// shared/period-deadlines.ts — a stated PERIOD is a date you have not been told.
// =============================================================================
//
// USER REPORT (2026-08-26): "The 90-day return policy should be a suggested
// action, it should be in the calendar, and it should be an expiration date —
// I want to know in 90 days that I can still return my radio."
//
// A receipt printed "90-DAY RETURN POLICY". Extraction read it correctly as
// `returnPolicyDays: 90` and then filed it as ordinary profile data, because 90
// is a number, not a date. But a period plus the day it starts from IS a date:
// bought 2026-05-20, returnable until 2026-08-18. The document never prints
// that date, which is exactly why the app should compute it — it is the only
// thing about the return policy anyone ever acts on.
//
// This module is deliberately about the SHAPE of the data, never about
// receipts: "a quantity of time + a window word + an anchor date" describes a
// return window, a warranty, a lease notice period, a grace period, a
// redemption deadline, a trial and a cancellation notice equally well. A new
// kind of document gets this for free.
//
// Pure and deterministic. Pinned by tests/period-deadlines.test.ts.

import { addDays } from "./timezone";
import { bareDateOf } from "./date-rules";

/** Days in one unit. Months and years are the calendar-average approximations
 *  a return window or a warranty is understood in; nothing here needs
 *  day-exact month arithmetic, and pretending otherwise invites off-by-one. */
const UNIT_DAYS: Record<string, number> = {
  day: 1, week: 7, month: 30, year: 365,
};

/** The unit words a field can carry, longest first so "monthly" cannot match "month". */
const UNIT_RE = /\b(day|days|week|weeks|month|months|year|years)\b/i;

/**
 * What makes a period ACTIONABLE rather than trivia.
 *
 * A semantic vocabulary, not a document-type table: every word here names a
 * window that ends, in any document that happens to state one. Without this
 * guard a "days since last service" reading would sprout a deadline.
 */
const WINDOW_RE = new RegExp([
  "return", "refund", "exchange", "warrant", "guarantee", "grace",
  "term", "period", "policy", "coverage", "valid", "expir", "redeem",
  "trial", "notice", "cancel", "renew", "due", "deadline", "window",
].join("|"), "i");

/** How the deadline should read once computed. */
const DEADLINE_LABEL: Array<{ match: RegExp; label: string }> = [
  { match: /return|refund|exchange/i, label: "Return deadline" },
  { match: /warrant|guarantee/i, label: "Warranty expires" },
  { match: /trial/i, label: "Trial ends" },
  { match: /grace/i, label: "Grace period ends" },
  { match: /cancel|notice/i, label: "Cancellation deadline" },
  { match: /renew/i, label: "Renewal due" },
];

export interface ParsedPeriod {
  /** The number the document stated. */
  amount: number;
  /** "day" | "week" | "month" | "year". */
  unit: string;
  /** The period expressed in days — what gets added to the anchor. */
  days: number;
}

/**
 * Read a period off one field.
 *
 * Handles both spellings a document uses: the unit in the KEY with a bare
 * number for a value (`returnPolicyDays: 90`) and the unit in the VALUE
 * (`returnPolicy: "90 days"`).
 */
export function parsePeriod(
  key: string | undefined,
  label: string | undefined,
  value: unknown,
): ParsedPeriod | null {
  const keyText = `${key ?? ""} ${label ?? ""}`;
  const valueText = value === null || value === undefined ? "" : String(value).trim();
  if (!WINDOW_RE.test(keyText) && !WINDOW_RE.test(valueText)) return null;

  // A real date is already a date — never re-read it as a quantity.
  if (bareDateOf(valueText)) return null;

  let amount: number | null = null;
  let unit: string | null = null;

  // Unit in the value: "90 days", "12 months".
  const inValue = valueText.match(/(-?\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years)\b/i);
  if (inValue) {
    amount = Number(inValue[1]);
    unit = inValue[2].toLowerCase().replace(/s$/, "");
  } else {
    // Unit in the key, bare number in the value.
    const inKey = keyText.match(UNIT_RE);
    const num = Number(valueText.replace(/[,\s]/g, ""));
    if (inKey && isFinite(num) && valueText !== "") {
      amount = num;
      unit = inKey[1].toLowerCase().replace(/s$/, "");
    }
  }

  if (amount === null || !unit || !isFinite(amount)) return null;
  // A window is a positive stretch of future time, and a decade of it is a
  // parse failure rather than a policy.
  if (amount <= 0 || amount > 3650) return null;
  const days = Math.round(amount * (UNIT_DAYS[unit] ?? 0));
  if (days <= 0) return null;
  return { amount, unit, days };
}

/** What to call the computed date. Falls back to the field's own name. */
export function deadlineLabelFor(key: string | undefined, label: string | undefined): string {
  const text = `${key ?? ""} ${label ?? ""}`;
  for (const entry of DEADLINE_LABEL) {
    if (entry.match.test(text)) return entry.label;
  }
  return "Deadline";
}

/**
 * The day a period counts from.
 *
 * The transaction the document records — a purchase, a sale, an issue, a
 * service — not the day the file happened to be uploaded. Rows are searched in
 * the order the anchors are listed, so a purchase date beats a generic "date".
 */
const ANCHOR_KEYS: RegExp[] = [
  /transaction.*date|date.*transaction/i,
  /purchase.*date|date.*purchase/i,
  /sale.*date|order.*date|invoice.*date|receipt.*date/i,
  /service.*date|issue.*date|issued/i,
  /effective.*date|start.*date/i,
  /\bdate\b/i,
];

export interface PeriodRow {
  id: string;
  key: string;
  label: string;
  value: unknown;
  date?: string;
}

/** The anchor date these rows imply, or null when the document states none. */
export function findAnchorDate(rows: readonly PeriodRow[] | undefined | null): string | null {
  const candidates = (rows || []).filter((r) => r && (bareDateOf(r.date) || bareDateOf(r.value)));
  for (const pattern of ANCHOR_KEYS) {
    for (const row of candidates) {
      if (pattern.test(`${row.key ?? ""} ${row.label ?? ""}`)) {
        return bareDateOf(row.date) || bareDateOf(row.value);
      }
    }
  }
  return null;
}

export interface DerivedDeadline {
  /** The row that stated the period. */
  rowId: string;
  rowKey: string;
  /** The computed calendar day the window closes. */
  date: string;
  /** The day it counted from. */
  anchorDate: string;
  period: ParsedPeriod;
  /** "Return deadline". */
  label: string;
  /** "90 days from 2026-05-20" — shown so the arithmetic is never a mystery. */
  detail: string;
}

/**
 * Every deadline these rows imply.
 *
 * Returns nothing when the document states no anchor date: a 90-day window
 * with no start is genuinely not a date, and inventing one from today would
 * quietly put a wrong deadline on someone's calendar.
 */
export function derivePeriodDeadlines(
  rows: readonly PeriodRow[] | undefined | null,
  opts: { anchorDate?: string | null } = {},
): DerivedDeadline[] {
  const anchor = opts.anchorDate ? bareDateOf(opts.anchorDate) : findAnchorDate(rows);
  if (!anchor) return [];
  const out: DerivedDeadline[] = [];
  const seen = new Set<string>();
  for (const row of rows || []) {
    if (!row?.id) continue;
    const period = parsePeriod(row.key, row.label, row.value);
    if (!period) continue;
    const date = addDays(anchor, period.days);
    if (!date) continue;
    const label = deadlineLabelFor(row.key, row.label);
    // One deadline per label per day — a document repeating its return policy
    // in the header and the footer states one deadline.
    const dedupe = `${label}:${date}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      rowId: row.id,
      rowKey: row.key,
      date,
      anchorDate: anchor,
      period,
      label,
      detail: `${period.amount} ${period.unit}${period.amount === 1 ? "" : "s"} from ${anchor}`,
    });
  }
  return out;
}
