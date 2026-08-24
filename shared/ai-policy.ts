// shared/ai-policy.ts — DIRECTIONAL ENTITY AUTHORIZATION.
//
// The question this module answers is not "are these two entities similar?"
// but "the user asked for an X; is a tool that writes a Y serving that
// request?" Those are different questions, and answering the first one in
// place of the second is what made the old compatibility sets unsafe.
//
// The sets it replaces were symmetric and unconditional:
//
//     ["expense", "income"]                  ← opposite cash directions
//     ["obligation", "liability", "expense"] ← a service bill is not a debt
//     ["tracker", "journal"]                 ← a narrative is not a log entry
//     ["goal", "habit", "tracker"]           ← a goal is not permission to
//                                              create a habit
//     ["task", "event"]                      ← a timed task projects onto the
//                                              calendar; it is not an event
//
// Because membership was symmetric, "log $20 for lunch" could be served by
// log_income and "journal this" could be served by log_tracker_entry — the
// gate had no way to say that one direction is a legitimate refinement and
// the other is a semantic mistake.
//
// Every allowance here is therefore a DIRECTED edge with a written reason,
// and some carry a CONDITION on the message that must also hold. Anything not
// listed is refused. Pure and dependency-free: the gate uses it, tests pin it.

import type { IntentEntity } from "./ai-intent";

/**
 * One directed allowance: the user asked for `asked`, and a tool that writes
 * `wrote` is nonetheless serving that request.
 */
export interface EntityAllowance {
  asked: IntentEntity;
  wrote: IntentEntity;
  /** True when the same allowance holds with `asked` and `wrote` swapped. */
  bothWays?: boolean;
  /** Why this direction is safe. Shown in routing logs, never to the user. */
  reason: string;
  /**
   * Extra condition on the user's message. When present, the allowance holds
   * only if this returns true. A caller with no message in hand (the same-turn
   * duplicate guard) treats a conditional allowance as NOT satisfied, which
   * errs toward keeping both records rather than refusing a legitimate create.
   */
  when?: (lowercasedMessage: string) => boolean;
}

/** Money leaving the user's hands that turns out to settle something owed. */
const PAYMENT_LANGUAGE =
  /\b(pa(?:y|id|ying|yment)s?|bills?|due|owe[ds]?|owing|invoices?|statements?|balance|minimum|installments?|premiums?)\b/;

/** The user reached for both vocabularies in one breath. */
const namesBoth = (a: RegExp, b: RegExp) => (m: string) => a.test(m) && b.test(m);

const TASK_NOUN = /\btasks?\b|\bto-?dos?\b|\bchores?\b|\bremind(?:er|ers)?\b/;
const EVENT_NOUN = /\bevents?\b|\bappointments?\b|\bmeetings?\b|\bcalendar\b/;

/**
 * THE ALLOWANCE TABLE.
 *
 * Read each row as: "the user asked for `asked`; a tool writing `wrote` is
 * still serving them, because `reason`."
 */
export const ENTITY_ALLOWANCES: EntityAllowance[] = [
  // ── Same storage, different word ──────────────────────────────────────────
  // Assets, vehicles, properties, subscriptions and financial accounts are all
  // profile rows. Which noun the user reached for does not change the table.
  {
    asked: "asset", wrote: "profile", bothWays: true,
    reason: "assets, vehicles, properties and accounts are profile rows — one table, two words for it",
  },
  // A note is an artifact row of type "note" at the storage layer.
  {
    asked: "note", wrote: "artifact", bothWays: true,
    reason: "a note is stored as an artifact row of type note",
  },
  // Both are "reference information the user wants back later"; which one fits
  // is a judgement the prompt makes, not a mistake the gate should refuse.
  // NOTE AND JOURNAL ARE DELIBERATELY ABSENT — see the refusals below.
  {
    asked: "note", wrote: "memory", bothWays: true,
    reason: "a note and a saved fact are both reference information; the prompt picks between them",
  },

  // ── Directed refinements ──────────────────────────────────────────────────
  // Money going out MAY turn out to be settling a bill or a debt: "I paid $120
  // for electricity" is an expense-shaped sentence that pay_obligation serves
  // correctly. The reverse is not true — a user who said "bill" or "loan" and
  // got a bare expense row lost the schedule, the balance and the due date.
  {
    asked: "expense", wrote: "obligation",
    when: (m) => PAYMENT_LANGUAGE.test(m),
    reason: "spending language can describe paying a bill, when the message is payment-shaped",
  },
  {
    asked: "expense", wrote: "liability",
    when: (m) => PAYMENT_LANGUAGE.test(m),
    reason: "spending language can describe a debt payment, when the message is payment-shaped",
  },
  // Bill and debt are both amounts owed, and the honest classifier is the
  // financial behaviour rather than the noun. The prompt routes between them;
  // whichever it picks, the user asked about something they owe.
  {
    asked: "obligation", wrote: "liability", bothWays: true,
    reason: "bills and debts are both amounts owed — classified by financial behaviour, not by noun",
  },
  // A goal is measured BY a tracker, and a measurable habit links to the
  // tracker that measures it. Both are downhill: the measurement is created in
  // service of the thing the user asked for. Neither runs uphill — see below.
  {
    asked: "goal", wrote: "tracker",
    reason: "a goal is measured by a tracker, so creating the measurement serves the goal",
  },
  {
    asked: "habit", wrote: "tracker",
    reason: "a measurable habit links to the tracker that measures it (create_habit does this itself)",
  },

  // ── Mixed vocabulary ──────────────────────────────────────────────────────
  // "Add my dentist appointment to my tasks" names both. The user mixed the
  // words, so the gate has no business picking a winner and blocking the other.
  // Without both nouns present, task and event stay distinct: a timed task
  // projects onto the calendar, but it is not an event.
  {
    asked: "task", wrote: "event", bothWays: true,
    when: namesBoth(TASK_NOUN, EVENT_NOUN),
    reason: "the message names both a task and an event — the user mixed vocabularies",
  },
];

/**
 * Directions that are refused ON PURPOSE, each with the failure it prevents.
 *
 * Nothing consults this at runtime — an unlisted pair is refused by default.
 * It exists so the reasoning is in the codebase rather than in a review
 * thread, and so tests can assert the refusals are still refusals.
 */
export const DOCUMENTED_REFUSALS: Array<{ asked: IntentEntity; wrote: IntentEntity; reason: string }> = [
  { asked: "expense", wrote: "income", reason: "opposite cash directions — money out is never money in" },
  { asked: "income", wrote: "expense", reason: "opposite cash directions — money in is never money out" },
  { asked: "obligation", wrote: "expense", reason: "a bill carries a schedule and a due date; a bare expense row loses both" },
  { asked: "liability", wrote: "expense", reason: "a debt carries a balance and a payoff; a bare expense row loses both" },
  { asked: "journal", wrote: "tracker", reason: "a narrative may mention an activity without reporting a loggable occurrence" },
  { asked: "tracker", wrote: "journal", reason: "an explicit request to track a metric is not answered by prose" },
  { asked: "journal", wrote: "note", reason: "the 2026-08-20 fix: a request that says NOTE must not become a journal entry, or the reverse" },
  { asked: "note", wrote: "journal", reason: "the 2026-08-20 fix: a request that says NOTE must not become a journal entry" },
  { asked: "goal", wrote: "habit", reason: "creating a goal does not authorize creating a habit" },
  { asked: "habit", wrote: "goal", reason: "'make meditation a habit' asks for a habit, not a target to hit" },
  { asked: "tracker", wrote: "habit", reason: "asking to track a metric does not ask for a routine to keep" },
  { asked: "tracker", wrote: "goal", reason: "asking to track a metric does not set a target for it" },
  { asked: "task", wrote: "event", reason: "a timed task projects onto the calendar; it is not interchangeable with an event" },
  { asked: "event", wrote: "task", reason: "an appointment is something that happens, not something the user does" },
];

/**
 * Is a tool that writes `wrote` serving a user who asked for `asked`?
 *
 * `message` is the user's message, used by conditional allowances. Omit it and
 * conditional allowances do not apply — callers without a message in hand get
 * the unconditional answer.
 */
export function isWriteAuthorized(
  asked: IntentEntity,
  wrote: IntentEntity,
  message?: string,
): boolean {
  return explainAuthorization(asked, wrote, message) !== null;
}

/**
 * The allowance that authorizes this direction, or null when none does.
 * Same inputs as `isWriteAuthorized`, with the reason attached for logs.
 */
export function explainAuthorization(
  asked: IntentEntity,
  wrote: IntentEntity,
  message?: string,
): EntityAllowance | null {
  // Identity is always authorized.
  if (asked === wrote) {
    return { asked, wrote, reason: "same entity" };
  }
  // An unclassified intent gates nothing: the rest of the pipeline decides.
  if (asked === "unknown" || wrote === "unknown") {
    return { asked, wrote, reason: "intent not classified — the gate stays out of it" };
  }

  const m = String(message ?? "").toLowerCase();
  for (const rule of ENTITY_ALLOWANCES) {
    const forward = rule.asked === asked && rule.wrote === wrote;
    const backward = rule.bothWays === true && rule.asked === wrote && rule.wrote === asked;
    if (!forward && !backward) continue;
    // A conditional allowance with no message to test is not satisfied.
    if (rule.when && !(message && rule.when(m))) continue;
    return rule;
  }
  return null;
}
