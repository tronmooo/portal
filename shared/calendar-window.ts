// ─── Canonical calendar-timeline window ──────────────────────────────────────
// Why this exists: /api/calendar/timeline responses are cached under keys that
// EMBED the requested start/end dates. Before this module, three consumers
// each computed their own window — the dashboard bootstrap seeded
// today → today+45, the calendar page fetched today → today+30, and the
// month grid fetched monthStart−7 → monthEnd+14 — so no consumer ever hit the
// seeded cache and the calendar cold-fetched on every single open (the
// "This is taking too long to load" report, 2026-07-31).
//
// One window now serves all of them. It is the union of every consumer's need
// for the CURRENT month:
//   start = first of the current month − 7 days   (grid's leading padding)
//   end   = today + 45 days                        (briefing horizon; always ≥
//                                                   monthEnd+14 for the current
//                                                   month, and ≥ today+30)
// Consumers that need a narrower range (the page's 30-day counters, the
// briefing's today-onward feed) filter the shared payload client-side.
//
// Pure date-string math in UTC so the same `todayStr` input produces the same
// window on the server (any TZ) and in the browser.

export interface TimelineWindow {
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD inclusive
}

const DAY_MS = 86_400_000;

function fmt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Compute the canonical window from a YYYY-MM-DD "today" string. */
export function canonicalTimelineWindow(todayStr: string): TimelineWindow {
  const [y, m, d] = String(todayStr).split("-").map(Number);
  if (!y || !m || !d) {
    // Malformed input — fall back to a window anchored on the runtime clock so
    // callers still get a usable range rather than "Invalid Date" keys.
    const now = new Date();
    return canonicalTimelineWindow(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    );
  }
  const todayMs = Date.UTC(y, m - 1, d);
  const monthStartMs = Date.UTC(y, m - 1, 1);
  return {
    start: fmt(monthStartMs - 7 * DAY_MS),
    end: fmt(todayMs + 45 * DAY_MS),
  };
}

/**
 * The one canonical react-query key for a timeline window. Shape is the LIVE
 * convention [endpoint, start, end, mode, ...ids] (dates BEFORE mode — this
 * predates shared/query-keys.ts scopedKey and every existing consumer +
 * invalidation site uses it, so it must stay bit-identical).
 */
export function timelineQueryKey(
  window: TimelineWindow,
  mode: string,
  profileIds: string[] = [],
): unknown[] {
  return ["/api/calendar/timeline", window.start, window.end, mode, ...(profileIds || []).filter(Boolean)];
}

/** Query-string URL for the canonical window (profileIds appended when scoped). */
export function timelineUrl(
  window: TimelineWindow,
  mode: string,
  profileIds: string[] = [],
): string {
  const ids = (profileIds || []).filter(Boolean);
  const scope = mode === "selected" && ids.length > 0 ? `&profileIds=${ids.join(",")}` : "";
  return `/api/calendar/timeline?start=${window.start}&end=${window.end}${scope}`;
}
