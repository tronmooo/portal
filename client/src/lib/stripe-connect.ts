/**
 * Browser-side Stripe.js loader for Financial Connections.
 *
 * The browser only ever holds:
 *   - the PUBLISHABLE key, fetched at runtime from `/api/finance/config`
 *   - a session CLIENT SECRET, minted server-side per connect attempt
 *
 * It never sees the Stripe secret key or the webhook secret, and it never
 * receives the user's bank credentials: those are typed into the institution's
 * own page inside Stripe's hosted modal, which runs in Stripe's origin. Portol
 * has no access to that iframe's contents and does not want any.
 *
 * The publishable key is fetched rather than baked in at build time so the same
 * bundle can run against test and live Stripe accounts — matching how the app
 * already fetches Supabase config from `/api/auth/config`.
 */

import type { Stripe } from "@stripe/stripe-js";
import { apiRequest } from "./queryClient";

export interface FinanceConfig {
  configured: boolean;
  webhooksConfigured: boolean;
  livemode: boolean;
  publishableKey: string | null;
  missing: string[];
}

let configPromise: Promise<FinanceConfig> | null = null;
let stripePromise: Promise<Stripe | null> | null = null;

export async function getFinanceConfig(force = false): Promise<FinanceConfig> {
  if (force) configPromise = null;
  if (!configPromise) {
    configPromise = apiRequest("GET", "/api/finance/config")
      .then((r) => r.json())
      .catch(() => ({
        configured: false, webhooksConfigured: false, livemode: false,
        publishableKey: null, missing: [],
      }));
  }
  return configPromise;
}

/**
 * Load Stripe.js on demand.
 *
 * Deliberately a dynamic import: `@stripe/stripe-js` pulls a script from
 * js.stripe.com, and a user who never opens bank connections should not pay for
 * that on first paint. Returns null when the server has no publishable key, so
 * callers render the "not configured" state instead of throwing.
 */
export async function getStripeJs(): Promise<Stripe | null> {
  if (stripePromise) return stripePromise;
  stripePromise = (async () => {
    const config = await getFinanceConfig();
    if (!config.publishableKey) return null;
    const { loadStripe } = await import("@stripe/stripe-js");
    return loadStripe(config.publishableKey);
  })();
  return stripePromise;
}

/** Reset memoized state — used after sign-out so a new user re-reads config. */
export function resetStripeJs(): void {
  configPromise = null;
  stripePromise = null;
}

export type ConnectOutcome =
  | { kind: "completed"; sessionId: string; accountCount: number }
  | { kind: "cancelled" }
  | { kind: "error"; code: string };

/**
 * Run the whole connect flow:
 *   1. ask the server for a session (server picks the account holder — the
 *      browser cannot name a user),
 *   2. open Stripe's hosted modal so the user picks their institution, signs in
 *      at the institution, and chooses which accounts to share,
 *   3. tell the server which session finished so it can import server-side.
 *
 * Cancellation is a first-class outcome, not an error: Stripe resolves with an
 * empty account list when the user closes the modal, and we surface that as
 * `cancelled` so the UI can leave the loading state instead of hanging.
 */
export async function runConnectFlow(): Promise<ConnectOutcome> {
  let sessionId: string | null = null;
  try {
    const stripe = await getStripeJs();
    if (!stripe) return { kind: "error", code: "not_configured" };

    const sessionRes = await apiRequest("POST", "/api/finance/connections/session", {});
    const session = await sessionRes.json();
    if (!session?.clientSecret) {
      return { kind: "error", code: session?.code || "not_configured" };
    }
    sessionId = session.sessionId;

    const result = await stripe.collectFinancialConnectionsAccounts({
      clientSecret: session.clientSecret,
    });

    if (result.error) {
      // Stripe surfaces user-facing failures here (institution down, login
      // failed). We map to a code; the message the user reads comes from our
      // own table so no raw Stripe text reaches the UI.
      await cancelPendingConnection();
      return { kind: "error", code: mapStripeJsError(result.error) };
    }

    const accounts = result.financialConnectionsSession?.accounts ?? [];
    if (accounts.length === 0) {
      // Closed the modal without linking anything.
      await cancelPendingConnection();
      return { kind: "cancelled" };
    }

    const completeRes = await apiRequest("POST", "/api/finance/connections/complete", {
      sessionId: session.sessionId,
    });
    const completed = await completeRes.json();
    return {
      kind: "completed",
      sessionId: session.sessionId,
      accountCount: completed?.accountCount ?? accounts.length,
    };
  } catch (err: any) {
    // The server already redacted anything sensitive; recover the code it sent.
    const code = extractCode(err?.message);
    if (sessionId) await cancelPendingConnection();
    return { kind: "error", code };
  }
}

/** Clear the server-side "connecting" row so Settings never sticks mid-flow. */
async function cancelPendingConnection(): Promise<void> {
  try { await apiRequest("POST", "/api/finance/connections/cancel", {}); }
  catch { /* best effort — the UI state is already correct */ }
}

function mapStripeJsError(error: { code?: string; message?: string }): string {
  const code = String(error.code ?? "");
  const text = String(error.message ?? "");
  if (/session_expired|expired/i.test(code + text)) return "session_cancelled";
  if (/institution|unavailable|down/i.test(text)) return "institution_unavailable";
  if (/login|credential|password/i.test(text)) return "login_failed";
  if (/mfa|multi.?factor|verification/i.test(text)) return "mfa_required";
  return "unknown";
}

/** apiRequest throws `"<status>: <message>"`; recover our code from the body. */
function extractCode(message: unknown): string {
  const text = String(message ?? "");
  if (/\b429\b|rate/i.test(text)) return "rate_limited";
  if (/\b503\b/.test(text)) return "stripe_unavailable";
  if (/not configured|STRIPE_/i.test(text)) return "not_configured";
  return "unknown";
}
