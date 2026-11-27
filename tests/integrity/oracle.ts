// Independent expected-value calculations for the integrity run.
//
// This file must NOT import anything from shared/, server/ or client/: an
// expectation computed by the code under test proves only that the code agrees
// with itself. Each function here is the plain arithmetic of the rule as the
// owner states it in CLAUDE.md, written a second time.
// Guard: tests/integrity-model.test.ts ("the oracle imports nothing from the app").

export const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── calendar days (strings, no time zones) ──────────────────────────────────
export interface Ymd { y: number; m: number; d: number }
export const parseYmd = (s: string): Ymd => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`not a calendar day: ${s}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
};
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const fmtYmd = ({ y, m, d }: Ymd) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** Days since 1970-01-01, by the civil-calendar formula (no Date object). */
export function dayNumber(s: string): number {
  let { y, m, d } = parseYmd(s);
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
export function fromDayNumber(z: number): string {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return fmtYmd({ y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d });
}
export const addDays = (s: string, n: number) => fromDayNumber(dayNumber(s) + n);
/** 0 = Sunday. */
export const weekday = (s: string) => (((dayNumber(s) + 4) % 7) + 7) % 7;

/** `n` months after `s`, on the ANCHOR's day of month, clamped to the month's
 *  length (Jan 31 → Feb 28/29 → Mar 31: the anchor day is kept, not the
 *  clamped one). */
export function addMonthsAnchored(anchor: string, n: number): string {
  const a = parseYmd(anchor);
  const idx = a.y * 12 + (a.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return fmtYmd({ y, m, d: Math.min(a.d, daysInMonth(y, m)) });
}

export type Freq = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

/** The k-th occurrence (k = 0 is the anchor) of a simple series. */
export function occurrence(anchor: string, freq: Freq, k: number): string {
  switch (freq) {
    case "daily": return addDays(anchor, k);
    case "weekly": return addDays(anchor, 7 * k);
    case "biweekly": return addDays(anchor, 14 * k);
    case "monthly": return addMonthsAnchored(anchor, k);
    case "quarterly": return addMonthsAnchored(anchor, 3 * k);
    case "yearly": return addMonthsAnchored(anchor, 12 * k);
  }
}

/** Every occurrence of the series inside [from, to], inclusive. */
export function occurrencesBetween(anchor: string, freq: Freq, from: string, to: string, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let k = 0; k < 5000; k++) {
    const d = occurrence(anchor, freq, k);
    if (d > to) break;
    if (d >= from && !skip.includes(d)) out.push(d);
  }
  return out;
}

/** A recurring bill's next date as every list shows it (CLAUDE.md A7): an
 *  elapsed due date is assumed paid, so the next date is the first occurrence
 *  on or after today that is not already settled. */
export function nextBillDate(storedNext: string, freq: Freq, today: string, settled: readonly string[] = []): string {
  for (let k = 0; k < 5000; k++) {
    const d = occurrence(storedNext, freq, k);
    if (d >= today && !settled.includes(d)) return d;
  }
  throw new Error("no next date");
}

// ── debts ───────────────────────────────────────────────────────────────────
/** One month's interest on a balance at an APR given as a PERCENT (L3). */
export const monthInterest = (balance: number, aprPct: number) => cents((balance * aprPct) / 100 / 12);

/** L5: the first payment of a month carries that month's interest; the rest
 *  is principal. A later payment in the same month, and an extra-principal
 *  payment, are all principal. Principal never exceeds the balance. */
export function splitPayment(balance: number, aprPct: number, amount: number, opts: { interestAlreadyCharged?: boolean; extraPrincipal?: boolean } = {}) {
  const interest = opts.interestAlreadyCharged || opts.extraPrincipal ? 0 : Math.min(amount, monthInterest(balance, aprPct));
  const principal = Math.min(cents(amount - interest), balance);
  return { interest: cents(interest), principal: cents(principal), newBalance: cents(balance - principal) };
}

/** The level monthly payment of a fully amortising loan. */
export function levelPayment(principal: number, aprPct: number, months: number): number {
  const r = aprPct / 100 / 12;
  if (r === 0) return cents(principal / months);
  return cents((principal * r) / (1 - Math.pow(1 + r, -months)));
}

/** Month-by-month payoff: months to zero and total interest. */
export function payoff(balance: number, aprPct: number, payment: number): { months: number; totalInterest: number } | null {
  let b = balance, months = 0, totalInterest = 0;
  while (b > 0.005) {
    const i = monthInterest(b, aprPct);
    if (payment <= i) return null; // never pays off
    const p = Math.min(payment - i, b);
    b = cents(b - p);
    totalInterest = cents(totalInterest + i);
    if (++months > 1200) return null;
  }
  return { months, totalInterest };
}

// ── net worth ───────────────────────────────────────────────────────────────
export interface WorthItem { value: number; /** percent of it this household/person holds; default 100 */ sharePct?: number }
/** Assets minus debts. Every record counts once, whatever it is nested under. */
export function netWorth(assets: readonly WorthItem[], debts: readonly WorthItem[]) {
  const sum = (xs: readonly WorthItem[]) => cents(xs.reduce((s, x) => s + (x.value * (x.sharePct ?? 100)) / 100, 0));
  const a = sum(assets), l = sum(debts);
  return { assets: a, liabilities: l, netWorth: cents(a - l) };
}

// ── budgets and spending ────────────────────────────────────────────────────
export interface Spend { amount: number; category: string; date: string }
export function spentIn(expenses: readonly Spend[], month: string, category?: string): number {
  return cents(expenses.filter((e) => e.date.startsWith(month) && (!category || e.category === category)).reduce((s, e) => s + e.amount, 0));
}

// ── depreciation ────────────────────────────────────────────────────────────
export const accumulatedDepreciation = (purchasePrice: number, currentValue: number) => cents(Math.max(0, purchasePrice - currentValue));
export const depreciationPct = (purchasePrice: number, currentValue: number) =>
  purchasePrice > 0 ? Math.round((Math.max(0, purchasePrice - currentValue) / purchasePrice) * 1000) / 10 : 0;

// ── habits ──────────────────────────────────────────────────────────────────
/** Current streak of a daily habit: consecutive checked days ending today, or
 *  ending yesterday when today is not checked yet. */
export function dailyStreak(checkedDays: readonly string[], today: string): number {
  const set = new Set(checkedDays);
  let d = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

// ── running ─────────────────────────────────────────────────────────────────
/** min/mile and mph for a distance in miles and a duration in minutes. */
export function pace(miles: number, minutes: number) {
  const minPerMile = minutes / miles;
  const whole = Math.floor(minPerMile);
  let sec = Math.round((minPerMile - whole) * 60);
  let min = whole;
  if (sec === 60) { min++; sec = 0; }
  return { text: `${min}:${pad(sec)}`, mph: Math.round((miles / (minutes / 60)) * 100) / 100 };
}
