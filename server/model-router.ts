// ============================================================
// model-router.ts — Multi-provider model selection
// ============================================================
// Picks the best *available* model for a given task and runs a
// single, non-tool text/JSON completion against whichever provider
// owns that model. Providers are enabled purely by the presence of
// their API key in the environment, so adding a key in Vercel is all
// it takes to bring a provider online — no code change required.
//
// Scope: this router powers the app's "structured decision" surface
// (see ai-decide.ts) — cheap, fast, JSON-only calls like categorising
// an expense or picking the best-matching profile. It deliberately
// does NOT touch the main agentic chat loop in ai-engine.ts, which is
// built on Anthropic's native tool-use protocol and stays on Claude.
//
// Safety: callers (ai-decide) always validate the response and fall
// back to a deterministic result, so routing a task to a provider that
// returns malformed JSON degrades gracefully rather than breaking.
//
// Env:
//   ANTHROPIC_API_KEY   — enables Claude   (already used app-wide)
//   OPENAI_API_KEY      — enables GPT
//   GEMINI_API_KEY      — enables Gemini   (a real key starts with "AIza")
//   AI_ROUTER_DISABLE=1 — force Claude-only, ignore other providers
//   OPENAI_MODEL / OPENAI_MODEL_FAST   — override GPT model ids
//   GEMINI_MODEL / GEMINI_MODEL_FAST   — override Gemini model ids
// ============================================================

import type Anthropic from "@anthropic-ai/sdk";

export type Provider = "anthropic" | "openai" | "gemini";

/**
 * The shape of work being sent to a model. The router maps each kind to
 * the strongest *available* model for that job.
 *   - "reasoning": nuanced multi-step decisions → strongest model.
 *   - "fast" / "extract": cheap, high-volume JSON decisions → fastest model.
 */
export type TaskKind = "reasoning" | "fast" | "extract";

export interface ModelSpec {
  provider: Provider;
  /** Provider-native model id passed straight to the API. */
  model: string;
  /** Human label for logs. */
  label: string;
}

// --- Model ids -------------------------------------------------------------
// Defaults are conservative, known-good ids; every non-Anthropic id is
// env-overridable so a newer/renamed model can be adopted without a deploy.
// The Anthropic ids intentionally match the ones already used across the app.
const ANTHROPIC_REASONING = "claude-sonnet-4-6";
const ANTHROPIC_FAST = "claude-haiku-4-5-20251001";

function openaiModel(kind: TaskKind): string {
  return kind === "reasoning"
    ? process.env.OPENAI_MODEL || "gpt-4o"
    : process.env.OPENAI_MODEL_FAST || "gpt-4o-mini";
}
function geminiModel(kind: TaskKind): string {
  return kind === "reasoning"
    ? process.env.GEMINI_MODEL || "gemini-1.5-pro"
    : process.env.GEMINI_MODEL_FAST || "gemini-1.5-flash";
}

// --- Availability ----------------------------------------------------------

export function providerAvailable(p: Provider): boolean {
  if (p === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (process.env.AI_ROUTER_DISABLE === "1") return false;
  if (p === "openai") return !!process.env.OPENAI_API_KEY;
  if (p === "gemini") return !!process.env.GEMINI_API_KEY;
  return false;
}

// Preference order per task kind — first *available* provider wins.
// Anthropic is the guaranteed fallback and appears in every list because
// it is the provider the rest of the app depends on.
const PREFERENCE: Record<TaskKind, Provider[]> = {
  // Strongest reasoning first. Claude Sonnet leads (the app is Claude-native
  // and it is the proven reasoner here), with GPT / Gemini Pro as alternates.
  reasoning: ["anthropic", "openai", "gemini"],
  // Cheapest + fastest first. Gemini Flash and GPT-mini are excellent, low-cost
  // choices for high-volume JSON extraction; Claude Haiku backs them up.
  fast: ["gemini", "openai", "anthropic"],
  extract: ["gemini", "openai", "anthropic"],
};

function specFor(provider: Provider, kind: TaskKind): ModelSpec {
  if (provider === "openai") {
    const model = openaiModel(kind);
    return { provider, model, label: `openai:${model}` };
  }
  if (provider === "gemini") {
    const model = geminiModel(kind);
    return { provider, model, label: `gemini:${model}` };
  }
  const model = kind === "reasoning" ? ANTHROPIC_REASONING : ANTHROPIC_FAST;
  return { provider: "anthropic", model, label: `claude:${model}` };
}

/**
 * All available models for a task, in preference order. Callers that want
 * resilience try them in turn — if the top pick's provider errors (e.g. a bad
 * key or a retired model id), the next one takes over. Empty only when no
 * provider is configured at all.
 */
export function selectModels(kind: TaskKind = "fast"): ModelSpec[] {
  const specs: ModelSpec[] = [];
  for (const provider of PREFERENCE[kind]) {
    if (providerAvailable(provider)) specs.push(specFor(provider, kind));
  }
  return specs;
}

/**
 * Choose the single best available model for a task.
 * Always returns a spec — falls back to Claude when no other provider's key
 * is configured. Throws only if not even ANTHROPIC_API_KEY is set.
 */
export function selectModel(kind: TaskKind = "fast"): ModelSpec {
  const specs = selectModels(kind);
  if (specs.length === 0) {
    throw new Error("No AI provider configured (set ANTHROPIC_API_KEY)");
  }
  return specs[0];
}

/** An explicit Anthropic model id (backward-compat) mapped onto a spec. */
export function anthropicSpec(model: string): ModelSpec {
  return { provider: "anthropic", model, label: `claude:${model}` };
}

// --- Completion dispatch ---------------------------------------------------

export interface CompletionRequest {
  spec: ModelSpec;
  system: string;
  user: string;
  maxTokens: number;
  /** Aborts in-flight OpenAI/Gemini fetches when the caller's timeout fires. */
  signal?: AbortSignal;
  /**
   * Anthropic SDK client, injected by the caller so we reuse the app's single
   * lazy-initialised client instead of constructing a second one.
   */
  anthropicClient?: Anthropic;
}

/**
 * Run a single completion against the selected model and return the raw text.
 * Throws on transport/API errors — the caller decides how to fall back.
 */
export async function callModel(req: CompletionRequest): Promise<string> {
  switch (req.spec.provider) {
    case "anthropic":
      return callAnthropic(req);
    case "openai":
      return callOpenAI(req);
    case "gemini":
      return callGemini(req);
  }
}

async function callAnthropic(req: CompletionRequest): Promise<string> {
  if (!req.anthropicClient) throw new Error("anthropicClient not provided to router");
  const resp = await req.anthropicClient.messages.create({
    model: req.spec.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  });
  const block = resp.content.find((b: any) => b.type === "text") as { text?: string } | undefined;
  return (block?.text || "").trim();
}

async function callOpenAI(req: CompletionRequest): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: req.spec.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
    signal: req.signal,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

async function callGemini(req: CompletionRequest): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    req.spec.model,
  )}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: { maxOutputTokens: req.maxTokens },
    }),
    signal: req.signal,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text || "").join("") : "";
  return text.trim();
}
