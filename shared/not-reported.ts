// What the user's sentence did NOT report.
//
// The chat records that something happened — a workout, a dose, money spent —
// from an ordinary sentence. Two kinds of sentence are not such a report:
//
//   "I didn't go to the gym today"   — it did not happen
//   "My sister spent $200 on shoes"  — it happened to someone else
//
// Chat variations, 2026-11-24: the first logged a gym session (≈30 min, ≈165
// kcal) and created a Gym tracker; the second was filed as the user's own
// $200 expense. Habit check-ins already refuse both
// (shared/habit-completion-intent.ts); tracker logs and money did not.
//
// The rule is about the SENTENCE, read conservatively: a refusal here means
// the user's data is not recorded, so anything that could carry a real report
// in a second clause ("I didn't sleep well, only 5 hours", "I skipped lunch
// but had a $4 coffee") is left to the model. Pure, no I/O.
import { hasThirdPersonSubject } from "./habit-completion-intent";

export type NotReportedReason = "denied" | "someone_else";

/** Tools that record that something HAPPENED (as opposed to planning or editing). */
const OCCURRENCE_TOOLS = new Set([
  "log_tracker_entry", "log_medication_dose", "checkin_habit",
  "create_expense", "log_income", "add_liability_payment", "pay_obligation", "mark_loan_payment",
]);

export function recordsAnOccurrence(toolName: string): boolean {
  return OCCURRENCE_TOOLS.has(toolName);
}

/** "didn't", "haven't", "couldn't", "forgot to" … about the speaker's own doing. */
const DENIAL =
  /\b(?:i|we)\s+(?:(?:really|just|still|actually|totally|sadly)\s+)?(?:didn'?t|did\s+not|haven'?t|have\s+not|hadn'?t|couldn'?t|could\s+not|wasn'?t\s+able\s+to|was\s+not\s+able\s+to|weren'?t\s+able\s+to|forgot\s+to|failed\s+to|never\s+(?:got|made|went|did|had|took)|won'?t\s+be|am\s+not\s+going\s+to|'m\s+not\s+going\s+to)\b|^\s*(?:didn'?t|did\s+not|haven'?t|couldn'?t|forgot\s+to)\b/i;

/**
 * A second clause that could hold a real report. With one of these the
 * sentence is not ONLY a denial, and what to record is the model's call.
 */
const SECOND_CLAUSE = /[,;:—–]|\b(?:but|and|however|though|although|except|instead|only|then|also|so\s+i|just\s+\d|\d+\s*(?:hours?|hrs?|minutes?|mins?|miles?|km|lbs?|kg|oz|cups?|calories|kcal|dollars?|bucks))\b|\$\s?\d/i;

/** A question is not a report either way; the read-only turn guard owns those. */
const QUESTION = /\?\s*$/;

const RELATION =
  "sister|brother|mom|mum|mother|dad|father|wife|husband|son|daughter|kid|kids|child|children|parents?|" +
  "friend|buddy|boss|coworker|co-worker|colleague|roommate|room-mate|neighbou?r|partner|girlfriend|boyfriend|fianc[eé]e?|" +
  "uncle|aunt|cousin|nephew|niece|grandma|grandpa|grandmother|grandfather|in-laws?|landlord|tenant";
const PAST_IRREGULAR =
  "spent|bought|paid|ran|went|ate|drank|took|got|had|made|did|slept|swam|rode|drove|lost|won|gave|sold|wrote|read|saw|" +
  "lifted|fed|met|built|sent|left|kept|caught|flew|sang|woke|hit|cut|put";
/** "My sister spent…", "our neighbour's dog ate…" — the subject is another person. */
const RELATION_SUBJECT = new RegExp(
  `^\\s*(?:my|our)\\s+(?:\\w+\\s+)?(?:${RELATION})(?:'s\\s+\\w+)?\\s+(?:just\\s+|already\\s+|also\\s+)?(?:\\w+ed|${PAST_IRREGULAR})\\b`,
  "i",
);

/** True when the tool call names somebody other than the speaker as its owner. */
function namesAnotherOwner(input: Record<string, any> | null | undefined): boolean {
  const who = String(input?.forProfile ?? input?.profileName ?? input?.owner ?? "").trim().toLowerCase();
  return !!who && !/^(?:me|myself|self|i|mine|my|user|you)$/.test(who);
}

/**
 * Why this sentence is not a report the tool may record, or null when it is
 * (or when it is not clearly otherwise).
 *
 *   denied        the whole sentence says the speaker did NOT do it
 *   someone_else  the subject is another person, and the call files it under
 *                 the speaker (a call that names that person's profile is a
 *                 legitimate record for them — "Rex ran 2 miles")
 */
export function whyNotReported(message: unknown, toolInput?: Record<string, any> | null): NotReportedReason | null {
  const m = String(message ?? "").trim();
  if (!m || QUESTION.test(m)) return null;
  if (DENIAL.test(m) && !SECOND_CLAUSE.test(m)) return "denied";
  if (!namesAnotherOwner(toolInput) && (RELATION_SUBJECT.test(m) || hasThirdPersonSubject(m))) return "someone_else";
  return null;
}
