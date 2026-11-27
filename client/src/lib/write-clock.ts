// When did the app last write, and is a write still on its way?
//
// WHY (integrity run, 2026-11-27): a read that STARTED before a write was
// acknowledged can carry what the server held before that write. React Query
// protects its own fetches (an invalidation restarts them); it cannot protect a
// side effect that copies a payload into OTHER caches — the dashboard bootstrap
// seeds about two dozen lists that way. A bootstrap that began before a task
// was ticked done landed afterwards, overwrote the lists the write had already
// updated and stamped them fresh, so the dashboard kept "1 Remaining" for three
// minutes (about one run in three, production). Anything that copies a payload
// into caches it does not own asks this module first.
// Guard: tests/bootstrap-seed-no-stale-overwrite.test.ts.
let inFlight = 0;
let lastSettledAt = 0;

/** A write has been sent. */
export function writeStarted(): void { inFlight++; }
/** That write was answered (or failed): from here on a NEW read sees it. */
export function writeSettled(now: number = Date.now()): void {
  inFlight = Math.max(0, inFlight - 1);
  lastSettledAt = Math.max(lastSettledAt, now);
}
export const writesInFlight = (): number => inFlight;
export const lastWriteSettledAt = (): number => lastSettledAt;

/** A read that began at `startedAt` may hold pre-write data: a write was (or
 *  still is) in the air at some point after it began. */
export function readMayPredateWrite(startedAt: number): boolean {
  return inFlight > 0 || lastSettledAt >= startedAt;
}

/** Tests only. */
export function resetWriteClock(): void { inFlight = 0; lastSettledAt = 0; }
