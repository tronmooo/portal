// ============================================================
// chat-frontdoor.ts — Hybrid multi-provider front door for chat
// ============================================================
// The main chat agent (ai-engine.ts processMessage) is an Anthropic
// tool-use loop that runs every CRUD operation (logging, reminders,
// updates, deletes) and every read of the user's stored data. That
// loop stays on Claude — it is the reliability-critical path.
//
// This front door sits in front of it and handles ONLY the messages
// that need neither the user's stored data nor any mutation: general
// advice, explanations, brainstorming, drafting, "what should I do
// about X" — the self-contained conversational class. Those get routed
// to the best available model (GPT / Gemini / Claude) via model-router,
// so the OpenAI/Gemini keys actually get used where they shine.
//
// Safety rules baked in:
//   1. Deterministic classifier, biased hard toward the agent. If a
//      message shows ANY mutation or personal-data signal, it goes to
//      the Claude tool-agent — never here. Misrouting toward the agent
//      is harmless; misrouting a data op to a tool-less model is not.
//   2. Off unless a non-Claude provider key is present. With only
//      ANTHROPIC_API_KEY set, behaviour is identical to before.
//   3. Any error returns null → caller falls through to the agent.
//   4. The prompt forbids inventing the user's records, so a routed
//      model can't fabricate balances/entries it cannot see.
// ============================================================

import type Anthropic from "@anthropic-ai/sdk";
import { providerAvailable, selectModels, callModel, type TaskKind } from "./model-router";

// Signals that a message needs the tool-agent: it either changes data
// or asks about the user's own stored records (which require read tools).
// Deliberately broad — false positives just keep a message on Claude.
const AGENT_SIGNAL = new RegExp(
  [
    // mutation verbs
    "\\b(add|log|logged|create|new|update|edit|change|set|delete|remove|clear|rename",
    "|mark|complete|finish|pay|paid|spend|spent|buy|bought|book|schedule|remind|snooze",
    "|track|start|stop|save|upload|attach|link|move|assign|split|merge)\\b",
    // references to the user's own data / app entities
    "|\\b(my|our|mine)\\b",
    "|\\b(task|tasks|todo|reminder|reminders|expense|expenses|spending|budget|bill|bills",
    "|obligation|obligations|income|net worth|networth|balance|balances|asset|assets|liabilit",
    "|tracker|trackers|habit|habits|goal|goals|event|events|calendar|appointment|profile|profiles",
    "|document|documents|receipt|receipts|medication|meds|dose|journal|mood|weight|workout)\\b",
    // read/query intents over that data
    "|\\b(show|list|view|find|search|get|pull up|how much|how many|what's due|whats due|upcoming|due|overdue|remaining|left)\\b",
  ].join(""),
  "i",
);

/**
 * True when the message should go to the Claude tool-agent (mutation or
 * personal-data intent). Biased broad on purpose.
 */
export function needsAgent(message: string): boolean {
  if (!message || !message.trim()) return true; // empty → let the agent handle it
  return AGENT_SIGNAL.test(message);
}

/**
 * The front door only earns its keep when a non-Claude provider is
 * configured — otherwise every path is Claude anyway and we should not
 * add a second code path.
 */
export function frontDoorEnabled(): boolean {
  if (process.env.AI_CHAT_FRONTDOOR === "0") return false; // explicit kill switch
  return providerAvailable("openai") || providerAvailable("gemini");
}

/** Decide whether a message is eligible for the conversational front door. */
export function shouldUseFrontDoor(message: string): boolean {
  return frontDoorEnabled() && !needsAgent(message);
}

const SYSTEM_PROMPT = `You are the built-in assistant for a personal life-management app that covers finances, tasks, health, documents, reminders and more.

This message is a conversational or advisory exchange — the user is NOT asking you to read or change their saved records, so you do not have access to their data in this reply. Follow these rules:
- Be genuinely helpful, specific, and concise. Prefer plain text with light structure.
- NEVER invent the user's personal figures — balances, account totals, specific expenses, task lists, dates, or entries. You cannot see them here.
- If answering well would require their actual stored data, or if they want you to log/update/delete/schedule something, say so briefly and invite them to ask directly (e.g. "show my expenses this month" or "log $12 lunch"), which routes to the tools.
- Keep replies focused; no filler.`;

export interface FrontDoorOptions {
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Reused app Anthropic client, for when the router picks Claude here. */
  anthropicClient?: Anthropic;
  /** Timeout for the completion; defaults to 20s. */
  timeoutMs?: number;
  taskKind?: TaskKind;
}

export interface FrontDoorResult {
  reply: string;
  modelLabel: string;
}

export interface FrontDoorAttempt {
  model: string;
  error?: string;
}

export interface FrontDoorDiag {
  ok: boolean;
  reply?: string;
  modelLabel?: string;
  /** Every provider tried, in order, with the error that knocked it out (if any). */
  attempts: FrontDoorAttempt[];
}

/**
 * Try each available provider in preference order until one produces a reply.
 * A failing top pick (bad key, retired model id, timeout) no longer disables
 * the whole front door — the next provider takes over. Never throws; returns a
 * diagnostic describing exactly what happened.
 */
export async function runFrontDoorDiag(opts: FrontDoorOptions): Promise<FrontDoorDiag> {
  // Conversational replies favour SPEED by default — a quick advice/explanation
  // answer from Gemini Flash / GPT-mini beats waiting on the heaviest model.
  // Set AI_FRONTDOOR_TIER=reasoning to prefer the strongest model instead.
  const envTier = process.env.AI_FRONTDOOR_TIER;
  const defaultTier: TaskKind = envTier === "reasoning" ? "reasoning" : "fast";
  const { userMessage, history, anthropicClient, timeoutMs = 12_000, taskKind = defaultTier } = opts;

  const specs = selectModels(taskKind);
  const attempts: FrontDoorAttempt[] = [];
  if (specs.length === 0) return { ok: false, attempts };

  // Fold a short history tail into the user turn so follow-ups keep context
  // without adopting each provider's multi-turn message schema.
  const recent = (history || []).slice(-6);
  const historyText = recent
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").slice(0, 800)}`)
    .join("\n");
  const user = historyText
    ? `Conversation so far:\n${historyText}\n\nUser: ${userMessage}`
    : userMessage;

  for (const spec of specs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const text = await callModel({
        spec,
        system: SYSTEM_PROMPT,
        user,
        maxTokens: 1024,
        signal: ac.signal,
        anthropicClient,
      });
      const reply = (text || "").trim();
      if (!reply) {
        attempts.push({ model: spec.label, error: "empty reply" });
        continue;
      }
      attempts.push({ model: spec.label });
      return { ok: true, reply, modelLabel: spec.label, attempts };
    } catch (e: any) {
      const msg = String(e?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e?.message || e).slice(0, 200);
      attempts.push({ model: spec.label, error: msg });
      // eslint-disable-next-line no-console
      console.warn(`[frontdoor] ${spec.label} failed: ${msg} — trying next provider`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, attempts };
}

/**
 * Produce a conversational reply from the best available provider (with
 * failover). Returns null on total failure so the caller can fall through to
 * the Claude tool-agent. Never throws.
 */
export async function runFrontDoorReply(opts: FrontDoorOptions): Promise<FrontDoorResult | null> {
  const diag = await runFrontDoorDiag(opts);
  if (diag.ok && diag.reply && diag.modelLabel) {
    return { reply: diag.reply, modelLabel: diag.modelLabel };
  }
  return null;
}
