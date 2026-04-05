/**
 * Sentry Error Tracking — Stub
 * 
 * To activate:
 * 1. npm install @sentry/node
 * 2. Set SENTRY_DSN environment variable
 * 3. Import and call initSentry() in server/index.ts before app setup
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
