/**
 * Shared utility functions — extracted for testability.
 */

/** Strip dangerous content but preserve readable text. */
export function sanitize(input: string): string {
  return input
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/data:text\/html/gi, '')
    .replace(/vbscript:/gi, '')
    .trim()
    .slice(0, 10000);
}

/** Date validation helper — YYYY-MM-DD format. */
export function isValidDateStr(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());
}

/** Pagination helper — applies limit and offset to any array. */
export function paginate<T>(items: T[], query: { limit?: string; offset?: string }): { data: T[]; total: number; limit: number; offset: number } {
  const total = items.length;
  const limit = Math.min(Math.max(parseInt(query.limit || '') || total, 1), 500);
  const offset = Math.max(parseInt(query.offset || '') || 0, 0);
  return { data: items.slice(offset, offset + limit), total, limit, offset };
}

/**
 * Profile filter predicate.
 * Matches if:
 * - No filter profileId specified, OR
 * - Entity is linked to the filter profile, OR
 * - The filter profile is "self" type AND the entity has no linked profiles (unlinked = belongs to self)
 */
export function matchesProfile(linkedProfiles: string[], filterProfileId?: string, isSelfProfile?: boolean): boolean {
  if (!filterProfileId) return true;
  if (linkedProfiles.includes(filterProfileId)) return true;
  if (isSelfProfile && linkedProfiles.length === 0) return true;
  return false;
}

/** Simple in-memory rate limiter. */
export class RateLimiter {
  private map = new Map<string, { count: number; resetAt: number }>();
  private maxMapSize: number;

  constructor(maxMapSize = 10000) {
    this.maxMapSize = maxMapSize;
  }

  /** Returns true if rate-limited (should block), false if allowed. */
  check(key: string, maxRequests: number = 60, windowMs: number = 60000): boolean {
    const now = Date.now();
    const entry = this.map.get(key);
    if (!entry || now > entry.resetAt) {
      if (this.map.size > this.maxMapSize) {
        const cutoff = now - windowMs;
        for (const [k, v] of this.map) {
          if (v.resetAt < cutoff) this.map.delete(k);
          if (this.map.size <= this.maxMapSize * 0.8) break;
        }
      }
      this.map.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count++;
    return entry.count > maxRequests;
  }

  /** Remove expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, val] of this.map.entries()) {
      if (now > val.resetAt) this.map.delete(key);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
