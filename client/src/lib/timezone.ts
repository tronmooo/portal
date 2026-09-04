// ─── The one timezone the app reasons about ─────────────────────────────────
//
// "Today" is the single most load-bearing value in this product: what is due,
// what is overdue, whether a habit counts, which month an expense lands in.
// The client used to answer it with `Intl.DateTimeFormat().resolvedOptions()
// .timeZone`, read ONCE at module load, while the server answered it from a
// per-user `timezone` preference it has stored all along. Two answers, and
// nothing to reconcile them: someone who travels — or who simply prefers their
// records kept in the zone they live in rather than the one their laptop is
// sitting in — got a dashboard that disagreed with its own data.
//
// This module is the reconciliation. The preference wins when it is set; the
// device is the fallback and the default. Everything user-facing reads
// `getActiveTimezone()`, including the header every API request carries, so
// both sides of the wire agree by construction.
//
// Deliberately dependency-free: queryClient imports it at module load, so it
// must not import queryClient (or anything that does).

/** What the device says. Re-resolved on demand — a laptop can change zones. */
export function getDeviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

const FALLBACK_TIMEZONE = "America/Los_Angeles";
const STORAGE_KEY = "portol_timezone";

/** The user's stored preference, or null to follow the device. */
let preference: string | null = readStoredPreference();

function readStoredPreference(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && isValidTimezone(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** True when the runtime actually knows this zone — a bad value must never
 *  poison every date in the app, so it is rejected at the boundary. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone every user-facing date, "today" and API request should use.
 * Preference first, device second.
 */
export function getActiveTimezone(): string {
  return preference || getDeviceTimezone();
}

/** Is the app following the device rather than an explicit choice? */
export function isFollowingDeviceTimezone(): boolean {
  return preference === null;
}

/**
 * Set (or clear, with null) the user's timezone.
 *
 * Mirrored to localStorage so the very first render after a reload — which
 * happens long before /api/preferences answers — already uses the right zone
 * rather than flashing the device's.
 */
export function setActiveTimezone(tz: string | null): void {
  const next = tz && isValidTimezone(tz) ? tz : null;
  if (next === preference) return;
  preference = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private browsing — the in-memory value still stands */ }
  for (const fn of listeners) { try { fn(getActiveTimezone()); } catch { /* one bad listener must not stop the rest */ } }
}

/** Forget the stored zone — called on sign-out, like every other user-scoped key. */
export function clearStoredTimezone(): void {
  preference = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

const listeners = new Set<(tz: string) => void>();
export function subscribeTimezone(fn: (tz: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Today, as the user's calendar sees it: "YYYY-MM-DD" in the active zone.
 *
 * en-CA is the ISO-shaped locale, not a display choice — this value is
 * compared against date columns, never rendered.
 */
export function todayInActiveTimezone(at: Date = new Date()): string {
  try {
    return at.toLocaleDateString("en-CA", { timeZone: getActiveTimezone() });
  } catch {
    return at.toLocaleDateString("en-CA");
  }
}
