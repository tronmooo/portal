// Recurrence engine for tasks.
//
// Recurrence rules live in the task's existing `tags` array (there is no
// dedicated schema column), so they persist through the normal tasks API with
// no migration. A recurring task stores a single "next occurrence" in its
// `dueDate`; completing or skipping it advances that date by one cycle. We never
// generate hundreds of future rows — the next date is computed dynamically.
//
// Tags used:
//   recur:<freq>          freq ∈ daily | weekdays | weekly | monthly | yearly
//                         | every-<n>-days | every-<n>-weeks
//   runtil:<YYYY-MM-DD>   series ends once the next occurrence passes this date
//   rcount:<n>            series ends after n completed occurrences
//   rdone:<n>             occurrences completed so far (drives rcount)
//   rpaused               series paused — its next occurrence is hidden
//   ranchor:<n>           day-of-month the series is anchored to (1–31)
//   rskip:<YYYY-MM-DD>    that ONE scheduled occurrence is skipped; the series
//                         keeps its schedule and steps over it
//   rmove:<from>><to>     that ONE scheduled occurrence happens on another day
//   rfrom:<YYYY-MM-DD>    THIS row was moved: its scheduled date is this one,
//                         and the series steps from it, not from `dueDate`
//
// ANCHOR DAY. A monthly series stores only its NEXT due date, so advancing it
// one cycle at a time would drift whenever a month is too short: naive
// setMonth turns Jan 31 into Mar 3, and every later step then sits on the 3rd.
// `ranchor:` pins the intended day-of-month so the series clamps to the month
// end (Feb 28) and returns to the 31st the following month. See
// shared/date-math.ts.

import { addMonthsClamped, addYearsClamped } from "./date-math";

export interface RecurrenceRule {
  freq: string; // "" = does not repeat
  interval: number; // N for every-N-*
  unit: "day" | "week" | "month" | "year" | "weekday" | "";
  until?: string; // YYYY-MM-DD
  count?: number; // end after N occurrences
  done: number; // completed occurrences so far
  paused: boolean;
  /** Day-of-month the monthly/yearly series is pinned to (1–31). */
  anchorDay?: number;
  /** Scheduled dates skipped one at a time (`rskip:`). The series steps over them. */
  skipped?: string[];
  /** Scheduled date → the day that ONE occurrence was moved to (`rmove:`). */
  moved?: Record<string, string>;
  /** The scheduled date of the stored row when it was moved off it (`rfrom:`). */
  movedFrom?: string;
}

export const RECUR_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Every weekday (Mon–Fri)" },
  { value: "weekly", label: "Weekly" },
  { value: "every-2-weeks", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const RECUR_TAG_RE = /^(recur:|runtil:|rcount:|rdone:|ranchor:|rskip:|rmove:|rfrom:|rpaused$)/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Per-occurrence marks kept on a series, newest last — bounds the tag list. */
const MAX_OCCURRENCE_MARKS = 120;

/** Is this tag part of the recurrence grammar (never a user-facing label)? */
export function isRecurrenceTag(tag: unknown): boolean {
  return RECUR_TAG_RE.test(String(tag ?? ""));
}

/** The user's own tags — the recurrence grammar stripped. */
export function userTags(tags: readonly unknown[] | null | undefined): string[] {
  return (tags || []).map(String).filter((t) => !RECUR_TAG_RE.test(t));
}
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function freqToUnit(freq: string): { unit: RecurrenceRule["unit"]; interval: number } {
  if (freq === "daily") return { unit: "day", interval: 1 };
  if (freq === "weekly") return { unit: "week", interval: 1 };
  if (freq === "biweekly") return { unit: "week", interval: 2 }; // legacy token from the AI create_task parser
  if (freq === "weekdays") return { unit: "weekday", interval: 1 };
  if (freq === "monthly") return { unit: "month", interval: 1 };
  if (freq === "yearly" || freq === "annual") return { unit: "year", interval: 1 };
  const md = freq.match(/^every-(\d+)-days?$/);
  if (md) return { unit: "day", interval: Math.max(1, +md[1]) };
  const mw = freq.match(/^every-(\d+)-weeks?$/);
  if (mw) return { unit: "week", interval: Math.max(1, +mw[1]) };
  return { unit: "", interval: 1 };
}

export function parseRecurrence(tags: string[] = []): RecurrenceRule {
  const get = (p: string) => tags.find((t) => t.startsWith(p));
  const freqTag = get("recur:");
  const freq = freqTag ? freqTag.slice(6) : "";
  const { unit, interval } = freqToUnit(freq);
  const until = get("runtil:")?.slice(7);
  const countTag = get("rcount:");
  const count = countTag ? parseInt(countTag.slice(7), 10) || undefined : undefined;
  const doneTag = get("rdone:");
  const done = doneTag ? parseInt(doneTag.slice(6), 10) || 0 : 0;
  const paused = tags.includes("rpaused");
  const anchorTag = get("ranchor:");
  const anchorRaw = anchorTag ? parseInt(anchorTag.slice(8), 10) : NaN;
  const anchorDay = Number.isFinite(anchorRaw) && anchorRaw >= 1 && anchorRaw <= 31 ? anchorRaw : undefined;
  const skipped: string[] = [];
  const moved: Record<string, string> = {};
  let movedFrom: string | undefined;
  for (const t of tags) {
    if (t.startsWith("rskip:")) {
      const d = t.slice(6);
      if (ISO_DAY_RE.test(d) && !skipped.includes(d)) skipped.push(d);
    } else if (t.startsWith("rmove:")) {
      const [from, to] = t.slice(6).split(">");
      if (ISO_DAY_RE.test(from || "") && ISO_DAY_RE.test(to || "")) moved[from] = to;
    } else if (t.startsWith("rfrom:")) {
      const d = t.slice(6);
      if (ISO_DAY_RE.test(d)) movedFrom = d;
    }
  }
  return {
    freq, interval, unit, until, count, done, paused, anchorDay,
    ...(skipped.length ? { skipped: skipped.sort() } : {}),
    ...(Object.keys(moved).length ? { moved } : {}),
    ...(movedFrom ? { movedFrom } : {}),
  };
}

// Build the recurrence-related tags, preserving any non-recurrence tags passed in.
export function recurrenceToTags(rule: RecurrenceRule, existing: string[] = []): string[] {
  const base = existing.filter((t) => !RECUR_TAG_RE.test(t));
  if (!rule.freq) return base;
  base.push(`recur:${rule.freq}`);
  if (rule.until) base.push(`runtil:${rule.until}`);
  if (rule.count) base.push(`rcount:${rule.count}`);
  if (rule.done) base.push(`rdone:${rule.done}`);
  if (rule.anchorDay != null && rule.anchorDay >= 1 && rule.anchorDay <= 31) {
    base.push(`ranchor:${rule.anchorDay}`);
  }
  if (rule.paused) base.push("rpaused");
  for (const d of [...(rule.skipped || [])].sort().slice(-MAX_OCCURRENCE_MARKS)) base.push(`rskip:${d}`);
  for (const from of Object.keys(rule.moved || {}).sort().slice(-MAX_OCCURRENCE_MARKS)) {
    base.push(`rmove:${from}>${rule.moved![from]}`);
  }
  if (rule.movedFrom) base.push(`rfrom:${rule.movedFrom}`);
  return base;
}

/**
 * The SCHEDULED date of the stored row.
 *
 * A row moved for one occurrence ("mow on the 18th this month") still belongs
 * to the 15th: the series steps from the scheduled date, so January is the
 * 15th again and the move never re-anchors the schedule.
 */
export function scheduledDateOf(dueDate: string | null | undefined, rule: RecurrenceRule): string {
  return rule.movedFrom || String(dueDate || "").slice(0, 10);
}

/** Where a scheduled date actually falls, after a one-occurrence move. */
function placed(date: string, rule: RecurrenceRule): { dueDate: string; movedFrom?: string } {
  const to = rule.moved?.[date];
  return to && to !== date ? { dueDate: to, movedFrom: date } : { dueDate: date };
}

/**
 * The first scheduled date at or after `from` that is not skipped, or null
 * when the series ends first. Bounded so a fully-skipped series cannot spin.
 */
function firstUnskipped(from: string, rule: RecurrenceRule): string | null {
  const skipped = new Set(rule.skipped || []);
  let cur = from;
  for (let guard = 0; guard < 2000; guard++) {
    if (rule.until && cur > rule.until) return null;
    if (!skipped.has(cur)) return cur;
    const next = advance(cur, rule);
    if (next <= cur) return null;
    cur = next;
  }
  return null;
}

/**
 * Pin a month/year series to its start date's day-of-month so later steps
 * can't drift off it. Call this when a recurrence is first attached to a task
 * (the start date is known then and never again). No-op for day/week rules and
 * for rules that already carry an anchor.
 */
export function withAnchorDay(rule: RecurrenceRule, startDate: string | undefined): RecurrenceRule {
  if (rule.anchorDay != null) return rule;
  if (rule.unit !== "month" && rule.unit !== "year") return rule;
  if (!startDate) return rule;
  const d = new Date(startDate.slice(0, 10) + "T00:00:00");
  if (Number.isNaN(d.getTime())) return rule;
  return { ...rule, anchorDay: d.getDate() };
}

export function isRecurring(tags: string[] = []): boolean {
  return tags.some((t) => t.startsWith("recur:"));
}

/**
 * Detect a cadence token in free text — an explicit `recurrence` argument or a
 * task title. Returns undefined when the text names no schedule, which is the
 * common case: most tasks are one-time only.
 *
 * Feed this the task's OWN words. Widening the input to a whole chat message
 * makes one cadence word contaminate every task created in that turn (see the
 * call site in create_task).
 */
export function detectRecurrenceFreq(text: string): string | undefined {
  const s = String(text || "").toLowerCase();
  if (!s.trim()) return undefined;
  const everyNDays = s.match(/every (\d+) days?/);
  const everyNWeeks = s.match(/every (\d+) weeks?/);
  // An explicit interval is the most specific statement in the text and wins
  // over a generic cadence word. The engine feeds this `${recurrence} ${title}`,
  // and the model's enum has no "every 3 days" — it sends recurrence:"daily"
  // with the interval in the title, which used to encode as recur:daily and
  // respawn the chore the next morning.
  if (everyNDays && +everyNDays[1] > 1) return `every-${everyNDays[1]}-days`;
  // "every 2 weeks" keeps the legacy biweekly token the rest of the app reads.
  if (everyNWeeks && +everyNWeeks[1] === 2) return "biweekly";
  if (everyNWeeks && +everyNWeeks[1] > 2) return `every-${everyNWeeks[1]}-weeks`;
  if (/\bdaily\b|every day|each day/.test(s)) return "daily";
  if (/\bweekdays?\b|every weekday|mon(day)?(\s*[-–to]+\s*)fri(day)?/.test(s)) return "weekdays";
  if (/\bbiweekly\b|every (other|2|two) weeks/.test(s)) return "biweekly";
  if (everyNWeeks && +everyNWeeks[1] > 1) return `every-${everyNWeeks[1]}-weeks`;
  if (/\bweekly\b|every week|each week/.test(s)) return "weekly";
  if (/\b(monthly|every month|each month)\b/.test(s)) return "monthly";
  if (/\b(yearly|annually|annual|every year|each year)\b/.test(s)) return "yearly";
  if (everyNDays) return +everyNDays[1] === 1 ? "daily" : `every-${everyNDays[1]}-days`;
  return undefined;
}

function toLocalISO(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

// Advance a date string by exactly one cycle of the rule.
export function advance(dateStr: string, rule: RecurrenceRule): string {
  const d = new Date(dateStr + "T00:00:00");
  if (rule.unit === "day") d.setDate(d.getDate() + rule.interval);
  else if (rule.unit === "week") d.setDate(d.getDate() + 7 * rule.interval);
  // Month/year steps clamp to the target month's last day and honour the
  // series anchor, so Jan 31 → Feb 28 → Mar 31 rather than Mar 3 → Apr 3.
  else if (rule.unit === "month") return toLocalISO(addMonthsClamped(d, rule.interval, rule.anchorDay));
  else if (rule.unit === "year") return toLocalISO(addYearsClamped(d, rule.interval, rule.anchorDay));
  else if (rule.unit === "weekday") {
    do {
      d.setDate(d.getDate() + 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
  } else d.setDate(d.getDate() + 1);
  return toLocalISO(d);
}

/**
 * Step a date BACK by exactly one cycle of the rule — the mirror of `advance`.
 *
 * A series only ever stores its next occurrence, so answering "which cycle was
 * this date rolled forward from?" needs the same clamped, anchored arithmetic
 * running the other way: Mar 31 − 1 month is Feb 28 with the anchor intact, so
 * a further step returns to Jan 31 rather than drifting onto the 28th.
 */
export function retreat(dateStr: string, rule: RecurrenceRule): string {
  const d = new Date(dateStr + "T00:00:00");
  if (rule.unit === "day") d.setDate(d.getDate() - rule.interval);
  else if (rule.unit === "week") d.setDate(d.getDate() - 7 * rule.interval);
  else if (rule.unit === "month") return toLocalISO(addMonthsClamped(d, -rule.interval, rule.anchorDay));
  else if (rule.unit === "year") return toLocalISO(addYearsClamped(d, -rule.interval, rule.anchorDay));
  else if (rule.unit === "weekday") {
    do {
      d.setDate(d.getDate() - 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
  } else d.setDate(d.getDate() - 1);
  return toLocalISO(d);
}

// The next occurrence after the current due date (or today if undated).
export function nextOccurrence(dueDate: string | undefined, rule: RecurrenceRule): string | null {
  if (!rule.freq) return null;
  const base = dueDate || toLocalISO(new Date());
  return advance(base, rule);
}

// Has the series reached its end condition given the proposed next date?
export function seriesEnded(rule: RecurrenceRule, nextDate: string | null): boolean {
  if (rule.count && rule.done + 1 >= rule.count) return true;
  if (rule.until && nextDate && nextDate > rule.until) return true;
  return false;
}

function fmtShort(dateStr: string, now: Date = new Date()): string {
  const d = new Date(dateStr + "T00:00:00");
  // "until Aug 2" for a series that runs until 2028 read as already ended:
  // the year is the whole point of the date once it isn't this year's.
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

// Human-readable schedule summary, e.g. "Repeats every 2 weeks on Friday until Dec 31".
export function humanSummary(rule: RecurrenceRule, dueDate?: string, now: Date = new Date()): string {
  if (!rule.freq) return "Does not repeat";
  let s = "Repeats ";
  if (rule.unit === "day") s += rule.interval === 1 ? "daily" : `every ${rule.interval} days`;
  else if (rule.unit === "weekday") s += "every weekday";
  else if (rule.unit === "week") {
    const dow = dueDate ? DOW[new Date(dueDate + "T00:00:00").getDay()] : null;
    s += rule.interval === 1 ? "weekly" : `every ${rule.interval} weeks`;
    if (dow) s += ` on ${dow}`;
  } else if (rule.unit === "month") {
    // Prefer the stored anchor: on a short month the due date reads "28" while
    // the series is really pinned to the 31st, and the label must not lie.
    const dom = rule.anchorDay ?? (dueDate ? new Date(dueDate + "T00:00:00").getDate() : null);
    s += "monthly";
    if (dom) s += ` on day ${dom}`;
  } else if (rule.unit === "year") s += "yearly";
  else s += "on a schedule";
  if (rule.until) s += ` until ${fmtShort(rule.until, now)}`;
  else if (rule.count) {
    const left = Math.max(0, rule.count - rule.done);
    s += ` — ${left} of ${rule.count} left`;
  }
  if (rule.paused) s = "Paused · " + s;
  return s;
}

/**
 * What completing a recurring task spawns: the next occurrence's due date and
 * the tags the new row carries, or null when the series has ended (its
 * `runtil:` passed, its `rcount:` used up) or the task does not repeat.
 *
 * ONE definition for the server. The storage used to hand-roll the step with
 * a four-cadence switch: `every-N-weeks`, `weekdays`, `yearly`, `weekly:1,3,5`
 * spawned nothing (the chore vanished after its first completion), `runtil:`
 * and `rcount:` were ignored (the chore outlived its end), and a monthly step
 * off the 31st drifted (see shared/date-math.ts).
 */
export function nextRecurringTaskSpawn(
  prev: { dueDate?: string | null; tags?: string[] | null },
  todayISO?: string,
): { dueDate: string; tags: string[] } | null {
  const tags = Array.isArray(prev.tags) ? prev.tags.map(String) : [];
  const parsedRule = parseRecurrence(tags);
  const rule = withAnchorDay(parsedRule, scheduledDateOf(prev.dueDate, parsedRule) || undefined);
  if (!rule.freq || !rule.unit) return null;
  // Step from the SCHEDULED date: a row moved for one occurrence must not
  // re-anchor the series onto the day it was moved to.
  const base = String(scheduledDateOf(prev.dueDate, rule) || todayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  let next = advance(base, rule);
  // A chore finished late steps forward on its own anchor until it lands on
  // today or later: a weekly chore due ten days ago, done today, used to
  // spawn its next occurrence three days in the past — a brand-new overdue
  // row the moment the old one was ticked off. The anchor (weekday, day of
  // month) is kept; only the occurrences already missed are skipped.
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(todayISO || "")) ? String(todayISO) : null;
  if (today) {
    for (let guard = 0; next < today && guard < 1000; guard++) next = advance(next, rule);
  }
  if (seriesEnded(rule, next)) return null;
  // A skipped occurrence is stepped over, never landed on; a moved one lands
  // on the day it was moved to and remembers where it belongs.
  const open = firstUnskipped(next, rule);
  if (!open) return null;
  const spot = placed(open, rule);
  return {
    dueDate: spot.dueDate,
    tags: recurrenceToTags({ ...rule, done: rule.done + 1, movedFrom: spot.movedFrom }, tags),
  };
}

/**
 * What a recurring task that was never ticked off should look like TODAY.
 *
 * A series stores one row at its next due date and only completion moves it
 * (nextRecurringTaskSpawn). Skip a weekly chore and nothing ever advances it:
 * "Put out the trash" sat on Aug 13 reading "35 days overdue" five weeks
 * later, while the calendar — which projects occurrences from the rule — had
 * it on today. This is the other half of that projection: the row's due date
 * is carried forward to the LATEST occurrence on or before today. The
 * occurrences it passes were missed, not done, so `rdone:` is untouched and
 * the series keeps its anchor (weekday, day of month); a weekly chore missed
 * two days ago still reads two days overdue, never a month.
 *
 * Returns null when nothing changes: a one-time task, a done or paused row, a
 * due date today or later, or a series whose next occurrence is still ahead.
 * Returns `{ ended: true }` for a series that has already run out — its
 * `runtil:` is behind today — and whose last occurrence went unfinished: it
 * cannot be caught up on and the caller retires it.
 */
export function rollForwardRecurringTask(
  task: { dueDate?: string | null; tags?: string[] | null; status?: string | null },
  todayISO: string,
): { dueDate: string; tags: string[] } | { ended: true } | null {
  const today = String(todayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  if (String(task?.status || "") === "done") return null;
  const tags = Array.isArray(task?.tags) ? task.tags.map(String) : [];
  const base = String(task?.dueDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base) || base >= today) return null;
  const parsed = parseRecurrence(tags);
  const scheduled = scheduledDateOf(base, parsed);
  const rule = withAnchorDay(parsed, scheduled);
  if (!rule.freq || !rule.unit || rule.paused) return null;
  // The series ended before today and this occurrence was its last.
  if (rule.until && rule.until < today) return { ended: true };
  // An `rcount:` series on its final occurrence has nowhere to step to; a
  // missed occurrence is not a completed one, so it stays where it is.
  if (rule.count && rule.done + 1 >= rule.count) return null;
  let cur = scheduled;
  // Bounded: 5,000 daily steps is thirteen years; a series older than that
  // still moves forward and finishes on a later call.
  for (let guard = 0; guard < 5000; guard++) {
    const next = advance(cur, rule);
    if (next > today || next <= cur) break;
    if (rule.until && next > rule.until) break;
    cur = next;
  }
  if (cur === scheduled) return null;
  // Never roll ONTO an occurrence the user skipped: carry on to the next open
  // one, even when that is still ahead of today.
  const open = firstUnskipped(cur, rule);
  if (!open) return { ended: true };
  const spot = placed(open, rule);
  return { dueDate: spot.dueDate, tags: recurrenceToTags({ ...rule, movedFrom: spot.movedFrom }, tags) };
}

// ─── One occurrence at a time ────────────────────────────────────────────────

export type TaskOccurrenceAction = "skip" | "unskip" | "move" | "unmove" | "endBefore";

export type TaskOccurrenceResult =
  | { ok: true; dueDate: string; tags: string[]; ended?: boolean }
  | { ok: false; error: string };

/**
 * Skip, move or restore ONE scheduled occurrence of a recurring task, or end
 * the series before one. Pure: the server applies the result to the stored row
 * (Rule 6 — no client read-modify-write of the tag list).
 *
 * `date` is always the SCHEDULED date of the occurrence acted on.
 *
 *   skip       the date is recorded as skipped. When it is the open row's own
 *              date, the row steps to the next occurrence that is not skipped.
 *              The schedule itself is untouched — January stays January.
 *   unskip     the mark is removed. If the date is today or ahead and earlier
 *              than the open row, it becomes the open row again.
 *   move       that ONE occurrence happens on `newDate`. Later occurrences
 *              keep their scheduled dates.
 *   unmove     the occurrence returns to its scheduled date.
 *   endBefore  the series ends the day before `date` (history is kept).
 */
export function applyTaskOccurrenceAction(
  task: { dueDate?: string | null; tags?: string[] | null; status?: string | null },
  input: { action: TaskOccurrenceAction; date: string; newDate?: string },
  todayISO: string,
): TaskOccurrenceResult {
  const tags = Array.isArray(task?.tags) ? task.tags.map(String) : [];
  const due = String(task?.dueDate || "").slice(0, 10);
  const date = String(input.date || "").slice(0, 10);
  if (!ISO_DAY_RE.test(due)) return { ok: false, error: "This task has no due date." };
  if (!ISO_DAY_RE.test(date)) return { ok: false, error: "date (YYYY-MM-DD) required" };
  if (String(task?.status || "") === "done") return { ok: false, error: "This occurrence is already completed." };
  const parsed = parseRecurrence(tags);
  const scheduled = scheduledDateOf(due, parsed);
  const rule = withAnchorDay(parsed, scheduled);
  if (!rule.freq || !rule.unit) return { ok: false, error: "This task does not repeat." };
  if (date < scheduled && input.action !== "unskip") {
    return { ok: false, error: "That occurrence is already behind this series." };
  }

  const skipped = new Set(rule.skipped || []);
  const moved: Record<string, string> = { ...(rule.moved || {}) };
  const finish = (next: RecurrenceRule, dueDate: string): TaskOccurrenceResult =>
    ({ ok: true, dueDate, tags: recurrenceToTags(next, tags) });

  switch (input.action) {
    case "skip": {
      skipped.add(date);
      delete moved[date];
      const next: RecurrenceRule = { ...rule, skipped: [...skipped], moved };
      if (date !== scheduled) return finish(next, due);
      // Skipping the open occurrence: step to the next one that is not skipped.
      const after = advance(scheduled, rule);
      const open = after > scheduled ? firstUnskipped(after, next) : null;
      if (!open || (rule.count && rule.done + 1 >= rule.count)) {
        // Nothing left to step to: the series has run out. The row stays where
        // it is, marked skipped, so the caller can retire it.
        return { ok: true, dueDate: due, tags: recurrenceToTags(next, tags), ended: true };
      }
      const spot = placed(open, next);
      return finish({ ...next, movedFrom: spot.movedFrom }, spot.dueDate);
    }
    case "unskip": {
      if (!skipped.has(date)) return finish(rule, due);
      skipped.delete(date);
      const next: RecurrenceRule = { ...rule, skipped: [...skipped], moved };
      // Restoring an occurrence the series already stepped past: while it is
      // still today or ahead, it is the open occurrence again. One that is
      // already behind today stays behind — it reads as missed, not as a
      // brand-new overdue chore.
      if (date < scheduled && date >= String(todayISO || "").slice(0, 10)) {
        const spot = placed(date, next);
        return finish({ ...next, movedFrom: spot.movedFrom }, spot.dueDate);
      }
      return finish(next, due);
    }
    case "move": {
      const to = String(input.newDate || "").slice(0, 10);
      if (!ISO_DAY_RE.test(to)) return { ok: false, error: "newDate (YYYY-MM-DD) required" };
      skipped.delete(date);
      if (to === date) delete moved[date]; else moved[date] = to;
      const next: RecurrenceRule = { ...rule, skipped: [...skipped], moved };
      if (date !== scheduled) return finish(next, due);
      return finish({ ...next, movedFrom: to === date ? undefined : date }, to);
    }
    case "unmove": {
      delete moved[date];
      const next: RecurrenceRule = { ...rule, moved };
      if (date !== scheduled) return finish(next, due);
      return finish({ ...next, movedFrom: undefined }, date);
    }
    case "endBefore": {
      const d = new Date(date + "T00:00:00");
      d.setDate(d.getDate() - 1);
      const until = toLocalISO(d);
      return { ok: true, dueDate: due, tags: recurrenceToTags({ ...rule, until }, tags), ...(date <= scheduled ? { ended: true } : {}) };
    }
    default:
      return { ok: false, error: "Unknown action" };
  }
}


/**
 * Change a task's repeat rule on the tags AS STORED.
 *
 * The series' progress (`rdone:`) and its per-occurrence marks (skips, moves)
 * are kept; the day-of-month anchor is re-pinned from the row's scheduled date
 * because a new cadence means a new anchor. `freq: ""` stops the repetition
 * and leaves a one-time task on its current date.
 */
export function applyTaskSchedule(
  task: { dueDate?: string | null; tags?: string[] | null },
  patch: { freq?: string; until?: string | null; count?: number | null; paused?: boolean },
): string[] {
  const tags = Array.isArray(task?.tags) ? task.tags.map(String) : [];
  const cur = parseRecurrence(tags);
  const freq = patch.freq !== undefined ? String(patch.freq || "") : cur.freq;
  if (!freq) return recurrenceToTags({ freq: "", interval: 1, unit: "", done: 0, paused: false }, tags);
  const { unit, interval } = freqToUnit(freq);
  if (!unit) return tags; // an unknown cadence changes nothing
  const until = patch.until !== undefined ? (patch.until && ISO_DAY_RE.test(patch.until) ? patch.until : undefined) : cur.until;
  const count = patch.count !== undefined
    ? (patch.count && patch.count > 0 ? Math.floor(patch.count) : undefined)
    : cur.count;
  const next: RecurrenceRule = withAnchorDay({
    freq, unit, interval,
    // One end condition at a time: choosing a date clears a count and back.
    until: patch.count ? undefined : until,
    count: patch.until ? undefined : count,
    done: cur.done,
    paused: patch.paused !== undefined ? !!patch.paused : cur.paused,
    skipped: cur.skipped,
    moved: cur.moved,
    movedFrom: cur.movedFrom,
  }, scheduledDateOf(task?.dueDate, cur) || undefined);
  return recurrenceToTags(next, tags);
}
