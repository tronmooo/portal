// ── Bounded external-call budgets (server/anthropic-client.ts) ───────────────
// Production audit 2026-07-29, blocker #3: 195 requests timed out after 60s on
// Vercel /api. Every Anthropic client was built with the SDK defaults — a
// 10-minute timeout and 2 retries — so a single wedged upstream call could
// outlive the platform limit many times over.
//
// These tests pin the invariant that actually matters: the WORST-CASE time an
// external call can occupy (per-attempt timeout × total attempts) must stay
// inside the maxDuration declared for the function it runs on in vercel.json.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { budgetFor, getAnthropicClient, resetAnthropicClients } from "../server/anthropic-client";

/** maxDuration (seconds) declared per serverless function in vercel.json. */
function vercelMaxDurations(): Record<string, number> {
  const cfg = JSON.parse(readFileSync(join(__dirname, "..", "vercel.json"), "utf8"));
  const out: Record<string, number> = {};
  for (const [fn, conf] of Object.entries<any>(cfg.functions || {})) {
    out[fn] = Number(conf.maxDuration);
  }
  return out;
}

const worstCaseMs = (b: { timeout: number; maxRetries: number }) => b.timeout * (1 + b.maxRetries);

describe("Anthropic call budgets", () => {
  const saved = { ...process.env };
  beforeEach(() => { resetAnthropicClients(); });
  afterEach(() => { process.env = { ...saved }; resetAnthropicClients(); });

  it("vercel.json still declares the two function budgets these presets target", () => {
    const durations = vercelMaxDurations();
    expect(durations["api/index.js"]).toBe(60);
    expect(durations["api/ai.js"]).toBe(300);
  });

  it("standard worst case fits inside the 60s /api budget with headroom", () => {
    const b = budgetFor("standard");
    const limitMs = vercelMaxDurations()["api/index.js"] * 1000;
    expect(worstCaseMs(b)).toBeLessThan(limitMs);
    // Leave room for auth, database reads and serialization around the call.
    expect(worstCaseMs(b)).toBeLessThanOrEqual(limitMs * 0.8);
  });

  it("extended worst case fits inside the 300s /api/ai budget", () => {
    const b = budgetFor("extended");
    const limitMs = vercelMaxDurations()["api/ai.js"] * 1000;
    expect(worstCaseMs(b)).toBeLessThan(limitMs);
    // The chat tool-loop makes several sequential calls per turn, so one call
    // must not be able to eat the whole function budget.
    expect(worstCaseMs(b)).toBeLessThanOrEqual(limitMs * 0.7);
  });

  it("never falls back to the SDK's unbounded 10-minute default", () => {
    for (const preset of ["standard", "extended"] as const) {
      const b = budgetFor(preset);
      expect(b.timeout).toBeGreaterThan(0);
      expect(b.timeout).toBeLessThan(600_000);
      expect(b.maxRetries).toBeLessThanOrEqual(2);
    }
  });

  it("applies the budget to the constructed client and reuses it per preset", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    const a = getAnthropicClient("standard");
    const b = getAnthropicClient("standard");
    expect(a).toBe(b); // memoized — no new HTTP agent per request
    expect((a as any).timeout).toBe(budgetFor("standard").timeout);
    expect((a as any).maxRetries).toBe(budgetFor("standard").maxRetries);
    expect(getAnthropicClient("extended")).not.toBe(a);
  });

  it("honours env overrides but keeps them bounded", () => {
    process.env.ANTHROPIC_TIMEOUT_MS = "15000";
    expect(budgetFor("standard").timeout).toBe(15_000);
    // Junk values fall back to the safe default rather than disabling the bound.
    process.env.ANTHROPIC_TIMEOUT_MS = "not-a-number";
    expect(budgetFor("standard").timeout).toBe(22_000);
    process.env.ANTHROPIC_TIMEOUT_MS = "-5";
    expect(budgetFor("standard").timeout).toBe(22_000);
  });

  it("throws a clear error when the API key is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
  });
});
