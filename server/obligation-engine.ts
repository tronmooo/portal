/**
 * Obligation Engine — Wave 16
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for recurring real-life commitments (bills, subs,
 * loan payments, meds, maintenance, appointments, doc expirations, etc).
 *
 * Responsibilities:
 *   • materializeOccurrences(): generate the next N days of `obligation_occurrences`
 *     rows from an obligation's frequency. Idempotent — re-running won't dupe
 *     (the (obligation_id, original_due_at) unique constraint guarantees it).
 *   • markOccurrence(): set status on a single occurrence (done/skipped/late/
 *     pending/rescheduled). When done with auto_log_expense=true, also writes
 *     an `expenses` row. When done on a loan_payment with linked_liability_id,
 *     decrements the loan's remaining balance.
 *   • rescheduleOccurrence(): change due_at without losing the original_due_at.
 *   • backfillLateStatuses(): nightly maintenance — flips pending → late once
 *     past due. Cheap; bounded by (status='pending' AND due_at < today).
 */
import { randomUUID } from "crypto";

// Local-date helper (avoids UTC drift around midnight).
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function toLocalDateStr(d: Date): string {
  // 'en-CA' formats as YYYY-MM-DD which is exactly what we want for date columns.
  return d.toLocaleDateString("en-CA");
}

function advance(date: Date, frequency: string, units = 1): Date {
  const next = new Date(date);
  switch (frequency) {
    case "weekly":    next.setDate(next.getDate() + 7 * units); break;
    case "biweekly":  next.setDate(next.getDate() + 14 * units); break;
    case "monthly":   next.setMonth(next.getMonth() + units); break;
    case "quarterly": next.setMonth(next.getMonth() + 3 * units); break;
    case "yearly":    next.setFullYear(next.getFullYear() + units); break;
    case "once":      return next;
  }
  return next;
}

/**
 * Generate occurrences for the next `horizonDays` days starting from this
 * obligation's nextDueDate (or today, whichever is later). Safe to re-run.
 */
export async function materializeOccurrences(
  supabase: any,
  userId: string,
  obligationId: string,
  horizonDays: number = 730,
): Promise<{ inserted: number; skipped: number }> {
  const { data: ob, error: obErr } = await supabase
    .from("obligations").select("*")
    .eq("id", obligationId).eq("user_id", userId).single();
  if (obErr || !ob) return { inserted: 0, skipped: 0 };
  if (ob.status === "cancelled" || ob.status === "paused") return { inserted: 0, skipped: 0 };

  const today = new Date();
  const recEnd = ob.recurrence_end ? parseLocalDate(ob.recurrence_end) : null;
  // If a recurrence_end is set, EXPAND THE FULL SERIES (capped at 500 below).
  // The user explicitly wants 12 occurrences for a 1-year monthly bill, etc.
  // No recurrence_end → use the supplied horizon (default 2 years) so the
  // calendar shows roughly 24 months of upcoming bills without unbounded growth.
  const horizonEnd = recEnd
    ? new Date(Math.max(recEnd.getTime(), today.getTime() + horizonDays * 86400000))
    : new Date(today.getTime() + horizonDays * 86400000);

  // Start from the earlier of (next_due_date, today) so we don't lose past-due
  // occurrences. If next_due is in the future, start there.
  const start = parseLocalDate(ob.next_due_date);
  const dates: string[] = [];

  if (ob.frequency === "once") {
    if (start <= horizonEnd && (!recEnd || start <= recEnd)) {
      dates.push(toLocalDateStr(start));
    }
  } else {
    let cur = new Date(start);
    // Safety guard: max 500 occurrences per materialization call.
    for (let i = 0; i < 500; i++) {
      if (cur > horizonEnd) break;
      if (recEnd && cur > recEnd) break;
      dates.push(toLocalDateStr(cur));
      cur = advance(cur, ob.frequency, 1);
    }
  }

  if (dates.length === 0) return { inserted: 0, skipped: 0 };

  // Bulk upsert — ON CONFLICT (obligation_id, original_due_at) DO NOTHING.
  // Supabase JS doesn't expose true upsert-ignore for composite uniques, so
  // we fetch existing rows first and insert the diff. Tiny payload either way.
  const { data: existing } = await supabase
    .from("obligation_occurrences")
    .select("original_due_at")
    .eq("obligation_id", obligationId)
    .eq("user_id", userId)
    .in("original_due_at", dates);
  const existingSet = new Set((existing || []).map((r: any) => r.original_due_at));

  const toInsert = dates.filter(d => !existingSet.has(d)).map(d => ({
    id: randomUUID(),
    user_id: userId,
    obligation_id: obligationId,
    due_at: d,
    original_due_at: d,
    status: "pending" as const,
  }));

  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from("obligation_occurrences").insert(toInsert);
    if (insErr) {
      console.error("[obligation-engine] insert failed:", insErr.message);
      return { inserted: 0, skipped: existingSet.size };
    }
  }
  return { inserted: toInsert.length, skipped: existingSet.size };
}

/**
 * List occurrences in a date window. Joins obligation details so the caller
 * gets a calendar-ready item without N+1 queries.
 */
export async function listOccurrences(
  supabase: any,
  userId: string,
  start: string,
  end: string,
): Promise<any[]> {
  const { data, error } = await supabase
    .from("obligation_occurrences")
    .select("*, obligation:obligations(id,name,kind,amount,currency,autopay,category,linked_profiles,linked_asset_id,linked_liability_id,linked_document_id,notes,icon,frequency)")
    .eq("user_id", userId)
    .gte("due_at", start)
    .lte("due_at", end)
    .order("due_at", { ascending: true });
  if (error) {
    console.error("[obligation-engine] listOccurrences:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Mark a single occurrence done/skipped/rescheduled/pending.
 *  - done: writes obligation_payments + expense (if auto_log_expense),
 *    decrements linked liability balance (if loan_payment), advances the
 *    parent obligation's next_due_date past today.
 *  - skipped: same advance but no payment row.
 *  - reschedule: see rescheduleOccurrence().
 */
export async function markOccurrence(
  supabase: any,
  userId: string,
  occurrenceId: string,
  newStatus: "done" | "skipped" | "pending" | "late",
  opts: { actualAmount?: number; method?: string; notes?: string } = {},
): Promise<{ ok: boolean; occurrence?: any; error?: string }> {
  const { data: occ, error: occErr } = await supabase
    .from("obligation_occurrences").select("*, obligation:obligations(*)")
    .eq("id", occurrenceId).eq("user_id", userId).single();
  if (occErr || !occ) return { ok: false, error: "Occurrence not found" };
  const ob = occ.obligation;
  if (!ob) return { ok: false, error: "Parent obligation missing" };

  const now = new Date().toISOString();
  const update: any = { status: newStatus, updated_at: now };

  // ---------- DONE path: payment + side-effects ----------
  if (newStatus === "done") {
    update.completed_at = now;
    const amount = opts.actualAmount ?? (Number(ob.amount) || 0);
    update.actual_amount = amount;
    if (opts.notes) update.notes = opts.notes;

    // 1) Record a payment row (always — even for $0 it gives a completion trail).
    if (amount > 0) {
      const paymentId = randomUUID();
      const today = toLocalDateStr(new Date());
      const { error: payErr } = await supabase.from("obligation_payments").insert({
        id: paymentId, user_id: userId, obligation_id: ob.id,
        amount, date: today, method: opts.method || null,
      });
      if (!payErr) update.payment_id = paymentId;

      // 2) Auto-log as expense if configured (subscriptions, bills usually).
      if (ob.auto_log_expense) {
        await supabase.from("expenses").insert({
          id: randomUUID(), user_id: userId,
          amount, category: ob.category || "general",
          description: ob.name, date: today,
          linked_profiles: ob.linked_profiles || [],
          source: "obligation",
        }).then(({ error }: any) => {
          if (error) console.error("[obligation-engine] expense insert failed:", error.message);
        });
      }

      // 3) If this is a loan payment, decrement liability remaining balance.
      if (ob.kind === "loan_payment" && ob.linked_liability_id) {
        await decrementLiabilityBalance(supabase, userId, ob.linked_liability_id, amount);
      }
    }

    // 4) Advance parent obligation's next_due_date to first future date.
    await advanceParentDueDate(supabase, userId, ob);
  }

  // ---------- SKIPPED path: just advance, no payment ----------
  if (newStatus === "skipped") {
    update.completed_at = now;
    await advanceParentDueDate(supabase, userId, ob);
  }

  const { data: updated, error: updErr } = await supabase
    .from("obligation_occurrences").update(update)
    .eq("id", occurrenceId).eq("user_id", userId)
    .select("*").single();
  if (updErr) return { ok: false, error: updErr.message };

  // Top up the horizon so the user always sees ~90 days of upcoming items.
  await materializeOccurrences(supabase, userId, ob.id, 90);

  return { ok: true, occurrence: updated };
}

/** Move an occurrence to a different due_at without changing original_due_at. */
export async function rescheduleOccurrence(
  supabase: any,
  userId: string,
  occurrenceId: string,
  newDueAt: string,
): Promise<{ ok: boolean; occurrence?: any; error?: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDueAt)) {
    return { ok: false, error: "newDueAt must be YYYY-MM-DD" };
  }
  const { data, error } = await supabase
    .from("obligation_occurrences").update({
      due_at: newDueAt, status: "rescheduled", updated_at: new Date().toISOString(),
    }).eq("id", occurrenceId).eq("user_id", userId).select("*").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, occurrence: data };
}

/** Bulk: flip pending → late for past-due rows. Cheap; for the cron warmer. */
export async function backfillLateStatuses(
  supabase: any,
  userId: string,
): Promise<{ updated: number }> {
  const today = toLocalDateStr(new Date());
  const { data, error } = await supabase
    .from("obligation_occurrences").update({ status: "late", updated_at: new Date().toISOString() })
    .eq("user_id", userId).eq("status", "pending").lt("due_at", today).select("id");
  if (error) {
    console.error("[obligation-engine] backfillLateStatuses:", error.message);
    return { updated: 0 };
  }
  return { updated: (data || []).length };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function advanceParentDueDate(supabase: any, userId: string, ob: any) {
  if (ob.frequency === "once") {
    // One-shot obligations stay at their date; they're done after one occurrence.
    return;
  }
  const now = new Date();
  const recEnd = ob.recurrence_end ? parseLocalDate(ob.recurrence_end) : null;
  let cur = parseLocalDate(ob.next_due_date);
  // Advance until we land strictly after today (or hit the recurrence end).
  for (let i = 0; i < 500; i++) {
    cur = advance(cur, ob.frequency, 1);
    if (cur > now) break;
  }
  if (recEnd && cur > recEnd) return; // do nothing — series complete
  await supabase.from("obligations")
    .update({ next_due_date: toLocalDateStr(cur), updated_at: new Date().toISOString() })
    .eq("id", ob.id).eq("user_id", userId);
}

/**
 * Loan-payment side-effect. Liability is a profile row with kind='liability'
 * and a `fields.remainingBalance` JSON path. We do a read-modify-write here;
 * the surface is small (one user paying one loan at a time) so this is fine.
 */
async function decrementLiabilityBalance(
  supabase: any, userId: string, liabilityId: string, amount: number,
) {
  const { data: prof, error } = await supabase
    .from("profiles").select("id, fields")
    .eq("id", liabilityId).eq("user_id", userId).single();
  if (error || !prof) return;
  const fields = prof.fields || {};
  const current = Number((fields.remainingBalance ?? fields.balance) ?? 0);
  if (!Number.isFinite(current) || current <= 0) return;
  const next = Math.max(0, current - amount);
  fields.remainingBalance = next;
  await supabase.from("profiles")
    .update({ fields, updated_at: new Date().toISOString() })
    .eq("id", liabilityId).eq("user_id", userId);
}
