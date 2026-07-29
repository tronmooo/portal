// ============================================================
// ai-decide.ts — Shared AI routing helper
// ============================================================
// Single entrypoint for "AI makes a structured decision" calls.
// Used by Wave 1-3 of the AI-integration roadmap (see
// /home/user/workspace/portal_ai_integration_plan.md).
//
// Design goals:
//   1. Cheap: defaults to Haiku, low max_tokens.
//   2. Fast: hard timeout (default 4s) with deterministic fallback.
//   3. Strict: JSON-only response, parsed + validated, never throws.
//   4. Observable: every decision logged with reason + duration + fallback flag.
//   5. Safe: never modifies data — caller decides what to do with the result.
//
// Usage:
//
//   const result = await aiDecide<{ categoryId: string; confidence: number }>({
//     task: "categorize-expense",
//     system: "You categorize expenses. Return JSON {categoryId, confidence}.",
//     user: `Description: "${desc}"\nCategories: ${JSON.stringify(cats)}`,
//     fallback: () => keywordMatch(desc, cats),
//     timeoutMs: 3000,
//   });
//
// If AI returns valid JSON in time → result.value is the parsed payload, result.source = "ai".
// If AI times out / errors / returns garbage → result.value is fallback(), result.source = "fallback".
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./anthropic-client";
import { selectModel, anthropicSpec, callModel, type TaskKind } from "./model-router";

// Re-use the engine's lazy client so we don't double-init the SDK.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  // Bounded client (see server/anthropic-client.ts).
  if (!_client) _client = getAnthropicClient("standard");
  return _client;
}

export type AIDecisionSource = "ai" | "fallback" | "ai-invalid-fallback" | "ai-timeout-fallback" | "ai-error-fallback";

export interface AIDecisionResult<T> {
  value: T;
  source: AIDecisionSource;
  durationMs: number;
  reason?: string;
  raw?: string;
}

export interface AIDecideOptions<T> {
  /** Short identifier used in logs (e.g. "categorize-expense", "doc-link-profile"). */
  task: string;
  /** System prompt — describe the role and REQUIRE JSON-only output. */
  system: string;
  /** User prompt — include the actual data + the exact JSON shape expected. */
  user: string;
  /** Synchronous or async fallback called on timeout, parse failure, or API error. MUST NOT throw. */
  fallback: () => T | Promise<T>;
  /** Hard timeout — default 4000ms. Routing decisions should be <3s; defaults to 4s for safety. */
  timeoutMs?: number;
  /** Anthropic model — default Haiku 4.5 (cheapest, fastest). */
  model?: string;
  /** Max output tokens — default 200 (routing decisions are tiny). */
  maxTokens?: number;
  /** Optional validator. Return true if the parsed AI payload is acceptable. If false, fallback is used. */
  validate?: (parsed: unknown) => boolean;
  /** Optional cap on prompt length — if exceeded, skip AI entirely and go straight to fallback. Default 8000 chars. */
  maxPromptChars?: number;
  /**
   * How to route this decision across providers (see model-router.ts).
   * Defaults to "fast" — cheap, high-volume JSON decisions. Use "reasoning"
   * for nuanced calls that deserve the strongest available model.
   * Ignored when `model` is set explicitly (that forces a specific Claude model).
   */
  taskKind?: TaskKind;
}

/**
 * Run an AI-backed structured decision with a deterministic fallback.
 * Never throws — callers can rely on result.value always being a T.
 */
export async function aiDecide<T>(opts: AIDecideOptions<T>): Promise<AIDecisionResult<T>> {
  const {
    task,
    system,
    user,
    fallback,
    timeoutMs = 4000,
    model,
    maxTokens = 200,
    validate,
    maxPromptChars = 8000,
    taskKind = "fast",
  } = opts;

  const t0 = Date.now();
  const runFallback = async (source: AIDecisionSource, reason: string, raw?: string): Promise<AIDecisionResult<T>> => {
    let value: T;
    try { value = await fallback(); } catch (e: any) {
      // Fallback itself failed — extremely defensive. Log and rethrow because there's
      // no third tier and the caller asked us to never return undefined.
      console.error(`[aiDecide:${task}] FALLBACK THREW — ${e?.message || e}`);
      throw e;
    }
    const durationMs = Date.now() - t0;
    console.log(`[aiDecide:${task}] source=${source} duration=${durationMs}ms reason="${reason}"`);
    return { value, source, durationMs, reason, raw };
  };

  // Prompt too big — go straight to fallback (e.g. >200 candidate docs).
  if (system.length + user.length > maxPromptChars) {
    return runFallback("fallback", `prompt too long (${system.length + user.length} > ${maxPromptChars})`);
  }

  // Pick the model. An explicit `model` forces that specific Claude model
  // (backward-compat for callers that hand-picked one); otherwise the router
  // chooses the best available provider for this taskKind, always with Claude
  // as the guaranteed fallback.
  let spec;
  try {
    spec = model ? anthropicSpec(model) : selectModel(taskKind);
  } catch (e: any) {
    return runFallback("ai-error-fallback", `no provider available: ${e?.message || e}`);
  }

  // The Anthropic path reuses the app's single lazy SDK client; other
  // providers go over HTTP and don't need it.
  let anthropicClient: Anthropic | undefined;
  if (spec.provider === "anthropic") {
    try { anthropicClient = getClient(); }
    catch (e: any) { return runFallback("ai-error-fallback", `client init failed: ${e?.message || e}`); }
  }

  // Race API call vs timeout. The AbortController lets us cancel in-flight
  // HTTP requests to OpenAI/Gemini once the timeout wins.
  let raw = "";
  const ac = new AbortController();
  try {
    const aiPromise = callModel({ spec, system, user, maxTokens, signal: ac.signal, anthropicClient });
    const timeoutPromise = new Promise<null>(resolve =>
      setTimeout(() => resolve(null), timeoutMs)
    );
    const resp = await Promise.race([aiPromise, timeoutPromise]);
    if (resp === null) {
      ac.abort();
      return runFallback("ai-timeout-fallback", `timed out after ${timeoutMs}ms via ${spec.label}`);
    }

    raw = (resp || "").trim();
    if (!raw) return runFallback("ai-invalid-fallback", `empty AI response from ${spec.label}`, raw);

    // Strip ```json fences if model wrapped output despite instructions.
    let jsonText = raw;
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); }
    catch (e: any) {
      // Last-ditch: find first {...} or [...] in the text.
      const objMatch = jsonText.match(/[\{\[][\s\S]*[\}\]]/);
      if (!objMatch) return runFallback("ai-invalid-fallback", `JSON parse failed: ${e?.message || e}`, raw);
      try { parsed = JSON.parse(objMatch[0]); }
      catch (e2: any) { return runFallback("ai-invalid-fallback", `JSON parse failed twice: ${e2?.message || e2}`, raw); }
    }

    if (validate && !validate(parsed)) {
      return runFallback("ai-invalid-fallback", "validator rejected parsed payload", raw);
    }

    const durationMs = Date.now() - t0;
    console.log(`[aiDecide:${task}] source=ai model=${spec.label} duration=${durationMs}ms ok`);
    return { value: parsed as T, source: "ai", durationMs, raw };
  } catch (e: any) {
    return runFallback("ai-error-fallback", `API call failed: ${e?.message || e}`, raw);
  }
}

/**
 * Specialised helper for the very common "pick one item from a list" decision.
 * Returns the picked index (or -1 if AI declines / fallback returns -1).
 *
 * Example:
 *   const pick = await aiPickIndex({
 *     task: "expense-category",
 *     question: "Which category does this expense belong to?",
 *     context: `Description: "Whole Foods $42.18"`,
 *     options: categories.map(c => c.name),
 *     fallback: () => keywordMatchIndex(desc, categories),
 *   });
 */
export interface AIPickIndexOptions {
  task: string;
  question: string;
  context: string;
  options: string[];
  fallback: () => number | Promise<number>;
  timeoutMs?: number;
  model?: string;
  /** Routing hint across providers (see model-router.ts). Defaults to "fast". */
  taskKind?: TaskKind;
  /** Minimum confidence (0-1) the AI must self-report; below this → fallback. Default 0.5. */
  minConfidence?: number;
}

export async function aiPickIndex(opts: AIPickIndexOptions): Promise<AIDecisionResult<{ index: number; confidence: number; reason: string }>> {
  const optionsList = opts.options.map((o, i) => `${i}. ${o}`).join("\n");
  return aiDecide<{ index: number; confidence: number; reason: string }>({
    task: opts.task,
    system: `You are a routing decision-maker. Read the context, then pick the single best option from the numbered list.

Respond with ONLY a JSON object — no markdown, no prose. Schema:
{"index": <number 0..${opts.options.length - 1} or -1 if none fit>, "confidence": <0.0..1.0>, "reason": "<one short sentence>"}

If no option fits, return index -1 with low confidence.`,
    user: `${opts.question}

CONTEXT:
${opts.context}

OPTIONS:
${optionsList}

Return JSON only.`,
    fallback: async () => {
      const idx = await opts.fallback();
      return { index: idx, confidence: idx >= 0 ? 0.4 : 0, reason: "deterministic fallback" };
    },
    timeoutMs: opts.timeoutMs,
    model: opts.model,
    taskKind: opts.taskKind,
    maxTokens: 120,
    validate: (p: any) => {
      if (!p || typeof p !== "object") return false;
      if (typeof p.index !== "number") return false;
      if (p.index !== -1 && (p.index < 0 || p.index >= opts.options.length)) return false;
      if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) return false;
      if (opts.minConfidence != null && p.confidence < opts.minConfidence) return false;
      return true;
    },
  });
}
