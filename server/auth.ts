import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";
import { storage, isSupabaseStorage } from "./storage";

// Rate limiter for auth endpoints (prevents brute force)
const authRateLimitMap = new Map<string, { count: number; resetAt: number }>();
function authRateLimit(key: string, maxRequests: number = 5, windowMs: number = 900000): boolean {
  const now = Date.now();
  const entry = authRateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    authRateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > maxRequests;
}
// Cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of authRateLimitMap.entries()) {
    if (now > val.resetAt) authRateLimitMap.delete(key);
  }
}, 300000);

// Create Supabase clients — anon key for user auth, service role only for admin operations
let supabaseAuth: SupabaseClient | null = null;
let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAuth(): SupabaseClient | null {
  if (supabaseAuth) return supabaseAuth;
  const url = process.env.VITE_SUPABASE_URL;
  // Prefer anon key for token verification (least privilege); fall back to service role
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabaseAuth = createClient(url, key);
  return supabaseAuth;
}

function getSupabaseAdmin(): SupabaseClient | null {
  if (supabaseAdmin) return supabaseAdmin;
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabaseAdmin = createClient(url, key);
  return supabaseAdmin;
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

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = getSupabaseAuth();
  if (!supabase) {
    return res.status(500).json({ error: "Auth not configured" });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token", code: "AUTH_INVALID" });
    }

    // Set user info on request
    req.userId = user.id;
    req.userEmail = user.email;

    // Set the user ID on the storage adapter so queries are scoped
    if ((storage as any).setUserId) {
      (storage as any).setUserId(user.id);
    }

    next();
  } catch (err: any) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ error: "Authentication failed", code: "AUTH_ERROR" });
  }
}

/**
 * Register auth-related API endpoints
 */
export function registerAuthRoutes(app: any) {
  // Sign up with email/password
  app.post("/api/auth/signup", async (req: Request, res: Response) => {
    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (authRateLimit(`signup:${email}`, 3, 900000)) {
      return res.status(429).json({ error: "Too many signup attempts. Please wait 15 minutes." });
    }

    // Admin operations (createUser) require service role key
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(500).json({ error: "Admin auth not configured" });

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for now (no email verification)
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Sign in immediately to get a session
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      return res.status(400).json({ error: signInError.message });
    }

    // Seed data for the new user
    if ((storage as any).setUserId) {
      (storage as any).setUserId(data.user.id);
    }
    if ((storage as any).seedIfEmpty) {
      await (storage as any).seedIfEmpty();
    }

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
    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (authRateLimit(`signin:${email}`, 5, 900000)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes." });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
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

  // Forgot password — sends a reset link email via Supabase
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Validate origin to prevent open redirect — only allow same-origin or configured app URL
    const origin = req.headers.origin;
    const allowedOrigins = [process.env.APP_URL, process.env.VITE_APP_URL].filter(Boolean);
    const safeOrigin = (origin && allowedOrigins.length > 0 && allowedOrigins.includes(origin))
      ? origin
      : (allowedOrigins[0] || `${req.protocol}://${req.get('host')}`);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${safeOrigin}/#/reset-password`,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: "Check your email for a reset link" });
  });

  // Reset password — updates password using the access token from the reset link
  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    const supabase = getSupabaseAuth();
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

    const { access_token, password } = req.body;
    if (!access_token || !password) {
      return res.status(400).json({ error: "Access token and new password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Use the access token to set the user context, then update password
    const { data: { user }, error: userError } = await supabase.auth.getUser(access_token);
    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired reset token" });
    }

    const admin = getSupabaseAdmin();
    if (!admin) return res.status(500).json({ error: "Admin auth not configured" });

    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
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
      if ((storage as any).setUserId) {
        (storage as any).setUserId(user.id);
      }
      if ((storage as any).seedIfEmpty) {
        await (storage as any).seedIfEmpty();
      }

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
