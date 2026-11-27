// A change computed from the stored row is written only over the row that was
// read (Rule 6: no stale overwrite).
//
// WHY (integrity run, 2026-11-27): the occurrence routes read a task's or an
// event's tags, changed one mark and wrote the whole list back. Two marks a
// moment apart (two dates skipped in a row; a check-off in the briefing and a
// skip in the calendar) both read the same list, and the second write dropped
// the first's mark — both requests answered 200. The storage layer already
// refuses a write when the row has moved (`expectedUpdatedAt` → 409); this
// passes the version that was read and, on a refusal, reads and computes again.
// Guard: tests/integrity-run-fixes-2026-11-27.test.ts.
// Live check: tests/integrity/scenarios/hardening.ts (hardening.simultaneous-edits).

export type StoredChange<P> = { patch: P } | { status: number; error: string };
export type StoredWriteResult<T> = { ok: true; row: T } | { ok: false; status: number; error: string };

const isConflict = (e: any) => e?.statusCode === 409 || e?.name === "ConflictError";

export async function writeFromStoredRow<T extends { updatedAt?: string | null }, P extends object>(opts: {
  read: () => Promise<T | undefined | null>;
  /** The change for the row it is handed; called again with a fresh row after a collision. */
  compute: (row: T) => StoredChange<P>;
  write: (patch: P & { expectedUpdatedAt?: string }) => Promise<T | undefined | null>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StoredWriteResult<T>> {
  const attempts = opts.attempts ?? 10;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const row = await opts.read();
    if (!row) return { ok: false, status: 404, error: "Not found" };
    const change = opts.compute(row);
    if (!("patch" in change)) return { ok: false, status: change.status, error: change.error };
    try {
      const written = await opts.write(
        typeof row.updatedAt === "string" && row.updatedAt ? { ...change.patch, expectedUpdatedAt: row.updatedAt } : change.patch,
      );
      if (!written) return { ok: false, status: 404, error: "Not found" };
      return { ok: true, row: written };
    } catch (e) {
      if (!isConflict(e) || attempt >= attempts - 1) throw e;
      // jittered, so writers that collided once do not collide again in step
      await sleep(10 + attempt * 20 + Math.floor(Math.random() * 25));
    }
  }
}
