/**
 * Decimal-safe money for connected financial data.
 *
 * WHY THIS EXISTS
 * ---------------
 * The rest of Portol stores manually-entered amounts as JS numbers in major
 * units (dollars). That is tolerable for hand-typed figures, but it is not
 * tolerable for bank data: a month of imported transactions is thousands of
 * additions, and `0.1 + 0.2 !== 0.3` compounds into totals that visibly
 * disagree with the bank statement.
 *
 * THE RULE for everything under `financial_*`:
 *   - Money is an INTEGER count of MINOR UNITS (cents for USD). Full stop.
 *   - Arithmetic on money is integer arithmetic. Never `+` on dollars.
 *   - Conversion to dollars happens exactly once, at the rendering boundary.
 *
 * SIGN CONVENTION (canonical, mirrored in the DB migration):
 *   - Positive = money ENTERING the account (deposit, refund, incoming transfer)
 *   - Negative = money LEAVING the account (purchase, payment, outgoing transfer)
 *   - Account balances are signed from the HOLDER's perspective: cash is
 *     positive, debt is negative. A single sum over accounts is net worth.
 *
 * Every screen, export, AI tool, and report reads these helpers so no surface
 * can quietly invent a different interpretation.
 */

/** A signed integer count of minor units (e.g. cents). */
export type Minor = number;

/**
 * Currencies with no minor unit (JPY, KRW, …) plus the three-decimal ones.
 * Stripe reports amounts in the currency's own minor unit, so the exponent
 * only matters when converting to/from a human-readable major-unit figure.
 */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Number of decimal places the currency's major unit has. */
export function currencyExponent(currency: string): number {
  const c = (currency || "usd").toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Multiplier between one major unit and its minor units (100 for USD). */
export function minorPerMajor(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/**
 * Coerce anything the DB or an API hands us into a safe integer minor amount.
 * `bigint` columns come back from PostgREST as JS numbers when small enough and
 * as strings when large; both are handled. Anything unparseable → 0, which is
 * always safer in a total than NaN (NaN poisons every downstream sum silently).
 */
export function toMinor(value: unknown): Minor {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  return 0;
}

/**
 * Convert a major-unit figure (a user-typed "1234.56", a legacy dollars column)
 * into minor units WITHOUT floating-point drift.
 *
 * `Math.round(1234.565 * 100)` is not reliable — 1234.565 is stored as
 * ...64999... and rounds down. We parse the decimal text instead so the digits
 * the user actually wrote are the digits we store.
 */
export function majorToMinor(value: unknown, currency = "usd"): Minor {
  const exp = currencyExponent(currency);
  if (value == null || value === "") return 0;

  let text = typeof value === "number" ? value.toFixed(exp + 4) : String(value).trim();
  if (!text) return 0;
  // Strip currency symbols, spaces and thousands separators.
  text = text.replace(/[^0-9.\-+eE]/g, "");
  if (!text || text === "-" || text === "+") return 0;

  // Scientific notation (rare, but Number#toString produces it for tiny values)
  // — fall back to the float path; the magnitudes involved cannot lose cents.
  if (/[eE]/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? Math.round(n * 10 ** exp) : 0;
  }

  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[-+]/, "");
  const [wholeRaw = "0", fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/\D/g, "") || "0";
  const frac = fracRaw.replace(/\D/g, "");

  // Pad/round the fraction to the currency's exponent. Half-up on the first
  // dropped digit — the same rule a bank statement uses.
  const kept = frac.slice(0, exp).padEnd(exp, "0");
  const nextDigit = frac.charAt(exp);
  let minor = Number(whole) * 10 ** exp + Number(kept || "0");
  if (nextDigit && Number(nextDigit) >= 5) minor += 1;

  return negative ? -minor : minor;
}

/** Minor units → a major-unit JS number. Use ONLY at the rendering boundary. */
export function minorToMajor(minor: Minor, currency = "usd"): number {
  return toMinor(minor) / minorPerMajor(currency);
}

/** Exact integer sum. The only sanctioned way to total money. */
export function sumMinor(values: Iterable<Minor>): Minor {
  let total = 0;
  for (const v of values) total += toMinor(v);
  return total;
}

/** Absolute value, integer-safe. Null/undefined are treated as zero. */
export function absMinor(value: Minor | null | undefined): Minor {
  return Math.abs(toMinor(value));
}

/**
 * Divide a minor amount by a positive integer count (e.g. average daily spend),
 * rounding half-up to the nearest minor unit so averages still total sensibly.
 */
export function divideMinor(total: Minor, divisor: number): Minor {
  if (!divisor || !Number.isFinite(divisor)) return 0;
  return Math.round(toMinor(total) / divisor);
}

/**
 * Percentage change between two minor amounts, as a number of percent.
 * Returns null when the baseline is zero — "up ∞%" is not a fact we can state.
 */
export function percentChange(current: Minor, previous: Minor): number | null {
  const prev = toMinor(previous);
  if (prev === 0) return null;
  return ((toMinor(current) - prev) / Math.abs(prev)) * 100;
}

/**
 * Render minor units for display. Uses Intl so currency symbol, grouping and
 * decimal count all follow the currency itself rather than a hardcoded "$".
 */
export function formatMinor(
  minor: Minor,
  currency = "usd",
  opts: { signDisplay?: "auto" | "always" | "never" | "exceptZero"; compact?: boolean } = {},
): string {
  const exp = currencyExponent(currency);
  const value = minorToMajor(minor, currency);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
      minimumFractionDigits: opts.compact ? 0 : exp,
      maximumFractionDigits: opts.compact ? 0 : exp,
      signDisplay: opts.signDisplay ?? "auto",
      notation: opts.compact ? "compact" : "standard",
    }).format(value);
  } catch {
    // Unknown/invalid ISO code — fall back to a plain number so a bad currency
    // string from an institution can never blank out a whole screen.
    return `${value.toFixed(exp)} ${(currency || "").toUpperCase()}`.trim();
  }
}

/**
 * Are two amounts equal within a tolerance? Used by transfer matching, where a
 * wire fee can make the two legs differ by a few cents.
 */
export function withinTolerance(a: Minor, b: Minor, toleranceMinor: number): boolean {
  return absMinor(toMinor(a) - toMinor(b)) <= Math.abs(toleranceMinor);
}
