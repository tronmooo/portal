// Who a spend in a chat message was "for", read from the clause that names
// that spend — never from anywhere else in the message.
//
// The attribution safety net in create_expense recovers a dropped `forProfile`
// by looking for "for <Name>" near the amount. It used to find the FIRST
// occurrence of the amount's digits anywhere in the message and accept any
// "for <Name>" in the next 70 characters. "I spent $5 on coffee and $50 on
// groceries for Mom" put the coffee on Mom: the digit 5 first appears inside
// "$5", and "for Mom" sits within 70 characters of it. The amount has to be
// matched as a money token, and the name has to sit in the SAME clause.
//
// Pure; pinned by tests/error-hunt-2026-09-02.test.ts.

const CLAUSE_SPLIT = /\s*(?:,|;|\.\s|\bthen\b|\band\b|\bplus\b|\balso\b)\s*/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every way the amount is likely written: "50", "50.00", "$50", "50 dollars", "50 bucks". */
function amountTokenRe(amount: number): RegExp {
  const whole = String(Math.trunc(Math.abs(amount)));
  const fixed = Math.abs(amount).toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, "");
  const alts = Array.from(new Set([trimmed, fixed, whole].filter(Boolean))).map(escapeRe);
  // A money token: optional currency sign, the number, and NOT followed by
  // another digit ("5" must not match inside "50" or "2025").
  return new RegExp(`(?:^|[^\\d.])\\$?\\s*(?:${alts.join("|")})(?![\\d])(?:\\.\\d{1,2}(?!\\d))?`, "i");
}

/**
 * The capitalized name following "for" in the clause that carries `amount`,
 * or null when the clause names nobody. "for me/myself/us" is not a name.
 */
export function expenseAttributionName(message: string, amount: number): string | null {
  const raw = String(message || "");
  if (!raw.trim() || !Number.isFinite(amount) || amount <= 0) return null;
  const clauses = raw.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
  const tokenRe = amountTokenRe(amount);
  const clause = clauses.find((c) => tokenRe.test(c));
  if (!clause) return null;
  const m = clause.match(/\bfor\s+(?:my\s+)?([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+)?)/);
  if (!m) return null;
  const name = m[1].trim();
  if (/^(?:me|myself|us|i)$/i.test(name)) return null;
  return name;
}

/** Lowercase words only, single-spaced: "Sony WH-1000XM5" → "sony wh 1000xm5". */
function wordsOf(text: unknown): string {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The ONE thing (asset, vehicle, property…) a spend names outright.
 *
 * "I spent $40 on ear pads for my Sony WH-1000XM5" names the asset in full,
 * but the "for <Name>" net above only reads a capitalized one- or two-word
 * name, and the model often leaves `forProfile` off for a thing. The expense
 * was then filed under the account holder alone and the asset's Money tab said
 * "No expenses logged" (2026-11-19).
 *
 * Deliberately narrow, so it can never guess: the profile's FULL name must
 * appear as whole words, and exactly one thing may match (a longer name that
 * contains a shorter one wins: "Honda CR-V EX" over "Honda CR-V"). Two
 * distinct things in one sentence is a tie, and a tie attributes nothing.
 */
export function thingNamedInSpend<P extends { id: string; name?: string | null }>(
  text: string,
  things: readonly P[],
): P | null {
  const hay = ` ${wordsOf(text)} `;
  if (hay.trim().length === 0) return null;
  const hits: Array<{ thing: P; needle: string }> = [];
  for (const t of things) {
    const needle = wordsOf(t?.name);
    if (needle.length < 4) continue;
    if (hay.includes(` ${needle} `)) hits.push({ thing: t, needle });
  }
  if (hits.length === 0) return null;
  // Drop a hit whose name sits wholly inside another hit's longer name.
  const top = hits.filter((h) => !hits.some((o) => o !== h && o.needle.length > h.needle.length && ` ${o.needle} `.includes(` ${h.needle} `)));
  const ids = new Set(top.map((h) => h.thing.id));
  return ids.size === 1 ? top[0].thing : null;
}
