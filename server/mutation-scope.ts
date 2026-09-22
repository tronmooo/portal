// server/mutation-scope.ts — the action layer for Rule 1.
//
// `shared/turn-scope.ts` decides what a message is allowed to do. This module
// makes that decision ENFORCEABLE: the engine runs each turn inside a
// mutation scope, and the storage proxy (server/storage.ts) consults it on
// every write-shaped method. A turn whose budget is "none" therefore cannot
// write through ANY path — the tool loop, a deterministic fast path, the bulk
// executor, or a helper three calls deep — because the refusal sits at the
// one place every write already passes through.
//
// The scope also carries the turn's identity (turnId / requestId) so the
// storage layer and the integrity log can name which turn a refused write
// belonged to.

import { AsyncLocalStorage } from "node:async_hooks";
import type { MutationBudget, TurnIntent } from "@shared/turn-scope";
import { isJournaledStorageMethod } from "@shared/storage-domains";
import { logIntegrity } from "./integrity-log";

export interface MutationScope {
  intent: TurnIntent;
  allowedMutations: MutationBudget;
  turnId?: string;
  requestId?: string;
  userId?: string;
  /** Storage methods refused in this scope, for the turn's own report. */
  refused: string[];
}

export const mutationScopeContext = new AsyncLocalStorage<MutationScope>();

/** Thrown by the storage proxy when a write is attempted in a read-only turn. */
export class ReadOnlyTurnError extends Error {
  readonly code = "READ_ONLY_TURN";
  readonly method: string;
  constructor(method: string) {
    super(`This message is a question, so nothing can be changed during it (${method} refused). Ask for the change in its own message if you want it made.`);
    this.name = "ReadOnlyTurnError";
    this.method = method;
  }
}

export function isReadOnlyTurnError(e: unknown): e is ReadOnlyTurnError {
  return !!e && typeof e === "object" && (e as any).code === "READ_ONLY_TURN";
}

export function runWithMutationScope<T>(scope: Omit<MutationScope, "refused"> & { refused?: string[] }, fn: () => T): T {
  return mutationScopeContext.run({ refused: [], ...scope }, fn);
}

export function currentMutationScope(): MutationScope | undefined {
  return mutationScopeContext.getStore();
}

/**
 * Called by the storage proxy before a write-shaped method runs. Outside any
 * scope (REST routes, cron, tests) it is a no-op. Inside a read-only scope it
 * records the anomaly and throws.
 */
export function assertMutationAllowed(method: string): void {
  const scope = mutationScopeContext.getStore();
  if (!scope || scope.allowedMutations !== "none") return;
  // Reads and infrastructure calls are never refused — the same classifier
  // the write journal uses decides what is write-shaped.
  if (!isJournaledStorageMethod(method)) return;
  scope.refused.push(method);
  logIntegrity({
    kind: "ai_read_triggered_write",
    message: `storage.${method} attempted during a READ turn — refused at the action layer`,
    userId: scope.userId,
    turnId: scope.turnId,
    requestId: scope.requestId,
    detail: { method, intent: scope.intent },
  });
  throw new ReadOnlyTurnError(method);
}
