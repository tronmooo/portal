// ─── Door-agnostic mutation outcome ─────────────────────────────────────────
//
// Every write in this app reaches the database through one of a handful of
// DOORS: an AI chat tool, a REST route handler, the document-extraction
// confirm flow, a deterministic chat fast path, or the bulk logger. For years
// only the chat door produced the full post-write contract — read-back
// verification, an ai_action_log row (undo), and a ChatMutation manifest the
// client patches into its caches. Every other door wrote to storage and hoped:
// no undo, no manifest, and its own ad-hoc cache story. That asymmetry is the
// root of a whole class of "the AI/UI said it saved, the page disagrees" bugs.
//
// This module is the shared choke point. A canonical action service (or a
// route handler) wraps its write in `runMutation(...)` and every door gets the
// SAME contract the chat loop pioneered:
//
//   MutationOutcome {
//     ok        — write landed AND read-back confirmed it
//     entity    — { type, id, name } of the affected row
//     mutations — ChatMutation[] for the client cache patch + targeted
//                 invalidation (chat returns them in the turn payload; REST
//                 carries them on the X-Write-Mutations response header)
//     domains   — union of the mutations' cache domains
//     deduped   — the write was folded into an existing row; nothing created
//     envelope  — the full enveloped result (what a chat tool returns to the
//                 model; REST handlers usually ignore it)
//   }
//
// It deliberately REUSES the ai-envelope machinery rather than replacing it:
// finalizeToolResult / recordActionLog / buildChatMutation stay the single
// implementations, this just makes them reachable from every door with the
// door recorded as the ledger row's `source`.
import type { IStorage } from "./storage";
import type { ChatMutation } from "@shared/schema";
import {
  buildTurnVerifyContext,
  captureBeforeRows,
  finalizeToolResult,
  recordActionLog,
  buildChatMutation,
  type TurnVerifyContext,
} from "./ai-envelope";

/** Which door a write came through. Recorded as ai_action_log.source. */
export type MutationDoor = "chat" | "rest" | "extraction" | "fast_path" | "bulk" | "system";

export interface MutationContext {
  storage: IStorage;
  door: MutationDoor;
  /** Shared per-request verify context (memoizes the profile-id set). */
  verify: TurnVerifyContext;
}

/** One context per request/turn so read-backs share the profile-id memo. */
export function beginMutationContext(storage: IStorage, door: MutationDoor): MutationContext {
  return { storage, door, verify: buildTurnVerifyContext(storage) };
}

export interface MutationOutcome {
  ok: boolean;
  /** Human-usable failure description when ok is false. */
  error?: string;
  /** True when the write was folded into an existing row (nothing created). */
  deduped?: boolean;
  entity?: { type: string; id: string; name?: string };
  /** Primary + implied changes, in write order. Empty when nothing changed. */
  mutations: ChatMutation[];
  /** Union of the mutations' cache domains. */
  domains: string[];
  /** The enveloped result (chat tools return this to the model verbatim). */
  envelope: any;
}

export interface RunMutationOptions {
  /**
   * Canonical tool name from the ai-envelope vocabulary (TOOL_ENTITY) — e.g.
   * "create_expense". Doors that aren't chat still name the tool: it is what
   * classifies the operation, selects read-back verification, and keys undo.
   */
  tool: string;
  /** ParsedAction type for the ledger; defaults to the tool name. */
  actionType?: string;
  /** The validated input the write is about to apply (stored for undo/audit). */
  input: Record<string, any>;
  /** The write itself. Returns the raw result (row or tool-result shape). */
  execute: () => Promise<any>;
}

/** Mirror of the chat loop's fallback: a write we can't describe precisely
 *  still tells the client "something changed" rather than nothing. */
function fallbackMutation(tool: string): ChatMutation {
  return { op: "update", entityType: null, domains: ["everything"], tool };
}

function domainUnion(mutations: ChatMutation[]): string[] {
  const set = new Set<string>();
  for (const m of mutations) for (const d of m.domains || []) set.add(d);
  return [...set];
}

/**
 * Run one write through the full post-write contract:
 * before-snapshot → execute → envelope/read-back → ledger → manifest.
 *
 * Semantics intentionally mirror the chat loop's per-tool block
 * (server/ai-engine.ts): an {error} result skips everything downstream; a
 * failed read-back flips ok to false and writes no ledger row; a dedupe
 * writes no ledger row (a create's reverse plan is DELETE — undoing it would
 * destroy the record the user already had) and claims no mutation.
 */
export async function runMutation(ctx: MutationContext, opts: RunMutationOptions): Promise<MutationOutcome> {
  const actionType = opts.actionType || opts.tool;
  const beforeRows = await captureBeforeRows(opts.tool, ctx.verify);

  let rawResult: any;
  try {
    rawResult = await opts.execute();
  } catch (e: any) {
    rawResult = { error: e?.message || "The operation failed." };
  }
  if (!rawResult || rawResult.error) {
    return {
      ok: false,
      error: String(rawResult?.error || "The operation returned nothing."),
      mutations: [],
      domains: [],
      envelope: rawResult,
    };
  }

  const envelope = await finalizeToolResult(opts.tool, actionType, opts.input, rawResult, ctx.verify);

  // Read-back verification failed: the write did not land (or the delete
  // didn't take). finalizeToolResult already flipped success and wrote the
  // human-facing detail into `error`.
  if (envelope && envelope.success === false) {
    return {
      ok: false,
      error: String(envelope.error || envelope.message || "The write could not be confirmed."),
      mutations: [],
      domains: [],
      envelope,
    };
  }

  const deduped = !!(envelope && envelope.deduped === true);
  if (!deduped) {
    await recordActionLog(ctx.verify, opts.tool, actionType, opts.input, envelope, beforeRows, ctx.door);
  }

  const mutation = buildChatMutation(opts.tool, envelope, rawResult) ?? (deduped ? null : fallbackMutation(opts.tool));
  const mutations = mutation ? [mutation] : [];

  return {
    ok: true,
    ...(deduped ? { deduped: true } : {}),
    ...(envelope?.entity ? { entity: envelope.entity } : {}),
    mutations,
    domains: domainUnion(mutations),
    envelope,
  };
}

// ─── REST transport ─────────────────────────────────────────────────────────
// REST responses carry the manifest on a header rather than in the body: it
// works for every route regardless of response shape (arrays, bare
// acknowledgements, deletes with no JSON at all), and it can never collide
// with a field the row legitimately owns. Rows are NOT serialized into the
// header — the response body already carries the row where one exists, and
// the client pairs them back up by id (client/src/lib/write-sync.ts).
export const WRITE_MUTATIONS_HEADER = "x-write-mutations";

/** Header-safe, row-free projection of a mutation list. */
export function mutationsHeaderValue(mutations: ChatMutation[]): string | null {
  if (!Array.isArray(mutations) || mutations.length === 0) return null;
  const slim = mutations.map(({ op, entityType, domains, id, endpoint, tool }) => ({
    op, entityType, domains,
    ...(id ? { id } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(tool ? { tool } : {}),
  }));
  try {
    const value = JSON.stringify(slim);
    // Headers must stay small and ISO-8859-1-safe. Entity ids, domains and
    // endpoints are ASCII by construction; a pathological manifest is dropped
    // rather than risking a broken response.
    if (value.length > 4096 || /[^\x20-\x7e]/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Stash a request's outcome mutations for the response. The write barrier
 * middleware (server/routes.ts) reads res.locals.writeMutations as it sends
 * the response and sets the header — handlers just record what they did.
 */
export function noteWriteMutations(res: { locals?: any }, mutations: ChatMutation[] | undefined): void {
  if (!Array.isArray(mutations) || mutations.length === 0) return;
  if (!res.locals) (res as any).locals = {};
  const existing: ChatMutation[] = Array.isArray(res.locals.writeMutations) ? res.locals.writeMutations : [];
  res.locals.writeMutations = [...existing, ...mutations];
}
