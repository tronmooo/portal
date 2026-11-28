// "Add my car Civic C" is not "rename Civic M to Civic C".
//
// On the preview (equivalence.asset-ownership, 933548e, 2026-11-28) chat's
// update_profile for "Civic …C" answered "not found — did you mean Civic
// …M?", and the model then renamed the person's existing Civic …M to …C and
// replied that the new car was saved: one car was overwritten and none was
// added. A rename goes through only when the user's words ask to rename, or
// name the record being renamed; a message that ADDS the new name and never
// mentions the old one is a create.
const RENAME_RE = /\b(rename|renamed|re-?name|call (?:it|him|her|them)|change (?:the |its |his |her |their )?name|name (?:it|him|her)|(?:is|was|be|now) (?:called|named)|should be (?:called|named)|typo|misspel|spelled|fix the name|correct the name)\b/i;
const ADD_RE = /\b(add|adding|create|new|bought|buy|got|purchased|track|record|log|save)\b/i;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * True when renaming `oldName` to `newName` is really the user ADDING
 * `newName`: the message asks to add, names the new name, never the old one,
 * and asks for no rename. Without a message (an internal call) it is false.
 */
export function renameIsReallyAnAdd(message: unknown, oldName: unknown, newName: unknown): boolean {
  const msg = String(message ?? "");
  if (!msg.trim()) return false;
  const m = norm(msg), o = norm(oldName), n = norm(newName);
  if (!n || !o || o === n) return false;
  if (RENAME_RE.test(msg)) return false;
  if (m.includes(o)) return false;
  return ADD_RE.test(msg) && m.includes(n);
}
