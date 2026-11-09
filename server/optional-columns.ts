// A write that survives a migration the database has not received yet.
//
// 2026-11-09: migration 20260922 (turn_id / request_id / operation_id on
// ai_action_log) had never been applied to production. Every ledger insert
// named those columns, failed, and the failure was swallowed by design ("the
// ledger must never break a tool") — so for two months nothing the chat did
// was recorded. "Undo my last action" then undid the newest row it could
// find: an income logged on 2 September.
//
// The columns are an addition (idempotent replay); the row is the record
// (undo, history). Losing the addition must not lose the record.

type WriteResult<T> = { data: T | null; error: { code?: string; message?: string } | null };

/** PostgREST / Postgres saying "that column is not in this table". */
export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code || "");
  if (code === "PGRST204" || code === "42703") return true;
  return /could not find the '.*' column|column .* does not exist/i.test(String(error.message || ""));
}

/**
 * Run `write(row)`. If the database rejects it for a missing column, write
 * again without the optional columns and report which were dropped.
 */
export async function writeWithOptionalColumns<T>(
  write: (row: Record<string, unknown>) => PromiseLike<WriteResult<T>>,
  row: Record<string, unknown>,
  optional: readonly string[],
  onDegraded?: (error: { code?: string; message?: string }) => void,
): Promise<WriteResult<T>> {
  const first = await write(row);
  if (!first.error || !isMissingColumnError(first.error)) return first;
  if (!optional.some((k) => k in row)) return first;
  try { onDegraded?.(first.error); } catch { /* reporting never breaks the write */ }
  const reduced = Object.fromEntries(Object.entries(row).filter(([k]) => !optional.includes(k)));
  return write(reduced);
}
