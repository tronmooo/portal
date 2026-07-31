// The canonical timeline window (shared/calendar-window.ts) exists so the
// dashboard bootstrap, the calendar page, the month grid and the Executive
// briefing all read/write ONE cache slot. That only holds if the window is a
// strict superset of every consumer's real need — these tests pin that
// property across month boundaries so a future tweak can't silently reopen
// the "calendar always cold-fetches" bug (2026-07-31).
import { describe, it, expect } from "vitest";
import { canonicalTimelineWindow, timelineQueryKey, timelineUrl } from "../shared/calendar-window";

const DAY_MS = 86_400_000;
const toMs = (s: string) => Date.parse(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => new Date(toMs(s) + n * DAY_MS).toISOString().slice(0, 10);

// A spread of "today"s: month starts/ends, leap day, year boundary, mid-month.
const SAMPLE_DAYS = [
  "2026-01-01", "2026-01-31", "2026-02-28", "2026-03-01", "2026-07-15",
  "2026-07-31", "2026-12-31", "2028-02-29", "2026-08-01", "2026-11-30",
];

describe("canonicalTimelineWindow", () => {
  it("covers the calendar page's today → today+30 counter range", () => {
    for (const today of SAMPLE_DAYS) {
      const w = canonicalTimelineWindow(today);
      expect(w.start <= today, `${today}: start ${w.start}`).toBe(true);
      expect(w.end >= addDays(today, 30), `${today}: end ${w.end}`).toBe(true);
    }
  });

  it("covers the briefing's today → today+45 horizon", () => {
    for (const today of SAMPLE_DAYS) {
      const w = canonicalTimelineWindow(today);
      expect(w.end).toBe(addDays(today, 45));
    }
  });

  it("covers the month grid's monthStart−7 → monthEnd+14 padded range for the current month", () => {
    for (const today of SAMPLE_DAYS) {
      const [y, m] = today.split("-").map(Number);
      const monthStart = `${today.slice(0, 8)}01`;
      const monthEndMs = Date.UTC(y, m, 0); // day 0 of next month = last of this
      const monthEnd = new Date(monthEndMs).toISOString().slice(0, 10);
      const w = canonicalTimelineWindow(today);
      expect(w.start).toBe(addDays(monthStart, -7));
      expect(w.end >= addDays(monthEnd, 14), `${today}: end ${w.end} < ${addDays(monthEnd, 14)}`).toBe(true);
    }
  });

  it("is deterministic for the same input (server and client agree)", () => {
    expect(canonicalTimelineWindow("2026-07-31")).toEqual(canonicalTimelineWindow("2026-07-31"));
  });

  it("builds the live key shape [endpoint, start, end, mode, ...ids]", () => {
    const w = canonicalTimelineWindow("2026-07-31");
    expect(timelineQueryKey(w, "selected", ["a", "b"])).toEqual([
      "/api/calendar/timeline", w.start, w.end, "selected", "a", "b",
    ]);
    expect(timelineQueryKey(w, "everyone", [])).toEqual([
      "/api/calendar/timeline", w.start, w.end, "everyone",
    ]);
  });

  it("builds a URL with scope only when selected ids exist", () => {
    const w = canonicalTimelineWindow("2026-07-31");
    expect(timelineUrl(w, "everyone", [])).toBe(`/api/calendar/timeline?start=${w.start}&end=${w.end}`);
    expect(timelineUrl(w, "selected", ["a"])).toBe(`/api/calendar/timeline?start=${w.start}&end=${w.end}&profileIds=a`);
  });

  it("falls back to a clock-anchored window on malformed input", () => {
    const w = canonicalTimelineWindow("not-a-date");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(w.start)).toBe(true);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(w.end)).toBe(true);
    expect(w.start < w.end).toBe(true);
  });
});
