// Rule 30 — a number the app does not have is UNKNOWN, never zero.
//
// `x ?? 0` is how "$0" and "0 tasks" get painted over a failed request: the
// query errored (or has not answered), the value is undefined, and the
// fallback makes it look like a real, settled measurement. The dashboard has
// four states — loading, loaded-empty, loaded-data, error — and 0 belongs to
// exactly one of them (loaded-empty). Everything that renders a headline
// number goes through this: null means "show —", and the caller decides
// whether that is a skeleton (still loading) or "Couldn't load" (error).

/**
 * The number to render, or null when it is not known.
 *  - `value` absent / non-numeric → null (loading or missing: the caller's
 *    pending flag says which).
 *  - `isError` → null even when a value is cached: a number whose query is in
 *    error is not confirmed, and Rule 18 says a stale value never renders as
 *    final.
 */
export function numOrUnknown(value: unknown, isError: boolean): number | null {
  if (isError) return null;
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Format a known number, or the dash for an unknown one. */
export function fmtOrUnknown(value: number | null, fmt: (n: number) => string, dash = "—"): string {
  return value == null ? dash : fmt(value);
}
