// ── Entry date anchoring (BUG 2026-07-27: "yesterday shows as July 25") ──────
// A backdated tracker entry passed as a bare date ("2026-07-26") or a
// midnight-UTC instant ("2026-07-26T00:00:00.000Z") used to be stored at
// 00:00 UTC — which is the EVENING OF THE PREVIOUS DAY in every US timezone,
// so the entry rendered on the wrong date. validateToolInput must anchor
// calendar-date intent to noon in the user's timezone; values carrying a real
// clock time keep their exact instant. Key-free, no API calls.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The real storage proxy requires Supabase env even to touch `_timezone`;
// substitute a plain object (same pattern as tests/lookup-value-route.test.ts).
const h = vi.hoisted(() => ({ stub: { _timezone: undefined as string | undefined } }));
vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: h.stub };
});

import { validateToolInput } from "../server/ai-engine";
import { getZonedParts } from "../shared/timezone";

// validateToolInput reads the per-request timezone off the storage proxy.
const setTz = (tz: string | undefined) => { h.stub._timezone = tz; };

const normalizeAt = (at: string): string | undefined => {
  const v = validateToolInput("log_tracker_entry", {
    trackerName: "Bench Press",
    values: { sets: 3 },
    at,
  });
  expect(v.valid).toBe(true);
  return (v.normalized as any).at;
};

describe("log_tracker_entry `at` date anchoring", () => {
  beforeEach(() => setTz("America/Los_Angeles"));
  afterEach(() => setTz(undefined));

  it('a bare date ("2026-07-26") renders on July 26 in the user timezone', () => {
    const at = normalizeAt("2026-07-26")!;
    expect(getZonedParts(new Date(at), "America/Los_Angeles").date).toBe("2026-07-26");
  });

  it('a midnight-UTC instant ("...T00:00:00.000Z") is treated as that calendar day', () => {
    // This is the exact value from the 2026-07-27 incident: it used to store
    // as-is and display "Jul 25, 5:00 PM" in Pacific time.
    const at = normalizeAt("2026-07-26T00:00:00.000Z")!;
    expect(getZonedParts(new Date(at), "America/Los_Angeles").date).toBe("2026-07-26");
  });

  it("works for Eastern time too", () => {
    setTz("America/New_York");
    const at = normalizeAt("2026-07-26T00:00:00.000Z")!;
    expect(getZonedParts(new Date(at), "America/New_York").date).toBe("2026-07-26");
  });

  it("a value with a real clock time keeps its exact instant", () => {
    const at = normalizeAt("2026-07-26T17:30:00.000Z")!;
    expect(at).toBe("2026-07-26T17:30:00.000Z");
  });

  it('a bare clock time ("8:15 AM") still composes with today in the user timezone', () => {
    const at = normalizeAt("8:15 AM")!;
    const parts = getZonedParts(new Date(at), "America/Los_Angeles");
    expect(parts.hours).toBe(8);
    expect(parts.minutes).toBe(15);
    expect(parts.date).toBe(getZonedParts(new Date(), "America/Los_Angeles").date);
  });

  it("unparseable input still drops to now with a warning", () => {
    const v = validateToolInput("log_tracker_entry", {
      trackerName: "Bench Press",
      values: { sets: 3 },
      at: "not a date at all",
    });
    expect(v.valid).toBe(true);
    expect((v.normalized as any).at).toBeUndefined();
    expect(v.warnings.some((w: string) => w.includes("Couldn't parse"))).toBe(true);
  });
});
