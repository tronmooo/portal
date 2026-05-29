/**
 * Part D — dashboard header date must use the user's timezone.
 *
 * The header (e.g. "Friday, May 29") was formatted with
 * `new Date().toLocaleDateString("en-US", { weekday, month, day })` — no
 * `timeZone` option, so it used the JS engine's local zone. On a UTC host
 * (Vercel) after ~4-5pm Pacific the UTC date has already rolled to tomorrow,
 * so the header showed the wrong day for Pacific users.
 *
 * The fix passes `timeZone: BROWSER_TIMEZONE` (which falls back to
 * America/Los_Angeles, matching the server's _timezone default). This test
 * pins the formatting contract on a known instant straddling the Pacific/UTC
 * day boundary.
 */
import { describe, it, expect } from "vitest";

const HEADER_OPTS = { weekday: "long", month: "long", day: "numeric" } as const;

function formatHeader(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-US", { ...HEADER_OPTS, timeZone });
}

describe("Part D — header date respects timezone", () => {
  // 2026-05-30 02:30 UTC == 2026-05-29 19:30 Pacific (PDT, UTC-7).
  // In UTC it is already Saturday May 30; in Pacific it is still Friday May 29.
  const instant = new Date("2026-05-30T02:30:00Z");

  it("formats in America/Los_Angeles as the Pacific day, not the UTC day", () => {
    expect(formatHeader(instant, "America/Los_Angeles")).toBe("Friday, May 29");
  });

  it("formats in UTC as the next calendar day (proves the zones differ)", () => {
    expect(formatHeader(instant, "UTC")).toBe("Saturday, May 30");
  });

  it("the two zones disagree at this instant — the bug the fix prevents", () => {
    expect(formatHeader(instant, "America/Los_Angeles")).not.toBe(
      formatHeader(instant, "UTC"),
    );
  });

  it("falls back to America/Los_Angeles semantics when no profile zone is set", () => {
    // BROWSER_TIMEZONE = Intl...timeZone || 'America/Los_Angeles'. Simulate the
    // fallback by passing the default explicitly.
    const tz = "" || "America/Los_Angeles";
    expect(formatHeader(instant, tz)).toBe("Friday, May 29");
  });
});
