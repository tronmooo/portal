import type { Request, Response, NextFunction } from "express";

/**
 * Shared security headers middleware — single source of truth for CSP and other security headers.
 * Used by both local dev server (index.ts) and Vercel entry (vercel-entry.ts).
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // HSTS: only in production and only when the request is not localhost.
  // Setting HSTS in dev would force the browser to upgrade http://localhost to
  // https forever and break local dev.
  const host = (req.hostname || req.headers.host || "").toString().split(":")[0];
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (process.env.NODE_ENV === "production" && !isLocal) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // CSP: do NOT block existing inline scripts/styles since the app uses them.
  // Use a permissive policy that still blocks framing + mixed content.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; " +
    "font-src 'self' data: https://fonts.gstatic.com https://api.fontshare.com; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self' https://*.supabase.co https://api.anthropic.com https://api.resend.com https://challenges.cloudflare.com wss://*.supabase.co; " +
    "frame-src https://accounts.google.com https://challenges.cloudflare.com; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "upgrade-insecure-requests"
  );
  next();
}
