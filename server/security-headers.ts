import type { Request, Response, NextFunction } from "express";

/**
 * Shared security headers middleware — single source of truth for CSP and other security headers.
 * Used by both local dev server (index.ts) and Vercel entry (vercel-entry.ts).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.anthropic.com",
    "font-src 'self' https://api.fontshare.com https://fonts.gstatic.com",
    "frame-ancestors 'self'",
  ].join("; "));
  next();
}
