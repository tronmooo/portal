// One key per SUBMISSION of a transaction, so the server can tell an accidental
// repeat from an intentional second one.
//
// Owner, 2026-11-27: "Identical expenses must be allowed… Prevent technical
// duplicates through idempotency keys, request identifiers, and retry
// protection. Distinguish between an accidental repeated submission and an
// intentional new transaction." The server no longer compares what two
// expenses SAY; it compares the key each request carries
// (`Idempotency-Key`, server/idempotent-id.ts).
//
// What counts as the same submission:
//   · the same request sent again while the first is still in the air
//     (a double tap that beat the disabled button) — same key;
//   · the same request sent again after the first ended WITHOUT an answer
//     (offline, a timeout): nobody knows whether it was saved — same key,
//     so a retry can never make a second row.
// What is a new submission:
//   · anything sent after the first was ANSWERED (saved, or refused): the
//     person pressed Add again and means it — a new key, a new row.
//   · an unanswered request older than KEEP_UNANSWERED_MS: stale.
export const SUBMISSION_KEY_HEADER = "Idempotency-Key";
export const KEEP_UNANSWERED_MS = 10 * 60_000;

/** The creates that are keyed. Add a route here when it records a transaction. */
const KEYED = [/^\/api\/expenses$/, /^\/api\/incomes$/];
export function isKeyedSubmission(method: string, url: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = url.split("?")[0];
  return KEYED.some((re) => re.test(path));
}

interface Pending { key: string; inFlight: number; unansweredAt: number | null }
const pending = new Map<string, Pending>();

function newKey(): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `sub-${crypto.randomUUID()}`; } catch { /* fall through */ }
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

const fingerprint = (method: string, url: string, body: unknown): string => `${method.toUpperCase()} ${url} ${body === undefined ? "" : JSON.stringify(body)}`;

/** The key this request goes out under. Call `settle` with how it ended. */
export function beginSubmission(method: string, url: string, body: unknown, now = Date.now()): { key: string; settle: (answered: boolean) => void } {
  const fp = fingerprint(method, url, body);
  let p = pending.get(fp);
  if (p && p.inFlight === 0 && p.unansweredAt !== null && now - p.unansweredAt > KEEP_UNANSWERED_MS) { pending.delete(fp); p = undefined; }
  if (!p) { p = { key: newKey(), inFlight: 0, unansweredAt: null }; pending.set(fp, p); }
  const mine = p;
  mine.inFlight += 1;
  let done = false;
  return {
    key: mine.key,
    settle: (answered: boolean) => {
      if (done) return;
      done = true;
      mine.inFlight = Math.max(0, mine.inFlight - 1);
      if (answered) { if (pending.get(fp) === mine) pending.delete(fp); }
      else mine.unansweredAt = Date.now();
    },
  };
}

/** Tests only. */
export function resetSubmissionKeys(): void { pending.clear(); }
