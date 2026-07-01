/**
 * Obligation Engine — RETIRED (2026-07)
 * ─────────────────────────────────────────────────────────────────────────────
 * The dedicated `obligations` / `obligation_occurrences` / `obligation_payments`
 * tables were dropped. Recurring bills now live as recurring-family LIABILITY
 * profiles (type_key utility / subscription / bill …) with their recurrence in
 * `fields`, and payments live in `liability_payments`. Due-date advancement +
 * reminders are handled by shared/liability-recurrence.ts and the
 * /api/cron/liability-due-scan job.
 *
 * These exports are kept as inert stubs so the (few) remaining dynamic importers
 * resolve without touching a dropped table. Occurrence-based endpoints now return
 * empty/no-op results; the calendar no longer renders per-occurrence bill rows.
 */

export async function materializeOccurrences(
  _supabase: any,
  _userId: string,
  _obligationId: string,
  _horizonDays: number = 730,
): Promise<{ inserted: number; skipped: number }> {
  return { inserted: 0, skipped: 0 };
}

export async function listOccurrences(
  _supabase: any,
  _userId: string,
  _start: string,
  _end: string,
): Promise<any[]> {
  return [];
}

export async function markOccurrence(
  _supabase: any,
  _userId: string,
  _occurrenceId: string,
  _newStatus: "done" | "skipped" | "pending" | "late",
  _opts: { actualAmount?: number; method?: string; notes?: string } = {},
): Promise<{ ok: boolean; occurrence?: any; error?: string }> {
  return { ok: false, error: "Obligations retired — pay the liability instead" };
}

export async function rescheduleOccurrence(
  _supabase: any,
  _userId: string,
  _occurrenceId: string,
  _newDueAt: string,
): Promise<{ ok: boolean; occurrence?: any; error?: string }> {
  return { ok: false, error: "Obligations retired" };
}

export async function backfillLateStatuses(
  _supabase: any,
  _userId: string,
): Promise<{ updated: number }> {
  return { updated: 0 };
}
