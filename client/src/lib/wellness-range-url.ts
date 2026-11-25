// The Wellness range the user picked lives in the URL, not in storage.
//
// H4: the on-screen range tabs change the VIEW and are not saved (the stored
// default is a display option set in Customize); Rule 4: a filter that hides
// rows is never persisted to local/sessionStorage. But a reload must not throw
// the picked range away either (QA 2026-11-24: 7D, reload, back on 30D). The
// URL is the view's own address — `#/wellness?range=7d` — so a reload, a
// shared link and Back keep it, and nothing is written to the account or the
// browser's storage. The app routes in the hash, so the query sits inside it.
import { WELLNESS_RANGES, type WellnessRange } from "@shared/wellness-period";

const PARAM = "range";

function splitHash(hash: string): { path: string; params: URLSearchParams } {
  const h = (hash || "").replace(/^#/, "");
  const i = h.indexOf("?");
  return { path: i >= 0 ? h.slice(0, i) : h, params: new URLSearchParams(i >= 0 ? h.slice(i + 1) : "") };
}

/** The range named in the hash's query (`#/wellness?range=7d`), or null. */
export function rangeFromHash(hash: string | null | undefined): WellnessRange | null {
  const v = splitHash(hash || "").params.get(PARAM);
  return v && (WELLNESS_RANGES as readonly string[]).includes(v) ? (v as WellnessRange) : null;
}

/** The same hash with `range` set, every other part kept. */
export function hashWithRange(hash: string | null | undefined, range: WellnessRange): string {
  const { path, params } = splitHash(hash || "");
  params.set(PARAM, range);
  return `#${path || "/wellness"}?${params.toString()}`;
}

/** Read the range from the current URL (null outside a browser). */
export function readRangeFromLocation(): WellnessRange | null {
  try { return rangeFromHash(window.location.hash); } catch { return null; }
}

/** Put the range into the current URL without navigating or adding history. */
export function writeRangeToLocation(range: WellnessRange): void {
  try {
    const next = hashWithRange(window.location.hash, range);
    if (next !== window.location.hash) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${next}`);
    }
  } catch { /* the view still changes; only the address is not updated */ }
}
