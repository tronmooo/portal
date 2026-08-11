/**
 * Sentry Error Tracking — Stub
 * 
 * Already wired: initSentry() runs in server/index.ts and server/vercel-entry.ts,
 * and the global error handler in server/routes.ts reports through captureError().
 * To activate real reporting:
 * 1. npm install @sentry/node
 * 2. Set SENTRY_DSN environment variable
 * 3. Uncomment the @sentry/node lines below
 */

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[Sentry] No SENTRY_DSN set — error tracking disabled");
    return;
  }
  
  try {
    // Uncomment when @sentry/node is installed:
    // const Sentry = require("@sentry/node");
    // Sentry.init({ dsn, environment: process.env.NODE_ENV || "development", tracesSampleRate: 0.1 });
    console.log("[Sentry] Error tracking initialized");
  } catch (e) {
    console.warn("[Sentry] Failed to initialize:", e);
  }
}

export function captureError(error: Error, context?: Record<string, any>) {
  console.error("[Error]", error.message, context || "");
  // Uncomment when @sentry/node is installed:
  // try { require("@sentry/node").captureException(error, { extra: context }); } catch {}
}
