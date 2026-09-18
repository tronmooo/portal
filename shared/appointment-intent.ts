// shared/appointment-intent.ts — is this message an APPOINTMENT, or an errand
// to go and BOOK one?
//
// QA 2026-09-18 BUG-04: "i need to remember to call the dentist next tuesday
// to book a cleaning" produced the task the user asked for — and, unreported,
// a calendar event "Dentist cleaning" at a made-up time. Nothing in the
// message says a cleaning is booked; the only thing that has a date is the
// phone call. A calendar appointment exists only when the user STATES one
// ("I have a dentist appointment Tuesday at 2", "booked a cleaning for the
// 24th"); "call X to book Y" is a task, and Y is not on the calendar until
// the user says it is.
//
// Pure and I/O-free. Pinned by tests/appointment-intent.test.ts.

const STOP = new Set([
  "a", "an", "the", "to", "for", "my", "our", "his", "her", "their", "and", "or",
  "of", "at", "in", "on", "with", "about", "up", "book", "schedule", "set", "make",
  "arrange", "get", "call", "phone", "ring", "contact", "email", "text", "need", "remember",
  "rember", "remind", "me", "i", "next", "this", "tomorrow", "today", "appointment", "appt",
]);

/** Verbs that mean "go and arrange it" — the thing arranged is not yet real. */
const BOOKING_ERRAND_RE =
  /\b(?:call|phone|ring|contact|email|text|message|reach\s+out\s+to|get\s+(?:a\s+)?hold\s+of)\b([^.!?\n]{0,80}?)\b(?:to\s+)?(?:book|schedule|make|set\s*up|arrange|reschedule|get)\b\s*(?:an?\s+|the\s+|my\s+)?([^.!?\n]{0,80})/gi;

/** The user saying an appointment EXISTS (booked, scheduled, "I have … at"). */
const STATED_APPOINTMENT_RE =
  /\b(?:(?:i|we|she|he|they)\s+(?:have|has|got|'ve\s+got|booked|scheduled)\s+(?:an?\s+|my\s+|the\s+)?(?:[\w-]+\s+){0,3}?(?:appointment|appt|cleaning|checkup|check-up|visit|consult(?:ation)?|meeting|session|exam)\b|\b(?:appointment|appt|cleaning|checkup|check-up|visit|consult(?:ation)?|meeting|session|exam)\s+(?:is|was|'s)\s+(?:booked|scheduled|set|confirmed|on|at|for)\b|\b(?:booked|scheduled|confirmed)\s+(?:an?\s+|my\s+|the\s+|for\s+)?(?:[\w-]+\s+){0,3}?(?:appointment|appt|cleaning|checkup|check-up|visit|consult(?:ation)?|meeting|session|exam)\b|\bappointment\s+(?:with|at)\b)/i;

function tokens(s: string): string[] {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export interface BookingErrand {
  /** Who is being called ("the dentist"). */
  who: string;
  /** What is being booked ("a cleaning"). */
  what: string;
}

/** Every "call X to book Y" clause in the message. */
export function bookingErrands(message: string): BookingErrand[] {
  const out: BookingErrand[] = [];
  const text = String(message || "");
  BOOKING_ERRAND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BOOKING_ERRAND_RE.exec(text))) {
    const who = (m[1] || "").trim();
    const what = (m[2] || "").trim();
    if (!who && !what) continue;
    out.push({ who, what });
  }
  return out;
}

/** True when the message states that an appointment/booking exists. */
export function statesAppointment(message: string): boolean {
  return STATED_APPOINTMENT_RE.test(String(message || ""));
}

/**
 * True when creating a calendar event titled `eventTitle` from this message
 * would FABRICATE an appointment: the message only says to call/contact
 * someone to book it, the event's title is about that same thing, and the
 * user never states the appointment exists.
 *
 *   isFabricatedAppointment("call the dentist next tuesday to book a cleaning", "Dentist cleaning") → true
 *   isFabricatedAppointment("I have a dentist cleaning Tuesday at 2",          "Dentist cleaning") → false
 *   isFabricatedAppointment("call the dentist to book a cleaning; standup Friday 3pm", "Standup") → false
 */
export function isFabricatedAppointment(message: string, eventTitle: string): boolean {
  const errands = bookingErrands(message);
  if (errands.length === 0) return false;
  if (statesAppointment(message)) return false;
  const title = new Set(tokens(eventTitle));
  if (title.size === 0) return false;
  for (const e of errands) {
    const subject = tokens(`${e.who} ${e.what}`);
    if (subject.some((w) => title.has(w) || [...title].some((t) => t.startsWith(w) || w.startsWith(t)))) return true;
  }
  return false;
}
