// Fuzzy habit-name matching for the AI assistant.
//
// THE BUG THIS FIXES: habit lookups used a naive `name.toLowerCase().includes(query)`
// check. That only matches when the query is a *substring of the stored name*, so:
//   - "I pooped today, mark off habit" → the model extracts "pooped" → the habit is
//     named "POOP" → "poop".includes("pooped") is FALSE → "No habit found".
//   - "mark my run done" vs a habit called "Running" → "running".includes("run") is
//     true, but "did my running" → query "running" vs name "Run" → false.
// Substring matching is directional and has no notion of word stems, so the user's
// natural phrasing routinely fails to find a habit that is sitting right there.
//
// The fix: normalize both sides, then match with a small ladder — exact, then
// bidirectional substring, then stem-aware token overlap ("pooped"→"poop",
// "running"→"run", "walked"→"walk"). Picks the best-scoring habit.

export interface HabitLike {
  id: string;
  name: string;
}

// Lowercase, split camelCase, and collapse every run of non-alphanumerics into a
// single space so "Take Lisinopril", "take-lisinopril", and "TakeLisinopril" all
// normalize the same way.
export function normalizeHabitText(input: unknown): string {
  return String(input ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Filler words that carry no habit-identity signal. Dropping them lets
// "I pooped today mark off habit" collapse to the meaningful stem [poop].
const HABIT_STOPWORDS = new Set([
  "i", "my", "me", "the", "a", "an", "to", "of", "for", "on", "off", "in", "at",
  "and", "or", "some", "that", "this", "it", "im", "ive",
  "today", "tonight", "tomorrow", "now", "this", "morning", "afternoon",
  "evening", "night", "daily", "weekly",
  "habit", "habits", "streak", "check", "checkin", "checked", "mark", "marked",
  "off", "done", "did", "do", "doing", "complete", "completed", "finish",
  "finished", "go", "went", "get", "got", "take", "took", "log", "logged",
  "was", "is", "am", "are", "just", "already",
]);

// Crude English stemmer — enough to bridge a spoken verb to a stored noun.
// "pooped" → "poop", "running" → "run", "walked" → "walk", "exercises" →
// "exercise", "stretching" → "stretch".
function stem(word: string): string {
  let s = word;
  if (s.length > 4 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 3 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  // Collapse a doubled trailing consonant left by -ing/-ed ("runn" → "run",
  // "swimm" → "swim", "stopp" → "stop").
  if (s.length >= 3 && /([bcdfghjklmnpqrstvwxz])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Turn a phrase into its set of meaningful, stemmed tokens.
export function habitTokens(text: string): string[] {
  const norm = normalizeHabitText(text);
  if (!norm) return [];
  const out = new Set<string>();
  for (const w of norm.split(" ")) {
    if (w.length < 2) continue;
    if (HABIT_STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

/**
 * Find the habit that best matches a free-text query. Returns undefined when no
 * habit shares any meaningful token with the query.
 *
 * Ladder: exact name → unique bidirectional substring → stem-aware token overlap.
 * On ties, the shortest (most specific) habit name wins.
 */
export function matchHabitByName<T extends HabitLike>(
  habits: T[],
  query: string,
): T | undefined {
  const q = normalizeHabitText(query);
  if (!q || habits.length === 0) return undefined;

  // 1. Exact normalized match.
  const exact = habits.find(h => normalizeHabitText(h.name) === q);
  if (exact) return exact;

  // 2. Bidirectional substring — query inside name OR name inside query. This
  //    covers "take my lisinopril" (name ⊂ query) and "lisin" (query ⊂ name).
  const subs = habits.filter(h => {
    const n = normalizeHabitText(h.name);
    return n.length > 0 && (n.includes(q) || q.includes(n));
  });
  if (subs.length === 1) return subs[0];

  // 3. Stem-aware token overlap. Score every habit by how many of its name
  //    tokens the query covers; prefer full coverage and shorter names.
  const qTokens = new Set(habitTokens(q));
  let best: T | undefined;
  let bestScore = 0;
  if (qTokens.size > 0) {
    for (const h of habits) {
      const nTokens = habitTokens(h.name);
      if (nTokens.length === 0) continue;
      let overlap = 0;
      for (const t of nTokens) if (qTokens.has(t)) overlap++;
      if (overlap === 0) continue;
      const coverage = overlap / nTokens.length; // 1.0 = every name word matched
      const score = overlap * 10 + coverage * 6 - nTokens.length * 0.1;
      if (score > bestScore) { bestScore = score; best = h; }
    }
  }
  if (best) return best;

  // 4. Fall back to the shortest substring candidate when multiple matched.
  if (subs.length > 0) {
    return [...subs].sort(
      (a, b) => normalizeHabitText(a.name).length - normalizeHabitText(b.name).length,
    )[0];
  }
  return undefined;
}
