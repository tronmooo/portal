// Two facts about a chat message, read conservatively, that decide what a
// date tool may do — independent of what the model chose.
//
// 1. A weekday named ON that weekday is today (owner, 2026-11-27: "Friday on
//    a Friday should mean today unless the user specifies next Friday or
//    otherwise indicates a future date"). The model was told; it still filed
//    "todo pick up dry cleaning friday" a week out on some runs.
//
// 2. A statement of something new does not move something that exists.
//    "lunch with Sam tomorrow at noon" MOVED an existing "Lunch with Sam" from
//    December 3 to tomorrow (chat-variations check, preview, 2026-11-27): the
//    earlier lunch was lost and no new one was made. An existing event or task
//    is re-dated only when the message asks for a change.
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** True when the message names today's weekday, alone, with nothing pointing later. */
export function bareWeekdayMeansToday(message: unknown, todayISO: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayISO)) return false;
  const today = DAYS[new Date(`${todayISO}T12:00:00Z`).getUTCDay()];
  const named = DAYS.filter((d) => new RegExp(`\\b${d}s?\\b`).test(text));
  if (named.length !== 1 || named[0] !== today) return false;
  // "next Friday", "Friday next week", "the following Friday", "a week from Friday", "Friday after next"
  if (new RegExp(`\\b(?:next|following)\\s+(?:week\\s+)?${today}\\b|\\b${today}\\s+(?:next\\s+week|after\\s+next|week)\\b|\\bweek\\s+(?:from|on|after)\\b|\\bin\\s+(?:a|one|two|\\d+)\\s+weeks?\\b|\\bnext\\s+week\\b|\\bevery\\b|\\beach\\b|\\bweekly\\b`).test(text)) return false;
  // another explicit day in the message decides instead
  // (a month counts only beside a day number: "Marriott" is not March)
  const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  if (new RegExp(`\\b(?:tomorrow|yesterday)\\b|\\d{4}-\\d{2}-\\d{2}|\\b\\d{1,2}\\/\\d{1,2}\\b|\\b${MONTH}\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`).test(text)) return false;
  return true;
}

/** The date a create should carry: today, when the model put a bare today-weekday a week out. */
export function correctBareWeekday(date: unknown, message: unknown, todayISO: string): string | null {
  const d = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!bareWeekdayMeansToday(message, todayISO)) return null;
  const weekOut = new Date(`${todayISO}T12:00:00Z`);
  weekOut.setUTCDate(weekOut.getUTCDate() + 7);
  return d === weekOut.toISOString().slice(0, 10) ? todayISO : null;
}

const CHANGE = /\b(?:move[ds]?|moving|reschedul\w*|push(?:ed|ing)?|postpon\w*|delay\w*|bump\w*|shift\w*|chang(?:e|ed|ing)\s+(?:it|that|this|the|my|our)\b|chang(?:e|ed|ing)\s+\w+(?:\s+\w+)?\s+to\b|updat\w*|edit\w*|renam\w*|instead|make\s+(?:it|that|the)|actually|correction|oops|whoops|no[,.]?\s+wait|i\s+meant|i\s+mean|should\s+(?:be|have\s+been)|cancel\w*|switch\w*|swap\w*|set\s+(?:it|that|the)|bring\s+\w+\s+forward|earlier|later|not\s+(?:on|at)|extend\w*|shorten\w*|fix\w*|correct\w*|replace\w*|adjust\w*|modify\w*|mark\w*|complete\w*|done|finish\w*|skip\w*|add\s+(?:a\s+)?(?:note|location|reminder)|remind\w*|repeat\w*|every|recurring|same\s+(?:time|day))\b/i;

/** Does the message ask for a change to something that exists? */
export function asksForAChange(message: unknown): boolean {
  return CHANGE.test(String(message ?? ""));
}

/** Does this update re-date (or re-time) the record? */
export function changesWhen(changes: unknown): boolean {
  if (!changes || typeof changes !== "object") return false;
  return ["date", "time", "dueDate", "dueTime", "startDate", "endDate", "endTime", "start", "end"].some((k) => (changes as Record<string, unknown>)[k] !== undefined);
}
