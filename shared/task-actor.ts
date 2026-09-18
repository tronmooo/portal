// ── Who DOES a task? ─────────────────────────────────────────────────────────
// Pure, no I/O.
//
// A task's owner is the person who has to do it, not the person it is about.
// "My sister Dana lives in Austin … and I need to call her about Thanksgiving"
// produced "Call Dana about Thanksgiving" OWNED BY DANA (QA 2026-09-18, F-24):
// the model set forProfile:"Dana" because her name was in the sentence, so
// the task left the speaker's Tasks page, calendar and "Tasks due" count and
// showed only under Dana's filter — as if Dana had to call herself.
//
// The rule: a task the speaker says THEY will do belongs to the speaker; the
// named person is the subject. Only when the sentence says the OTHER person
// must do it ("Dana needs to call the dentist", "remind Dana to…", "a task
// for Max to get groomed") is that person the owner. Everything else keeps
// the model's attribution — "Max owes me $50" style debts are deliberately
// filed under the other person, and this module does not second-guess them.

export type TaskActor = "self" | "named" | "unspecified";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Sarah Miller" → matches "Sarah Miller" or "Sarah"; "Max" → "Max". */
function nameAlternatives(personName: string): string {
  const parts = String(personName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const full = parts.map(escapeRe).join("\\s+");
  const first = escapeRe(parts[0]);
  return parts.length > 1 ? `(?:${full}|${first})` : first;
}

const THIRD_PERSON_PRONOUN = "he|she|they|him|her|them";

// Verbs of obligation/intent that follow an actor: "X needs to", "X has to",
// "X should", "X is going to", "X will".
const OBLIGATION = String.raw`(?:needs?|has|have|had|must|should|ought|wants?|is|are|was|were|will|'ll|gotta|got|plans?)`;

/**
 * Split a message into the clauses a to-do can live in, and return the one
 * that shares the most words with the task's title (the whole message when
 * nothing stands out). "Dana lives in Austin, and I need to call her" is two
 * clauses; the second is the one that made this task.
 */
export function clauseForTask(userMessage: string, title: string): string {
  const msg = String(userMessage || "").trim();
  if (!msg) return "";
  const clauses = msg
    .split(/(?:[.;!?\n]+|,\s*(?:and\s+|then\s+|also\s+)?|\s+(?:and|then|also|plus)\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length <= 1) return msg;
  const STOP = new Set(["a", "an", "the", "to", "for", "of", "in", "on", "at", "about", "with", "my", "me", "i", "and", "her", "him", "them", "it", "this", "that"]);
  const tokens = (s: string) => new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t && !STOP.has(t)),
  );
  const want = tokens(title);
  let best = "";
  let bestScore = 0;
  for (const c of clauses) {
    let score = 0;
    tokens(c).forEach((t) => { if (want.has(t)) score++; });
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return bestScore > 0 ? best : msg;
}

/**
 * Who the sentence says will do the task.
 *
 * `personName` is the profile the task is about to be filed under (the
 * model's forProfile, or the name found in the title). The answer is read
 * from the clause of `userMessage` that produced the task, falling back to
 * the title itself: "Call Dana" is something the speaker does to Dana.
 */
export function resolveTaskActor(opts: {
  title: string;
  userMessage?: string | null;
  personName?: string | null;
}): TaskActor {
  const title = String(opts.title || "").trim();
  const name = nameAlternatives(String(opts.personName || ""));
  const clause = clauseForTask(String(opts.userMessage || ""), title);
  const who = name ? `(?:${name}|${THIRD_PERSON_PRONOUN})` : `(?:${THIRD_PERSON_PRONOUN})`;

  if (clause) {
    const namedDoes = [
      new RegExp(String.raw`\b${who}\s+${OBLIGATION}\b`, "i"),
      new RegExp(String.raw`\bremind\s+${who}\b`, "i"),
      new RegExp(String.raw`\b(?:task|to-?do|todo|reminder|chore)\s+for\s+${who}\b`, "i"),
      new RegExp(String.raw`\bfor\s+${who}\s+to\b`, "i"),
      new RegExp(String.raw`\b(?:get|have|make|tell|ask)\s+${who}\s+to\b`, "i"),
      ...(name ? [new RegExp(String.raw`\b${name}['’]s\s+(?:task|to-?do|todo|job|turn|chore)\b`, "i")] : []),
    ];
    if (namedDoes.some((re) => re.test(clause))) return "named";

    const speakerDoes = [
      new RegExp(String.raw`\b(?:i|i'll|i've|i'd|i'm|we|we'll|we've|we're)\s+${OBLIGATION}\b`, "i"),
      /\bremind\s+me\b/i,
      /\bnote to self\b/i,
      /\bmy\s+(?:task|to-?do|todo|job|turn|chore)\b/i,
      /\bi\s+(?:need|have|want|got|must|should|gotta)\b/i,
    ];
    if (speakerDoes.some((re) => re.test(clause))) return "self";
  }

  // The title alone: contacting someone is something the speaker does TO
  // that person — "Call Dana", "Text Mom back", "Email Sarah the photos".
  if (name && new RegExp(String.raw`^(?:call|phone|ring|text|email|e-mail|message|dm|facetime|write to|visit|check on)\s+${name}\b`, "i").test(title)) {
    return "self";
  }
  return "unspecified";
}
