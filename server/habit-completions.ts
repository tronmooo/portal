// server/habit-completions.ts — building the individual completion rows.
//
// A habit completion is an OCCURRENCE, not a flag. "I walked the dog twice"
// writes two rows; "I brushed my teeth at 8am" writes one row stamped 08:00
// rather than stamped "now". Both storage backends (Supabase and the in-memory
// dev one) mint their rows here so a completion means the same thing on both.

import { randomUUID } from "crypto";
import { zonedTimeToUTC, DEFAULT_TIMEZONE } from "@shared/timezone";
import type { HabitCompletionSource } from "@shared/schema";

export interface HabitCheckinOptions {
  /** YYYY-MM-DD the completion belongs to. Defaults to the user's today. */
  date?: string;
  /** How many completions to record in this call. Defaults to 1. */
  count?: number;
  /** "HH:MM" wall-clock time the user says they did it. */
  at?: string;
  value?: number;
  notes?: string;
  source?: HabitCompletionSource;
  /** IANA timezone used to resolve `at` into an instant. */
  timezone?: string;
}

export interface HabitCompletionRow {
  id: string;
  user_id: string;
  habit_id: string;
  date: string;
  value: number | null;
  notes: string | null;
  timestamp: string;
  source: HabitCompletionSource;
  created_at: string;
}

/**
 * Timestamps for `count` completions recorded in one call.
 *
 * Distinct and strictly increasing, because the UI orders a day's completions
 * by timestamp to decide which one "undo one" removes and which dot maps to
 * which occurrence. Identical timestamps made that ordering arbitrary.
 *
 * When the user gave a clock time, the FIRST completion lands on it and the
 * rest follow a minute apart — "I brushed my teeth at 8am and again at 8pm"
 * should be two calls, but "I took my medication twice at 8am" is one call
 * that must still produce two orderable rows.
 */
export function completionTimestamps(args: {
  date: string;
  count: number;
  at?: string;
  timezone?: string;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}): string[] {
  const count = Math.max(1, Math.floor(args.count || 1));
  const out: string[] = [];
  const m = args.at ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(args.at) : null;
  if (m) {
    const base = zonedTimeToUTC(args.date, Number(m[1]), Number(m[2]), args.timezone || DEFAULT_TIMEZONE);
    for (let i = 0; i < count; i++) out.push(new Date(base.getTime() + i * 60_000).toISOString());
    return out;
  }
  const now = args.now ? new Date(args.now) : new Date();
  for (let i = 0; i < count; i++) out.push(new Date(now.getTime() + i).toISOString());
  return out;
}

/** The rows to insert for one check-in call. */
export function buildHabitCompletionRows(args: {
  habitId: string;
  userId: string;
  date: string;
  count: number;
  at?: string;
  value?: number;
  notes?: string;
  source?: HabitCompletionSource;
  timezone?: string;
  now?: Date;
}): HabitCompletionRow[] {
  const enteredAt = (args.now ? new Date(args.now) : new Date()).toISOString();
  return completionTimestamps({
    date: args.date, count: args.count, at: args.at, timezone: args.timezone, now: args.now,
  }).map((timestamp) => ({
    id: randomUUID(),
    user_id: args.userId,
    habit_id: args.habitId,
    date: args.date,
    value: args.value ?? null,
    notes: args.notes || null,
    timestamp,
    source: args.source || "manual",
    // `created_at` is when the row was entered; `timestamp` is when the user
    // says they did it. They differ for a backdated completion, and the
    // difference is the whole point of keeping both.
    created_at: enteredAt,
  }));
}
