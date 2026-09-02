/**
 * format.ts reuses one Intl formatter per option set instead of building one
 * per call (the construction was ~450ms per Finance render with 900 rows).
 * The contract is that the output is byte-identical to the toLocale* calls it
 * replaced, so this pins the two against each other across the branches.
 */
import { describe, it, expect } from "vitest";
import { formatMoney, formatMoneyCents, formatMoneyCompact, formatListDate, formatFullDate } from "../client/src/lib/format";

describe("cached Intl formatters match the toLocale* baseline", () => {
  const money = [0, 1, 12.5, 18000, 1234567.891, -42, -0.5, 999999999, 10000, 9999.999, 0.005];
  it("formatMoney", () => {
    for (const v of money) {
      const abs = Math.abs(v); const whole = abs % 1 === 0;
      const expected = `${v < 0 ? "-$" : "$"}${abs.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
      expect(formatMoney(v)).toBe(expected);
    }
    expect(formatMoney(18000)).toBe("$18,000");
    expect(formatMoney(12.5)).toBe("$12.50");
  });
  it("formatMoneyCents", () => {
    for (const v of money) {
      expect(formatMoneyCents(v)).toBe(`${v < 0 ? "-$" : "$"}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    }
  });
  it("formatMoneyCompact", () => {
    for (const v of [48200, 1_250_000, 9999.5, 10_000.4, 250, -48200, 0.1]) {
      const abs = Math.abs(v); const sign = v < 0 ? "-" : "";
      const expected = abs >= 1_000_000 ? `${sign}$${(abs / 1_000_000).toFixed(2)}M`
        : abs >= 10_000 ? `${sign}$${Math.round(abs).toLocaleString("en-US")}`
        : `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
      expect(formatMoneyCompact(v)).toBe(expected);
    }
  });
  it("formatFullDate / formatListDate", () => {
    const now = new Date();
    const lastYear = new Date(now.getFullYear() - 1, 5, 24);
    const sameYearFar = new Date(now.getFullYear(), now.getMonth() === 0 ? 5 : 0, 15);
    for (const d of [lastYear, sameYearFar, new Date(2024, 1, 29)]) {
      expect(formatFullDate(d)).toBe(d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
      const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
      if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
      const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
      if (Math.abs(diff) >= 7) expect(formatListDate(d)).toBe(d.toLocaleDateString("en-US", opts));
    }
    expect(formatListDate(now)).toBe("Today");
    expect(formatFullDate("2026-08-30")).toBe("Aug 30, 2026");
  });
});
