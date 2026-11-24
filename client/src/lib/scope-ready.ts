// The first screen after sign-in loads its data ONCE, for the right scope.
//
// 2026-11-24 (live trace, tests/live-all-pages-check.ts follow-up): a device
// with no saved scope for the user — a first sign-in, and every sign-in after
// a sign-out, which clears it — started in "everyone". The dashboard fetched
// everything for Everyone (a bootstrap plus seven lists, 2.6–4.1 s each on a
// cold instance), painted it, and only then learned who "me" is from the
// profile list, switched to that person and fetched everything again: 30
// requests and ~6 s to the final figures, with the household totals on
// screen in between. A reload, where the scope is already saved, took 18
// requests and 0.7 s.
//
// So when nothing is saved, the scope is settled BEFORE the screen asks for
// data: one slim profile list, the default applied
// (initDefaultProfileFilter: the account's own profile, or Everyone when it
// has none), then the screen mounts. A user with a saved scope never waits.
import { queryClient, apiRequest } from "./queryClient";
import { initDefaultProfileFilter, needsDefaultScope, setActiveUserForFilter } from "./profileFilter";

/** Long enough for a cold profile list; after it the screen opens as it used to. */
export const SCOPE_RESOLVE_TIMEOUT_MS = 5000;

const inFlight = new Map<string, Promise<void>>();

/** Settle this user's default scope. Never rejects; resolves at once when a scope is already known. */
export function resolveDefaultScope(userId: string, timeoutMs = SCOPE_RESOLVE_TIMEOUT_MS): Promise<void> {
  if (!userId || !needsDefaultScope(userId)) return Promise.resolve();
  const running = inFlight.get(userId);
  if (running) return running;

  const work = (async () => {
    // Point the store at this user first (the auth layer's own effect does
    // the same a moment later; it is idempotent).
    setActiveUserForFilter(userId);
    if (!needsDefaultScope(userId)) return;
    // The slot the nav chrome reads, so this is the list's one fetch.
    const profiles = await queryClient.fetchQuery<any[]>({
      queryKey: ["/api/profiles", "lite"],
      queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
      staleTime: 30_000,
    });
    // A choice made while the list was loading wins (initDefaultProfileFilter checks).
    initDefaultProfileFilter(Array.isArray(profiles) ? profiles : []);
  })().catch(() => { /* a failed list: open as before, the dashboard seeds the default when its own list lands */ });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    work,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    inFlight.delete(userId);
  });
  inFlight.set(userId, bounded);
  return bounded;
}
