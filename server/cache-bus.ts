// ── Cache-bust registration hook ─────────────────────────────────────────────
// The per-user response cache lives inside routes.ts (module-private map).
// ai-engine tools (refresh_dashboard) need to bust it, but ai-engine cannot
// import routes.ts — routes imports ai-engine, so that edge would be circular.
// routes.ts registers its scoped buster here at module init instead.

type Buster = (userId: string) => void;
const busters: Buster[] = [];

export function registerCacheBuster(fn: Buster): void {
  if (!busters.includes(fn)) busters.push(fn);
}

/** Bust every registered per-user cache. Returns how many busters ran. */
export function bustAllUserCaches(userId: string): number {
  let ran = 0;
  for (const fn of busters) {
    try { fn(userId); ran++; } catch { /* one broken buster must not stop the rest */ }
  }
  return ran;
}
