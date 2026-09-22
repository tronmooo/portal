// server/active-scope-context.ts
//
// The caller's ACTIVE PROFILE SELECTION, carried through the request without
// a parameter on every storage method.
//
// The client sends `X-Active-Profile-Ids` on every request (see
// client/src/lib/queryClient.ts and shared/active-scope.ts). The auth
// middleware parses it once and runs the rest of the request inside this
// AsyncLocalStorage, so ANY writer — a REST handler, an AI tool deep inside
// executeTool, an importer — can ask `getActiveProfileIds()` and default a new
// record's owner to the selected profile (Rule 6) instead of to self.
//
// Callers that do not come through the middleware (crons, the chat route when
// it wants to set the scope explicitly, tests) use `runWithActiveScope`.
import { AsyncLocalStorage } from "node:async_hooks";

export interface ActiveScope {
  activeProfileIds: string[];
}

export const activeScopeContext = new AsyncLocalStorage<ActiveScope>();

function clean(ids: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids || []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The active profile ids for the current request, or [] outside one ("Everyone"). */
export function getActiveProfileIds(): string[] {
  return activeScopeContext.getStore()?.activeProfileIds ?? [];
}

/** The single active profile id when exactly one is selected, else null. */
export function getActiveProfileId(): string | null {
  const ids = getActiveProfileIds();
  return ids.length === 1 ? ids[0] : null;
}

/** Run `fn` with the given selection as the active scope (nested calls override). */
export function runWithActiveScope<T>(ids: readonly (string | null | undefined)[] | null | undefined, fn: () => T): T {
  return activeScopeContext.run({ activeProfileIds: clean(ids) }, fn);
}
