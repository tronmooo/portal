import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a money-ish value into a number.
 * Handles: 25000, "25000", "$25,000", "25,000.50", "USD 25000", "$25k", " 1.2m ".
 * Returns 0 for null/undefined/empty/unparseable.
 *
 * Bug context: profiles store values as user-typed strings (e.g. user types
 * "$25,000" or "40k"), and Number("$25,000") = NaN. That caused Roth IRA,
 * Honda, Tesla, etc. to all show $0 in net worth.
 */
export function parseMoney(input: any): number {
  if (input == null) return 0;
  if (typeof input === "number") return Number.isFinite(input) ? input : 0;
  const s = String(input).trim();
  if (!s) return 0;
  // Strip currency symbols, commas, spaces, and any leading non-digit/non-minus chars.
  const cleaned = s.replace(/[^0-9.\-kKmMbB]/g, "").trim();
  if (!cleaned) return 0;
  const m = cleaned.match(/^(-?\d*\.?\d+)([kKmMbB])?$/);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return 0;
  const suffix = (m[2] || "").toLowerCase();
  const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return base * mult;
}
