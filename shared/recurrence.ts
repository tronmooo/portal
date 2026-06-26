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

export interface RecurrenceRule {
  freq: string; // "" = does not repeat
  interval: number; // N for every-N-*
  unit: "day" | "week" | "month" | "year" | "weekday" | "";
  until?: string; // YYYY-MM-DD
  count?: number; // end after N occurrences
  done: number; // completed occurrences so far
  paused: boolean;
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

const RECUR_TAG_RE = /^(recur:|runtil:|rcount:|rdone:|rpaused$)/;
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
  return { freq, interval, unit, until, count, done, paused };
}

// Build the recurrence-related tags, preserving any non-recurrence tags passed in.
export function recurrenceToTags(rule: RecurrenceRule, existing: string[] = []): string[] {
  const base = existing.filter((t) => !RECUR_TAG_RE.test(t));
  if (!rule.freq) return base;
  base.push(`recur:${rule.freq}`);
  if (rule.until) base.push(`runtil:${rule.until}`);
  if (rule.count) base.push(`rcount:${rule.count}`);
  if (rule.done) base.push(`rdone:${rule.done}`);
  if (rule.paused) base.push("rpaused");
  return base;
}

export function isRecurring(tags: string[] = []): boolean {
  return tags.some((t) => t.startsWith("recur:"));
}

function toLocalISO(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

// Advance a date string by exactly one cycle of the rule.
export function advance(dateStr: string, rule: RecurrenceRule): string {
  const d = new Date(dateStr + "T00:00:00");
  if (rule.unit === "day") d.setDate(d.getDate() + rule.interval);
  else if (rule.unit === "week") d.setDate(d.getDate() + 7 * rule.interval);
  else if (rule.unit === "month") d.setMonth(d.getMonth() + rule.interval);
  else if (rule.unit === "year") d.setFullYear(d.getFullYear() + rule.interval);
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
    const dom = dueDate ? new Date(dueDate + "T00:00:00").getDate() : null;
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
