// ── Bounded Anthropic clients ────────────────────────────────────────────────
//
// Production audit 2026-07-29 (blocker #3): 195 requests timed out after 60s
// on Vercel `/api`. Every `new Anthropic({ apiKey })` in this codebase used the
// SDK's DEFAULTS, which are wildly larger than any of our platform budgets:
//
//   * default timeout    = 10 minutes
//   * default maxRetries = 2
//
// So a single slow or wedged upstream call could occupy the entire 60s
// function budget — and then be retried twice more — while the platform killed
// the request at 60s. The user got a hard timeout instead of a fast, honest
// error, and the work was silently lost.
//
// The fix is to give every call site an explicit, platform-aware budget. The
// two presets below correspond to the two serverless functions in vercel.json:
//
//   api/index.js  maxDuration 60   → "standard"  (default)
//   api/ai.js     maxDuration 300  → "extended"
//
// A budget is chosen so that the WORST CASE (timeout × attempts) still lands
// inside the platform limit with room for the surrounding request work — an
// external call must never be the thing that trips the platform timeout.
import Anthropic from "@anthropic-ai/sdk";

export type CallBudget = "standard" | "extended";

/** Read a positive integer env override, or fall back. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Per-attempt timeout and retry budget for each preset.
 *
 * standard: 22s × 2 attempts = 44s worst case, inside the 60s /api limit with
 *           ~16s of headroom for auth, database reads and serialization.
 * extended: 90s × 2 attempts = 180s worst case, inside the 300s /api/ai limit.
 *           The chat tool-loop makes SEVERAL sequential calls under this
 *           budget, which is why it is not simply "300s minus a bit".
 */
export function budgetFor(budget: CallBudget): { timeout: number; maxRetries: number } {
  if (budget === "extended") {
    return {
      timeout: envMs("ANTHROPIC_TIMEOUT_EXTENDED_MS", 90_000),
      maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES ?? 1),
    };
  }
  return {
    timeout: envMs("ANTHROPIC_TIMEOUT_MS", 22_000),
    maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES ?? 1),
  };
}

const clients = new Map<CallBudget, Anthropic>();

/**
 * A shared, bounded Anthropic client. Reused per budget so we are not building
 * a fresh HTTP agent (and throwing away keep-alive connections) on every
 * request — repeated client construction was itself adding connection-setup
 * latency to each call.
 *
 * Throws when ANTHROPIC_API_KEY is unset, matching the previous behaviour of
 * the individual call sites.
 */
export function getAnthropicClient(budget: CallBudget = "standard"): Anthropic {
  const cached = clients.get(budget);
  if (cached) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }
  const { timeout, maxRetries } = budgetFor(budget);
  const client = new Anthropic({ apiKey, timeout, maxRetries });
  clients.set(budget, client);
  return client;
}

/** Test seam — drops the memoized clients so env overrides take effect. */
export function resetAnthropicClients(): void {
  clients.clear();
}
