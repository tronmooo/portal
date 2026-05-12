import { logger } from "./logger";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction, Express } from "express";
import { storage, isSupabaseStorage, createScopedStorage, requestStorageContext } from "./storage";

// Type-safe helpers for storage methods that only exist on Supabase implementation
function setStorageUserId(userId: string): void {
  if (typeof (storage as Record<string, any>).setUserId === 'function') {
    (storage as Record<string, any>).setUserId(userId);
  }
}
async function seedStorageIfEmpty(): Promise<void> {
  if (typeof (storage as Record<string, any>).seedIfEmpty === 'function') {
    await (storage as Record<string, any>).seedIfEmpty();
  }
}

// Track which users have had their self profile checked this session (auto-evict after 1 hour).
// Map insertion order is preserved, so the oldest entry is map.keys().next().value.
const autoProfileCreated = new Map<string, number>();
const AUTO_PROFILE_TTL_MS = 3_600_000; // 1 hour
const AUTO_PROFILE_MAX = 5000;
function hasAutoProfile(userId: string): boolean {
  const ts = autoProfileCreated.get(userId);
  if (!ts) return false;
  if (Date.now() - ts > AUTO_PROFILE_TTL_MS) { autoProfileCreated.delete(userId); return false; }
  return true;
}
function markAutoProfile(userId: string): void {
  // 1) Sweep expired entries first.
  if (autoProfileCreated.size >= AUTO_PROFILE_MAX) {
    const now = Date.now();
    for (const [k, v] of autoProfileCreated) {
      if (now - v > AUTO_PROFILE_TTL_MS) autoProfileCreated.delete(k);
    }
    // 2) If still over the cap (all entries are fresh), evict the oldest
    //    insertion-order entries until we're back under the limit. This
    //    guarantees the map is bounded even under sustained load — the
    //    previous version only purged old entries, so a flood of unique
    //    fresh users could keep the map growing without limit.
    while (autoProfileCreated.size >= AUTO_PROFILE_MAX) {
      const oldestKey = autoProfileCreated.keys().next().value;
      if (oldestKey === undefined) break;
      autoProfileCreated.delete(oldestKey);
    }
  }
  // Re-insert (delete then set) so the user moves to the end of the
  // insertion order, making LRU eviction work correctly.
  autoProfileCreated.delete(userId);
  autoProfileCreated.set(userId, Date.now());
}

// Create a Supabase client with the anon key (for verifying user tokens)
let supabaseAuth: SupabaseClient | null = null;

function getSupabaseAuth(): SupabaseClient | null {
  if (supabaseAuth) return supabaseAuth;
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabaseAuth = createClient(url, key);
  return supabaseAuth;
}

// Extend Express Request with user info
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

/**
 * Admin gate — must run AFTER authMiddleware so req.userEmail is set.
 * Allowed emails come from `ADMIN_EMAILS` (comma-separated). If unset, the
 * built-in default below is used. To add more admins, set
 * `ADMIN_EMAILS=alice@example.com,bob@example.com` in the environment.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Local SQLite dev mode bypasses auth entirely; mirror that here so
  // /api/cleanup/* stays callable in dev without Supabase configured.
  if (!isSupabaseStorage()) return next();
  const raw = process.env.ADMIN_EMAILS || "tronmoooo@gmail.com";
  const allowed = new Set(
    raw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
  );
  const email = (req.userEmail || "").toLowerCase();
  if (!email || !allowed.has(email)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  return next();
}

// ── Token verification cache ────────────────────────────────────────────────
// supabase.auth.getUser(token) is a network round-trip to GoTrue (~50-300ms).
// On a single page load React Query fires 5-10 parallel API calls, each
// repeating this same lookup for the exact same JWT. We cache (token → user)
// for 60 seconds to coalesce those bursts. Revocation still kicks in within
// 60s, and the cache is automatically dropped on any verification error.
type CachedUser = { userId: string; email: string | undefined; expiresAt: number };
const tokenUserCache = new Map<string, CachedUser>();
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_MAX = 5000;
function getCachedUser(token: string): CachedUser | null {
  const hit = tokenUserCache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { tokenUserCache.delete(token); return null; }
  return hit;
}
function cacheUser(token: string, userId: string, email: string | undefined): void {
  // Bounded LRU — evict oldest insertion-order entries first.
  while (tokenUserCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenUserCache.keys().next().value;
    if (oldest === undefined) break;
    tokenUserCache.delete(oldest);
  }
  tokenUserCache.set(token, { userId, email, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
}
export function clearTokenCache(): void { tokenUserCache.clear(); }

/**
 * Auth middleware — extracts user from Supabase JWT in Authorization header.
 * If Supabase is not configured, allows all requests (local dev mode).
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // If not using Supabase, skip auth (local SQLite mode)
  if (!isSupabaseStorage()) {
    return next();
  }

  // Allow auth endpoints without auth
  // Note: mounted at /api so req.path is relative (e.g. /auth/config)
  if (req.path.startsWith("/auth/")) {
    return next();
  }

  // Cron endpoints authenticate via CRON_SECRET (validated inside the handler).
  if (req.path.startsWith("/cron/")) {
    return next();
  }

  // Public share endpoints — read-only, identified by random share token.
  // The handler looks up artifacts by metadata->>shareToken (no user filter).
  if (req.path.startsWith("/public/")) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
  }

  const token = authHeader.replace("Bearer ", "").trim();
  // S7 fix: reject empty / obviously-bogus tokens before round-tripping to Supabase.
  // Real Supabase JWTs are 100+ chars; 20 is a safe lower bound that catches
  // `Authorization: Bearer ` (trailing space) and similar malformed inputs.
  if (!token || token.length < 20) {
    return res.status(401).json({ error: "Invalid or expired token", code: "AUTH_INVALID" });
  }
  const supabase = getSupabaseAuth();
  if (!supabase) {
    return res.status(500).json({ error: "Auth not configured" });
  }

  try {
    // Fast path: serve from the 60s token cache when present. Coalesces the
    // burst of parallel API calls on every page navigation into a single auth
    // round-trip per minute per token.
    const cached = getCachedUser(token);
    let userId: string;
    let userEmail: string | undefined;
    if (cached) {
      userId = cached.userId;
      userEmail = cached.email;
    } else {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) {
        return res.status(401).json({ error: "Invalid or expired token", code: "AUTH_INVALID" });
      }
      userId = user.id;
      userEmail = user.email;
      cacheUser(token, userId, userEmail);
    }

    // Set user info on request
    req.userId = userId;
    req.userEmail = userEmail;
    const user = { id: userId, email: userEmail } as { id: string; email: string | undefined };

    // Create a per-request storage instance scoped to this user's ID.
    // This eliminates the global singleton race condition (C-1 security fix).
    // The legacy setUserId is kept as a fallback for any code paths that
    // don't go through the AsyncLocalStorage context.
    const scopedStorage = createScopedStorage(user.id);
    setStorageUserId(user.id); // backward compat fallback

    // Run the rest of the request within the scoped storage context.
    // All code that reads `storage` via the proxy will automatically
    // get this user-scoped instance instead of the global singleton.
    // 
    // IMPORTANT: We call next() synchronously inside run() so that
    // Express's middleware chain executes within the AsyncLocalStorage
    // context. The auto-profile check is fire-and-forget to avoid
    // blocking the request if it takes too long.
    requestStorageContext.run(scopedStorage, () => {
      // Auto-create "Me" self profile if none exists (runs once per session, cached)
      if (!hasAutoProfile(user.id)) {
        markAutoProfile(user.id);
        (async () => {
          try {
            const profiles = await storage.getProfiles();
            const hasSelf = profiles.some(p => p.type === 'self');
            if (!hasSelf) {
              const displayName = user.email?.split('@')[0] || 'Me';
              await storage.createProfile({
                name: displayName.charAt(0).toUpperCase() + displayName.slice(1),
                type: 'self',
                notes: '',
                fields: {},
                tags: [],
              });
              logger.info("auth", `Auto-created self profile for user ${user.id.slice(0, 8)}`);
            }
          } catch (e) {
            // Non-fatal — don't block auth
            console.error('[auth] Auto-profile creation failed:', e);
          }
        })();
      }

      next();
    });
  } catch (err: any) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ error: "Authentication failed", code: "AUTH_ERROR" });
  }
}

/**
 * Register auth-related API endpoints
 */
export function registerAuthRoutes(app: Express) {
  // Per-IP rate limiter for auth endpoints. Bounded so a flood of unique
  // IPs (e.g. a botnet probing /api/auth/login) cannot grow this map
  // without limit.
  const authRateLimits = new Map<string, { count: number; resetAt: number }>();
  const AUTH_RATE_LIMIT_MAX = 5000;
  function checkAuthRateLimit(ip: string, max = 10, windowMs = 60000): boolean {
    const now = Date.now();
    const entry = authRateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      if (authRateLimits.size >= AUTH_RATE_LIMIT_MAX) {
        // Drop expired entries first.
        for (const [k, v] of authRateLimits) {
          if (now > v.resetAt) authRateLimits.delete(k);
          if (authRateLimits.size < AUTH_RATE_LIMIT_MAX) break;
        }
        // If still at the cap (all entries fresh), evict oldest by
        // insertion order until back under the cap.
        while (authRateLimits.size >= AUTH_RATE_LIMIT_MAX) {
          const oldestKey = authRateLimits.keys().next().value;
          if (oldestKey === undefined) break;
          authRateLimits.delete(oldestKey);
        }
      }
      authRateLimits.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count++;
    return entry.count > max;
  }

  // Per-email signup limiter, layered on top of the per-IP one. Uses the same
  // bounded Map (different keyspace) so we don't grow another unbounded store.
  function checkEmailSignupRateLimit(email: string, max = 3, windowMs = 3600000): boolean {
    return checkAuthRateLimit(`signup_email:${email.toLowerCase()}`, max, windowMs);
  }

  // Optional Cloudflare Turnstile verification. No-op if CAPTCHA_SECRET is
  // not set, so the endpoint keeps working in dev/local environments.
  async function verifyCaptcha(token: string | undefined, remoteIp: string): Promise<boolean> {
    const secret = process.env.CAPTCHA_SECRET;
    if (!secret) return true;
    if (!token) return false;
    try {
      const params = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
      const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const json = await resp.json() as { success?: boolean };
      return !!json.success;
    } catch {
      return false;
    }
  }

  // Sign up with email/password
  app.post("/api/auth/signup", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    if (checkAuthRateLimit(clientIp, 5, 300000)) { // 5 signups per 5 minutes per IP
      return res.status(429).json({ error: "Too many signup attempts. Please wait and try again." });
    }

    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { email, password, captchaToken } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Per-email rate limit (stops one IP from cycling addresses, and stops
    // distributed attackers from hammering a single target email).
    if (checkEmailSignupRateLimit(email)) {
      return res.status(429).json({ error: "Too many signup attempts for this email. Please wait and try again." });
    }

    // Optional CAPTCHA — only enforced when CAPTCHA_SECRET is configured.
    const captchaOk = await verifyCaptcha(captchaToken, clientIp);
    if (!captchaOk) {
      return res.status(400).json({ error: "Captcha verification failed" });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for now (no email verification)
    });

    if (error) {
      return res.status(400).json({ error: "Authentication failed" });
    }

    // Sign in immediately to get a session
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Seed data for the new user
      setStorageUserId(data.user.id);
      await seedStorageIfEmpty();

    res.json({
      user: { id: data.user.id, email: data.user.email },
      session: {
        access_token: signInData.session?.access_token,
        refresh_token: signInData.session?.refresh_token,
        expires_at: signInData.session?.expires_at,
      },
    });
  });

  // Sign in with email/password
  app.post("/api/auth/signin", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    if (checkAuthRateLimit(clientIp)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait a minute and try again." });
    }

    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: "Authentication failed" });
    }

    res.json({
      user: { id: data.user.id, email: data.user.email },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  });

  // Refresh token
  app.post("/api/auth/refresh", async (req: Request, res: Response) => {
    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: "Refresh token required" });
    }

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error || !data.session) {
      return res.status(401).json({ error: error?.message || "Session expired" });
    }

    res.json({
      user: { id: data.user?.id, email: data.user?.email },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  });

  // Get current user
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Not authenticated" });

    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    res.json({ user: { id: user.id, email: user.email } });
  });

  // Sign out (client-side handles clearing tokens, but server can help)
  app.post("/api/auth/signout", async (_req: Request, res: Response) => {
    res.json({ success: true });
  });

  // Change password (authenticated)
  app.post("/api/auth/change-password", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    if (checkAuthRateLimit(clientIp, 5, 300000)) {
      return res.status(429).json({ error: "Too many password change attempts. Please wait and try again." });
    }

    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Not authenticated" });
    const token = authHeader.split(" ")[1];

    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    if (!currentPassword || typeof currentPassword !== "string") {
      return res.status(400).json({ error: "Current password is required" });
    }

    // Get user ID + email from token
    const { data: { user }, error: getUserErr } = await supabase.auth.getUser(token);
    if (getUserErr || !user || !user.email) return res.status(401).json({ error: "Invalid session" });

    // Verify the current password by attempting a sign-in. This guarantees only
    // the owner of the account can rotate the password — without this check, a
    // stolen access token alone would be enough to take over the account.
    const { error: verifyErr } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (verifyErr) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Use admin API to update password
    const { error } = await supabase.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  });

  // Forgot password — sends a reset link email via Supabase
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    if (checkAuthRateLimit(clientIp, 3, 300000)) {
      return res.status(429).json({ error: "Too many reset requests. Please wait and try again." });
    }

    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Sanitize redirect URL — only allow our known domain
    const envOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()) || [];
    const allowedOrigins = [...envOrigins, 'https://portol.me', 'http://localhost:5000'];
    const origin = String(req.headers.origin || '');
    const safeOrigin = allowedOrigins.includes(origin) ? origin : 'https://portol.me';

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${safeOrigin}/#/reset-password`,
    });

    if (error) {
      return res.status(400).json({ error: "Failed to send reset email" });
    }

    res.json({ success: true, message: "Check your email for a reset link" });
  });

  // Reset password — updates password using the access token from the reset link
  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    if (checkAuthRateLimit(clientIp, 5, 300000)) {
      return res.status(429).json({ error: "Too many reset attempts. Please wait and try again." });
    }

    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { access_token, password } = req.body;
    if (!access_token || !password) {
      return res.status(400).json({ error: "Access token and new password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Use the access token to set the user context, then update password
    const { data: { user }, error: userError } = await supabase.auth.getUser(access_token);
    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired reset token" });
    }

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password,
    });

    if (error) {
      return res.status(400).json({ error: "Authentication failed" });
    }

    res.json({ success: true, message: "Password has been reset successfully" });
  });

  // Exchange OAuth tokens (handles redirect from Supabase after Google sign-in)
  app.post("/api/auth/callback", async (req: Request, res: Response) => {
    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { access_token, refresh_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: "Access token required" });
    }

    try {
      // Verify the token and get the user
      const { data: { user }, error } = await supabase.auth.getUser(access_token);
      if (error || !user) {
        return res.status(401).json({ error: "Invalid token from OAuth callback" });
      }

      // Seed data for brand-new users (first-time Google sign-in creates a new account)
        setStorageUserId(user.id);
        await seedStorageIfEmpty();

      res.json({
        user: { id: user.id, email: user.email },
        session: {
          access_token,
          refresh_token,
          expires_at: null, // Will be refreshed as needed
        },
      });
    } catch (err: any) {
      console.error("OAuth callback error:", err);
      return res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  // Check if auth is required (helps frontend decide to show login)
  app.get("/api/auth/config", async (_req: Request, res: Response) => {
    res.json({
      authRequired: isSupabaseStorage(),
      supabaseUrl: process.env.VITE_SUPABASE_URL || null,
      supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || null,
    });
  });
}
