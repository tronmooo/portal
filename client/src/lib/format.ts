// Canonical money + date formatters so every surface renders the same way.
// Before this, the dashboard showed "$18000.00", the finance page "$1,368", and
// cards mixed "6/29/2026" / "Jun 24" / "May 21". One source of truth here.

/**
 * Format a dollar amount: thousands separators, no trailing ".00" on whole
 * dollars, two decimals otherwise. e.g. 18000 → "$18,000", 12.5 → "$12.50".
 */
export function formatMoney(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const whole = abs % 1 === 0;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-$" : "$"}${body}`;
}

/** Whole-dollar variant (rounded) for compact KPI tiles. */
export function formatMoneyRound(n: number | null | undefined): string {
  return formatMoney(Math.round(Number(n) || 0));
}

/**
 * Always two decimals — for ledger-ish surfaces where "$155" and "$155.00"
 * sitting in the same column would look like different precisions.
 */
export function formatMoneyCents(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "-$" : "$"}${body}`;
}

/**
 * Abbreviated only where the digits stop being readable: 1_250_000 → "$1.25M".
 * Below a million it stays grouped and exact, and drops cents past ten thousand
 * where they're noise.
 *
 * These thresholds are lifted verbatim from asset-overview's local
 * formatCurrency rather than chosen fresh, so consolidating onto this changed
 * nothing on screen — an asset worth 48,200 still reads "$48,200", not "$48.2K".
 */
export function formatMoneyCompact(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Parse a date the way the app stores them.
 *
 * A bare "YYYY-MM-DD" is a CALENDAR day, not an instant. `new Date("2026-08-30")`
 * reads it as UTC midnight, which is Aug 29 everywhere west of Greenwich — so a
 * bill due Aug 30 rendered "Aug 29" in the liability hero while the schedule
 * card right below it (which appended T00:00:00) said "Aug 30". Appending the
 * time forces local midnight and the two agree.
 */
export function parseLocalDate(input: string | Date | null | undefined): Date | null {
  if (!input) return null;
  const d = typeof input === "string"
    ? new Date(input.length === 10 ? input + "T00:00:00" : input)
    : input;
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Absolute date for detail rows and fact tiles: "Aug 30, 2026". Always spells
 * out the day — a row labelled "Next scheduled due" wants a date, not
 * "Tomorrow". Use `formatListDate` where relative reads better.
 */
export function formatFullDate(
  input: string | Date | null | undefined,
  empty = "—",
): string {
  const d = parseLocalDate(input);
  if (!d) return empty;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Human date for list rows: relative for the last week ("Today", "Yesterday",
 * "3d ago"), then "MMM D", with the year only when it isn't the current year.
 * Accepts a Date, ISO string, or "YYYY-MM-DD".
 */
export function formatListDate(input: string | Date | null | undefined): string {
  if (!input) return "";
  const d = parseLocalDate(input);
  if (!d) return "";
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff}d ago`;
  if (dayDiff === -1) return "Tomorrow";
  if (dayDiff < -1 && dayDiff > -7) return `in ${-dayDiff}d`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}
