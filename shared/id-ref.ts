// A record reference from the chat model, resolved to a stored id.
//
// The model copies ids out of tool results, and some results show a short id
// (the first 8 characters). link_entities stored "a3eab29f" as a profile id:
// the link pointed at nothing and the task was never filed under the person
// (chat-tools.task-linked-to-person, preview 933548e, 2026-11-28). A
// reference resolves to ONE row — the exact id, else a unique id prefix of at
// least 6 characters, else a unique name — or it is refused; it is never
// guessed between two.
export type IdRefResult = { id: string } | { error: string };

export function resolveIdRef<T extends { id: string }>(
  ref: unknown,
  rows: readonly T[],
  nameOf: (row: T) => unknown,
  kind: string,
): IdRefResult {
  const r = String(ref ?? "").trim();
  if (!r) return { error: `No ${kind} was named.` };
  if (rows.some((row) => row.id === r)) return { id: r };
  const lc = r.toLowerCase();
  if (/^[0-9a-f-]{6,}$/.test(lc)) {
    const hits = rows.filter((row) => row.id.toLowerCase().startsWith(lc));
    if (hits.length === 1) return { id: hits[0].id };
    if (hits.length > 1) return { error: `"${r}" matches more than one ${kind}; use its full id.` };
  }
  const byName = rows.filter((row) => String(nameOf(row) ?? "").trim().toLowerCase() === lc);
  if (byName.length === 1) return { id: byName[0].id };
  if (byName.length > 1) return { error: `More than one ${kind} is called "${r}"; use its full id.` };
  return { error: `No ${kind} matches "${r}".` };
}
