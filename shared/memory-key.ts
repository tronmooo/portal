// The key a remembered fact is stored under: its SUBJECT.
//
// "my library card number is 20418"  → my_library_card_number
// "my library card PIN is 7731"      → my_library_card_pin      (its own memory)
// "my library card number is 99999"  → my_library_card_number   (updates the first)
// "the garage code = 4471"           → the_garage_code
// "Sam prefers window seats"         → sam_prefers_window_seats (no "is": the statement itself)
//
// The key used to be the first three words of the statement, so two different
// facts about one thing overwrote each other. Guard: tests/memory-key.test.ts.
const LINK = /\s+(?:is|are|was|were|will be|equals)\s+|\s*[=:]\s+/i;

export function memoryKeyFor(statement: string): string {
  const text = String(statement || "").trim().replace(/\s+/g, " ");
  const cut = text.search(LINK);
  // the subject, when the statement has one and it is not the whole sentence
  const subject = cut > 0 && cut <= 80 ? text.slice(0, cut) : text.split(" ").slice(0, 6).join(" ");
  const key = subject.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return key || "note";
}
