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

const RECUR_TAG_RE = /^(recur:|runtil:|rcount:|rdone:|ranchor:|rpaused$)/;
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
  return { freq, interval, unit, until, count, done, paused, anchorDay };
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
  return base;
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

function fmtShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Human-readable schedule summary, e.g. "Repeats every 2 weeks on Friday until Dec 31".
export function humanSummary(rule: RecurrenceRule, dueDate?: string): string {
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
  if (rule.until) s += ` until ${fmtShort(rule.until)}`;
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
  const rule = withAnchorDay(parseRecurrence(tags), prev.dueDate || undefined);
  if (!rule.freq || !rule.unit) return null;
  const base = String(prev.dueDate || todayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const next = advance(base, rule);
  if (seriesEnded(rule, next)) return null;
  return { dueDate: next, tags: recurrenceToTags({ ...rule, done: rule.done + 1 }, tags) };
}
