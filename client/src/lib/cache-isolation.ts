// Pure, dependency-free helpers that enforce per-user isolation of the
// persisted React Query cache. Kept side-effect-free and DOM-free so the
// security-critical logic can be unit-tested in a plain node environment
// (see tests/cache-isolation.test.ts).
//
// Background: the query cache is mirrored to localStorage so a full reload
// restores instantly instead of flashing a skeleton. That blob survives tab
// close, token expiry, and crashes — i.e. every path that bypasses signOut's
// explicit clear. If it were ever hydrated into a *different* account's
// session it would show user A's profiles/finances to user B. These helpers
// guarantee a snapshot is only ever restored for the exact user who created
// it, verified against the live session token.

export interface PersistedEntry {
  k: unknown; // queryKey
  d: unknown; // data
  t: number;  // dataUpdatedAt (ms epoch)
}

export interface PersistedBlob {
  uid: string;
  entries: PersistedEntry[];
}

/**
 * Decode the Supabase access-token subject (user id) from a stored session
 * JSON string. Returns null when the session is missing, malformed, or expired
 * — i.e. whenever we cannot positively identify the current user.
 *
 * `allowExpired` (PERF Phase 1.2, 2026-07-16): cache OWNERSHIP checks may
 * accept an expired access token when a refresh token is present. The token
 * still positively identifies which user's session occupies this browser —
 * expiry is an authentication concern, not an identification one, and every
 * API request is still authenticated server-side. Without this, the persisted
 * query cache was purged on every launch after the ~1h token lifetime (i.e.
 * on virtually every real "open the app"), which is exactly the
 * skeletons-on-open symptom the persistence exists to prevent. If the refresh
 * later fails, the auth-cleared path wipes all client caches anyway.
 */
export function decodeSessionUserId(
  rawSession: string | null,
  nowSec: number = Math.floor(Date.now() / 1000),
  allowExpired: boolean = false,
): string | null {
  if (!rawSession) return null;
  try {
    const tokens = JSON.parse(rawSession) as { access_token?: string; refresh_token?: string; expires_at?: number };
    if (!tokens?.access_token) return null;
    if (tokens.expires_at && tokens.expires_at < nowSec) {
      if (!allowExpired || !tokens.refresh_token) return null;
    }
    const payload = String(tokens.access_token).split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded?.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide what (if anything) may be hydrated from a persisted blob for the
 * current session.
 *
 * Returns the entries that are safe to restore and whether the stored blob
 * should be purged from localStorage. The blob is purged (and nothing is
 * restored) whenever:
 *   - it is corrupt / unparseable,
 *   - it is a legacy un-stamped array (pre-isolation format),
 *   - there is no live session user, or
 *   - the blob's owner id does not match the live session user id.
 */
export function selectHydratableEntries(
  rawBlob: string | null,
  sessionUid: string | null,
  opts: { nowMs?: number; maxAgeMs: number },
): { entries: PersistedEntry[]; purge: boolean } {
  if (!rawBlob) return { entries: [], purge: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlob);
  } catch {
    return { entries: [], purge: true };
  }

  const isObjBlob = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const blobUid = isObjBlob ? (parsed as PersistedBlob).uid : undefined;
  const rawEntries = isObjBlob ? (parsed as PersistedBlob).entries : undefined;
  const entries = Array.isArray(rawEntries) ? rawEntries : null;

  if (!sessionUid || !blobUid || !entries || blobUid !== sessionUid) {
    return { entries: [], purge: true };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - opts.maxAgeMs;
  return {
    entries: entries.filter((e) => !!e && e.k != null && typeof e.t === "number" && e.t >= cutoff),
    purge: false,
  };
}
