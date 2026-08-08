/**
 * Server-side Stripe configuration for Financial Connections.
 *
 * SECURITY CONTRACT
 * -----------------
 *   * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and SUPABASE_SERVICE_ROLE_KEY
 *     are read HERE and nowhere else that could reach a bundle. Nothing in this
 *     file is importable from `client/` — the Vite build has no path to it.
 *   * The only value ever handed to the browser is the PUBLISHABLE key, and
 *     only through `publishableKeyForClient()`, which refuses to return
 *     anything that does not start with `pk_`. A misconfiguration that put a
 *     secret key in the publishable slot fails closed instead of leaking it.
 *   * `assertStripeConfigured()` throws a typed configuration error so routes
 *     answer with a clean "not configured" state instead of a 500 with a stack.
 *
 * ENVIRONMENT NAMING
 * ------------------
 * Portol is a Vite + Express app, not Next.js, and its existing convention is
 * `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for public values with the
 * client fetching them from `/api/auth/config` rather than inlining them at
 * build time. Stripe follows the same pattern:
 *
 *   STRIPE_SECRET_KEY            (required, server only)
 *   STRIPE_WEBHOOK_SECRET        (required for webhooks, server only)
 *   STRIPE_PUBLISHABLE_KEY       (required, served to the client at runtime)
 *   VITE_SUPABASE_URL            (existing)
 *   VITE_SUPABASE_ANON_KEY       (existing)
 *   SUPABASE_SERVICE_ROLE_KEY    (existing, server only)
 *
 * `VITE_STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` are
 * accepted as aliases so a key copied from other tooling still works.
 */

import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSharedSupabaseClient } from "./supabase-storage";

/** Thrown when a required server secret is missing or malformed. */
export class FinanceConfigError extends Error {
  readonly code: string;
  readonly statusCode = 503;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FinanceConfigError";
    this.code = code;
  }
}

/**
 * Read an environment variable, tolerating the casing a human actually typed.
 *
 * Exact match wins. Failing that we scan case-insensitively, because a hosting
 * dashboard is a free-text box and `Stripe_Publishable_key` is a completely
 * reasonable thing to type — but `process.env` is case-sensitive on Linux, so
 * the server would report itself unconfigured while the value sat right there.
 * That failure is invisible and maddening to debug.
 *
 * Safety: this only widens NAME matching, never what a value is allowed to be.
 * The publishable key still has to start with `pk_` before it can reach a
 * browser, so a mis-named secret cannot leak through this path.
 */
function env(name: string): string | undefined {
  const exact = process.env[name];
  if (exact && exact.trim()) return exact.trim();

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === wanted && value && value.trim()) return value.trim();
  }
  return undefined;
}

/** First non-empty of several accepted names. */
function envAny(...names: string[]): string | undefined {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
}

// Accepted spellings for the webhook signing secret. Stripe's own dashboard
// labels this value "Signing secret", so naming the variable after the label is
// the natural thing to do — accept it rather than fail with a message that
// points at a different name than the one the user was shown.
const WEBHOOK_SECRET_NAMES = [
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SIGNING_SECRET",
  "STRIPE_WEBHOOK_SIGNING_SECRET",
];

const PUBLISHABLE_KEY_NAMES = [
  "STRIPE_PUBLISHABLE_KEY",
  "VITE_STRIPE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
];

// ── Publishable key ─────────────────────────────────────────────────────────

export function publishableKeyForClient(): string | null {
  const raw = envAny(...PUBLISHABLE_KEY_NAMES);
  if (!raw) return null;
  // Fail closed: only a real publishable key may cross to the browser. If
  // someone pastes sk_live_… here we return null rather than leak it.
  if (!raw.startsWith("pk_")) {
    console.error(
      "[stripe-config] STRIPE_PUBLISHABLE_KEY does not start with 'pk_' — refusing to send it to the client.",
    );
    return null;
  }
  return raw;
}

// ── Configuration status (safe to expose) ───────────────────────────────────

export interface StripeConfigStatus {
  /** Everything needed to run the connect flow is present. */
  configured: boolean;
  /** Webhooks can be verified. Connect still works without this; syncs are just manual. */
  webhooksConfigured: boolean;
  /** True when the secret key is a live key. Drives the "test mode" banner. */
  livemode: boolean;
  publishableKey: string | null;
  /** Names of the missing variables. Names only — never values. */
  missing: string[];
}

export function stripeConfigStatus(): StripeConfigStatus {
  const secret = env("STRIPE_SECRET_KEY");
  const webhook = envAny(...WEBHOOK_SECRET_NAMES);
  const publishable = publishableKeyForClient();

  const missing: string[] = [];
  if (!secret) missing.push("STRIPE_SECRET_KEY");
  if (!publishable) missing.push("STRIPE_PUBLISHABLE_KEY");
  if (!webhook) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!env("VITE_SUPABASE_URL")) missing.push("VITE_SUPABASE_URL");
  if (!env("SUPABASE_SERVICE_ROLE_KEY")) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  return {
    // The connect flow needs the two Stripe keys plus a database to write to.
    // A missing webhook secret degrades to manual-refresh-only, not "broken".
    configured: !!secret && !!publishable && !!env("VITE_SUPABASE_URL") && !!env("SUPABASE_SERVICE_ROLE_KEY"),
    webhooksConfigured: !!webhook,
    livemode: !!secret?.startsWith("sk_live_"),
    publishableKey: publishable,
    missing,
  };
}

/**
 * Throw a clear, typed configuration error when the server cannot talk to
 * Stripe. Callers turn this into a 503 with a `not_configured` code — the user
 * sees "bank connections aren't set up", never a stack trace.
 */
export function assertStripeConfigured(): void {
  const status = stripeConfigStatus();
  if (status.configured) return;
  const missing = status.missing.filter((m) => m !== "STRIPE_WEBHOOK_SECRET");
  throw new FinanceConfigError(
    "not_configured",
    `Stripe Financial Connections is not configured. Missing server environment ${
      missing.length === 1 ? "variable" : "variables"
    }: ${missing.join(", ")}.`,
  );
}

export function assertWebhookConfigured(): string {
  const secret = envAny(...WEBHOOK_SECRET_NAMES);
  if (!secret) {
    throw new FinanceConfigError(
      "not_configured",
      "Stripe webhooks are not configured. Missing server environment variable: STRIPE_WEBHOOK_SECRET.",
    );
  }
  return secret;
}

// ── Stripe client ───────────────────────────────────────────────────────────

let _stripe: Stripe | null = null;
let _stripeKeyFingerprint: string | null = null;

/**
 * The shared Stripe client for this warm container.
 *
 * Rebuilt if the key changes (only happens in tests). `maxNetworkRetries`
 * covers Stripe's own transient 5xx / connection resets; combined with the
 * idempotency keys the sync service passes on writes, a retry can never
 * double-apply anything.
 */
export function getStripe(): Stripe {
  assertStripeConfigured();
  const key = env("STRIPE_SECRET_KEY")!;
  const fingerprint = key.slice(0, 12) + ":" + key.length;
  if (_stripe && _stripeKeyFingerprint === fingerprint) return _stripe;
  _stripe = new Stripe(key, {
    // Pinning is deliberate: webhook event names and object shapes are tied to
    // the API version, and this is the version the installed SDK generates
    // types for. Bumping the SDK and this string must happen together.
    apiVersion: "2026-07-29.dahlia",
    maxNetworkRetries: 2,
    timeout: 25_000,
    appInfo: { name: "Portol", url: "https://portol.me" },
  });
  _stripeKeyFingerprint = fingerprint;
  return _stripe;
}

/** Test seam — drops the memoized client so a test can swap the key. */
export function resetStripeClient(): void {
  _stripe = null;
  _stripeKeyFingerprint = null;
}

// ── Supabase service-role client (server-only) ──────────────────────────────

/**
 * Service-role Supabase client for finance tables.
 *
 * The service role bypasses RLS, which is exactly why it may only be used from
 * trusted server code that has ALREADY verified the caller's JWT and is
 * filtering by the verified `user_id`. Every query in server/finance-sync.ts
 * and server/finance-routes.ts carries an explicit `.eq("user_id", userId)`.
 */
export function getFinanceDb(): SupabaseClient {
  const url = env("VITE_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new FinanceConfigError(
      "not_configured",
      "Supabase is not configured. Missing server environment variables: " +
        [!url && "VITE_SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean).join(", "),
    );
  }
  try {
    return getSharedSupabaseClient(url, key);
  } catch {
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
}

// ── Error redaction ─────────────────────────────────────────────────────────

/**
 * Map any thrown error onto a stable Portol error code.
 *
 * The code is all the browser ever sees. Raw Stripe messages can contain
 * account ids, request ids and institution internals, so they stay in the
 * server log (see `logFinanceError`) and never travel to the client.
 */
export function classifyStripeError(err: unknown): { code: string; retryable: boolean } {
  if (err instanceof FinanceConfigError) return { code: err.code, retryable: false };

  const anyErr = err as any;
  const type = anyErr?.type ?? anyErr?.rawType;
  const statusCode = Number(anyErr?.statusCode ?? anyErr?.status);
  const stripeCode = String(anyErr?.code ?? "");
  const message = String(anyErr?.message ?? "");

  if (type === "StripeRateLimitError" || statusCode === 429) return { code: "rate_limited", retryable: true };
  if (type === "StripeConnectionError" || type === "StripeAPIError" || statusCode >= 500) {
    return { code: "stripe_unavailable", retryable: true };
  }
  if (type === "StripeAuthenticationError") return { code: "not_configured", retryable: false };

  if (/account_inactive|inactive/i.test(stripeCode)) return { code: "account_inactive", retryable: false };
  if (/relink|reauth/i.test(stripeCode + message)) return { code: "relink_required", retryable: false };
  if (/permission/i.test(stripeCode + message)) return { code: "no_transaction_permission", retryable: false };

  // Supabase / PostgREST failures surface as objects with a `code` like "23505".
  if (anyErr?.code && /^\d{5}$/.test(String(anyErr.code))) return { code: "storage_unavailable", retryable: true };

  return { code: "unknown", retryable: false };
}

/**
 * Log a finance failure with enough detail to debug and nothing that could
 * leak a secret. Deliberately does NOT log request bodies, tokens, or the
 * institution's own error payloads.
 */
export function logFinanceError(context: string, err: unknown, meta: Record<string, unknown> = {}): string {
  const { code } = classifyStripeError(err);
  const anyErr = err as any;
  console.error(
    "[finance]",
    JSON.stringify({
      context,
      code,
      // Stripe's request id is safe and is the fastest way to find the call in
      // the Stripe dashboard.
      requestId: anyErr?.requestId ?? null,
      statusCode: anyErr?.statusCode ?? null,
      message: String(anyErr?.message ?? "").slice(0, 300),
      ...meta,
    }),
  );
  return code;
}
