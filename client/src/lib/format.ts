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
 * Human date for list rows: relative for the last week ("Today", "Yesterday",
 * "3d ago"), then "MMM D", with the year only when it isn't the current year.
 * Accepts a Date, ISO string, or "YYYY-MM-DD".
 */
export function formatListDate(input: string | Date | null | undefined): string {
  if (!input) return "";
  const d = typeof input === "string"
    ? new Date((input.length === 10 ? input + "T00:00:00" : input))
    : input;
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
