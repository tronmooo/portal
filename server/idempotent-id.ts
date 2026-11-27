// The id a create gets when its request carries an idempotency key.
//
// Owner, 2026-11-27: "Prevent technical duplicates through idempotency keys,
// request identifiers, and retry protection. Distinguish between an accidental
// repeated submission and an intentional new transaction." A row's id derived
// from (account, kind, key) makes the DATABASE the judge: the same request
// arriving twice — a double tap, a retry after a timeout, two server instances
// at once — inserts the same primary key, the second insert conflicts, and the
// first row is the answer. A different key is always another row, however
// alike the two transactions are. No lookup-then-insert window, no content
// comparison.
import { createHash } from "node:crypto";

/** 8–128 visible characters: what a client may send as a key. */
export function validIdempotencyKey(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9._:\-]{8,128}$/.test(s) ? s : null;
}

/** A stable UUID (version-5 shaped) for this account's `kind` created under `key`. */
export function idempotentId(userId: string, kind: string, key: string): string {
  const h = createHash("sha1").update(`portol:${userId}:${kind}:${key}`).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
