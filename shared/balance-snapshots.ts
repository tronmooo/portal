// ── Balance snapshots: the leaf module ───────────────────────────────────────
//
// Timestamped observations of an account's value. Dependency-free on purpose:
// `shared/finance-accounts.ts` appends one on every balance adjustment and
// `shared/financial-assets.ts` builds the history model on top, and neither may
// import the other for it without a cycle. Everything here is re-exported from
// shared/financial-assets.ts, which is the import callers should use.

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function fieldsOf(input: any): Record<string, any> {
  if (!input || typeof input !== "object") return {};
  if ("fields" in input && input.fields && typeof input.fields === "object") return input.fields;
  return input;
}

/** Where a piece of financial data came from. Ordered by authority in SOURCE_PRIORITY. */
export type FinanceDataSource = "api" | "document" | "import" | "ai" | "user" | "payment" | "system";

export interface BalanceSnapshot {
  id: string;
  /** ISO timestamp of the observation. */
  at: string;
  /** Calendar day the balance was true (YYYY-MM-DD), for charting. */
  date: string;
  /** Balance as a positive magnitude, same convention as `fields.balance`. */
  balance: number;
  source: FinanceDataSource;
  /** What produced it: a sync run id, a document id, a chat turn, a payment id. */
  sourceRef?: string;
  note?: string;
}

/** Cap on stored observations. Old points are thinned, never the newest. */
export const MAX_BALANCE_SNAPSHOTS = 1000;

export function balanceSnapshots(input: any): BalanceSnapshot[] {
  const raw = fieldsOf(input).balanceSnapshots;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s: any) => s && typeof s === "object" && Number.isFinite(Number(s.balance)) && isDay(String(s.date ?? "").slice(0, 10)))
    .map((s: any, i: number) => ({
      id: String(s.id ?? `snap-${i}`),
      at: String(s.at ?? `${String(s.date).slice(0, 10)}T00:00:00.000Z`),
      date: String(s.date).slice(0, 10),
      balance: Math.abs(Number(s.balance)),
      source: (s.source ?? "system") as FinanceDataSource,
      ...(s.sourceRef ? { sourceRef: String(s.sourceRef) } : {}),
      ...(s.note ? { note: String(s.note) } : {}),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export interface SnapshotInput {
  balance: number;
  /** YYYY-MM-DD. Defaults to the day of `at`. */
  date?: string | null;
  /** ISO timestamp. Defaults to now. */
  at?: string | null;
  source: FinanceDataSource;
  sourceRef?: string | null;
  note?: string | null;
}

/**
 * Append one observation and return the new array — never mutates.
 *
 * Two observations from the SAME source on the SAME day collapse to the later
 * one (an API that syncs hourly should not leave 24 identical points a day),
 * but observations from different sources are both kept: a statement saying
 * $10,000 and an API saying $10,050 on the same day is information, not noise.
 * A no-change observation (same balance as the last point) from a non-API
 * source is dropped so a manual "set to what it already is" does not fake a
 * data point; API observations are kept so gaps in the connection show.
 */
export function appendBalanceSnapshot(existing: any, input: SnapshotInput, nowISO?: string): BalanceSnapshot[] {
  const list = Array.isArray(existing) ? balanceSnapshots({ balanceSnapshots: existing }) : balanceSnapshots(existing);
  const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : (nowISO ?? new Date().toISOString());
  const date = isDay(String(input.date ?? "").slice(0, 10)) ? String(input.date).slice(0, 10) : at.slice(0, 10);
  const balance = round2(Math.abs(Number(input.balance) || 0));
  const snap: BalanceSnapshot = {
    id: newId("snap"), at, date, balance, source: input.source,
    ...(input.sourceRef ? { sourceRef: String(input.sourceRef) } : {}),
    ...(input.note ? { note: String(input.note) } : {}),
  };

  const last = list[list.length - 1];
  if (last && input.source !== "api" && Math.abs(last.balance - balance) < 0.005 && last.date === date) {
    return list;
  }
  const kept = list.filter((s) => !(s.date === date && s.source === input.source));
  kept.push(snap);
  kept.sort((a, b) => a.at.localeCompare(b.at));
  return thinSnapshots(kept, MAX_BALANCE_SNAPSHOTS);
}

/** Keep the newest `max`; when over, drop every other OLD point rather than the tail. */
export function thinSnapshots(list: BalanceSnapshot[], max = MAX_BALANCE_SNAPSHOTS): BalanceSnapshot[] {
  if (list.length <= max) return list;
  const keepRecent = Math.floor(max / 2);
  const old = list.slice(0, list.length - keepRecent);
  const recent = list.slice(list.length - keepRecent);
  const thinned = old.filter((_, i) => i % 2 === 0);
  const out = [...thinned, ...recent];
  return out.length > max ? thinSnapshots(out, max) : out;
}

