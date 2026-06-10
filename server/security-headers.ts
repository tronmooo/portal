import type { Request, Response, NextFunction } from "express";

/**
 * S6: Origin-based CSRF protection for mutating endpoints.
 *
 * The app uses bearer-token auth (Authorization header, not cookies), which
 * already mitigates classic CSRF — a malicious cross-origin form can't read
 * tokens from localStorage and can't ride along on a cookie that doesn't
 * exist. This middleware is defense-in-depth in case we ever flip to cookie
 * auth or someone adds a third-party widget that does.
 *
 * Behavior: for any mutating method (POST/PATCH/PUT/DELETE) on /api/*, the
 * Origin (or Referer, for HTTP/1.0 clients) header must match one of the
 * known production hosts. Same-origin browser requests always send Origin.
 * Missing Origin AND missing Referer means it's either a server-side caller
 * (curl, CI) or a deeply broken client — those are allowed since they're
 * not vulnerable to CSRF.
 */
const ALLOWED_HOST_SUFFIXES = [
  "portol.me",
  "localhost",
  "127.0.0.1",
  "vercel.app", // preview deploys
];
export function csrfOriginCheck(req: Request, res: Response, next: NextFunction) {
  const m = req.method.toUpperCase();
  if (m !== "POST" && m !== "PATCH" && m !== "PUT" && m !== "DELETE") return next();
  // Public viewer + auth bootstrap routes are intentionally unauthenticated
  // and can be reached pre-auth from email links etc. Skip the check there.
  if (
    req.path.startsWith("/api/auth/") ||
    req.path.startsWith("/api/public/") ||
    req.path.startsWith("/api/cron/")
  ) return next();
  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  // No browser header at all — not a CSRF vector (no cookies, no auto-attached creds).
  if (!origin && !referer) return next();
  const source = origin || referer;
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    const ok = ALLOWED_HOST_SUFFIXES.some((suf) => host === suf || host.endsWith(`.${suf}`));
    if (!ok) return res.status(403).json({ error: "Cross-origin request denied" });
  } catch {
    return res.status(403).json({ error: "Cross-origin request denied" });
  }
  return next();
}

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
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
}

/**
 * Canonical CSP — the SINGLE source of truth for the policy string.
 *
 * IMPORTANT: this exact string is duplicated verbatim in /vercel.json (the
 * document-route "headers" entry), because index.html is served statically by
 * Vercel and never passes through this Express middleware in production.
 * vercel.json is strict JSON and cannot carry comments, so if you change the
 * policy here you MUST copy the new string into vercel.json (and vice versa).
 * Keep the two literally identical.
 *
 * Policy notes:
 *   - script-src: NO 'unsafe-inline' — all inline scripts in index.html
 *     (service-worker unregister, theme bootstrap) have been externalized.
 *     'unsafe-eval' is KEPT deliberately: Univer (spreadsheet engine) uses
 *     new Function() for formula compilation, and the Capacitor
 *     dynamic-import shim evaluates code at runtime; both break without it.
 *   - style-src: 'unsafe-inline' is KEPT — React sets element style
 *     attributes inline and Tailwind arbitrary-value props generate inline
 *     styles, so nonce-ing/hashing styles is impractical. Accepted tradeoff:
 *     inline-style injection is far lower risk than inline-script injection.
 *   - object-src 'none': no plugins/embeds anywhere in the app.
 *   - worker-src 'self' (+ child-src 'self' as the worker fallback for older
 *     browsers): the service worker is same-origin.
 *   - Google Fonts hosts remain in style-src/font-src even though
 *     Inter/JetBrains Mono are now self-hosted — harmless, and fontshare is
 *     still loaded remotely.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-eval' https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; " +
  "font-src 'self' data: https://fonts.gstatic.com https://api.fontshare.com; " +
  "img-src 'self' data: blob: https:; " +
  "connect-src 'self' https://*.supabase.co https://api.anthropic.com https://api.resend.com https://challenges.cloudflare.com wss://*.supabase.co; " +
  "frame-src https://accounts.google.com https://challenges.cloudflare.com; " +
  "worker-src 'self'; " +
  "child-src 'self'; " +
  "object-src 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "upgrade-insecure-requests";
