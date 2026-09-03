/**
 * Does a typed name refer to a stored one?
 *
 * The AI's entity lookups fell back to `name.includes(search)`: a name typed
 * in chat that sits INSIDE an existing name was taken for it. "Ann owns half
 * the car" linked Joanna; "move the lunch to Ann" filed it under Joanna; and
 * because a person "not found" is auto-created, Ann was never created at all
 * — a wrong entity, silently.
 *
 * The rule here keeps the helpful part of the old one and drops the trap: a
 * name matches when it is the whole name, or when it starts a WORD of the
 * name ("civic" → "Honda Civic", "joan" → "Joanna", "car loan" → "Car Loan
 * (Toyota)"). A fragment from the middle of a word ("ann" in "Joanna", "vic"
 * in "Civic") does not.
 */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const NOT_WORD_CHAR = /[^a-z0-9]/;

export function nameLooselyMatches(name: unknown, search: unknown): boolean {
  const n = norm(name), q = norm(search);
  if (!n || !q) return false;
  if (n === q) return true;
  let from = 0;
  while (true) {
    const i = n.indexOf(q, from);
    if (i < 0) return false;
    if (i === 0 || NOT_WORD_CHAR.test(n.charAt(i - 1))) return true;
    from = i + 1;
  }
}
