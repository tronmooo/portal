/**
 * Auth rate limits that every serverless instance agrees on.
 *
 * server/auth.ts counts attempts in a per-instance Map. Production runs many
 * instances, so those counters each saw only a share of a caller's attempts
 * and the limit never tripped (2026-11-15: 12 wrong-password sign-ins in a
 * row from one address, limit 10 a minute, none refused). This asks the
 * database to count instead (migrations/20261115_auth_rate_limits.sql).
 *
 * FAIL-OPEN, on purpose: sign-in must never depend on this. Any failure —
 * the function is not deployed yet, the call times out, the database is
 * down — answers "not limited" and the caller falls back to the in-memory
 * counter it always had. After a failure the shared store is skipped for a
 * minute so a broken database costs one slow request, not every request.
 */
import { createHash } from "node:crypto";
import { logger } from "./logger";

/** The one call this needs from a Supabase client. */
export interface RateLimitRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface SharedRateLimiterOptions {
  /** Give up on the database after this long and fall back. */
  timeoutMs?: number;
  /** How long to skip the shared store after a failure. */
  cooldownMs?: number;
  now?: () => number;
}

export type SharedRateLimiter = (
  scope: string,
  id: string,
  max: number,
  windowMs: number,
) => Promise<boolean>;

/** The stored key: a hash, so no IP address or email reaches the table. */
export function rateLimitKey(scope: string, id: string): string {
  return createHash("sha256").update(`${scope}:${id}`).digest("hex");
}

/**
 * Returns `overLimit(scope, id, max, windowMs)`: counts one attempt in the
 * shared store and resolves true only when the store says this caller is over
 * `max` attempts in the window. Never rejects.
 */
export function createSharedRateLimiter(
  getClient: () => RateLimitRpcClient | null,
  opts: SharedRateLimiterOptions = {},
): SharedRateLimiter {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let skipUntil = 0;

  return async function overLimit(scope, id, max, windowMs) {
    if (now() < skipUntil) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = getClient();
      if (!client) return false;
      const call = Promise.resolve(
        client.rpc("auth_rate_limit_hit", {
          p_key: rateLimitKey(scope, id),
          p_max: max,
          p_window_ms: windowMs,
        }),
      );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("auth_rate_limit_hit timed out")), timeoutMs);
      });
      const { data, error } = await Promise.race([call, timeout]);
      if (error) throw error;
      return data === true;
    } catch (err: any) {
      skipUntil = now() + cooldownMs;
      logger.warn("auth", `shared rate limit unavailable, using per-instance counters: ${err?.message || err}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
