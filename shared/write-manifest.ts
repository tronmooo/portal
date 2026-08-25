// ─── Write manifest: what a mutation actually changed ───────────────────────
//
// Every write used to answer the question "what changed?" twice, badly. The
// server answered it by throwing away the whole per-user response cache. The
// client answered it by having each of ~600 call sites name the domains it
// thought it had touched. Neither answer came from the write itself, so a
// screen that forgot a domain stayed stale and a write that touched two
// entities (a payment AND the liability balance it moved) only ever reported
// one of them.
//
// The manifest is that answer, derived mechanically from the storage calls the
// request actually made (server/write-journal.ts). It rides back on a RESPONSE
// HEADER rather than in the body, deliberately:
//   · response bodies stay byte-identical, so no consumer, test or zod parse
//     changes and no call site can accidentally cache the envelope;
//   · it works uniformly for 204s, array bodies and non-JSON responses — which
//     are exactly the inconsistent responses ("{success:true}") this exists to
//     compensate for.
//
// The header has a size budget, so `encodeWriteManifest` degrades in a fixed
// order: full → drop the row payloads → drop the changes entirely. The last
// rung is domains-only, which is precisely today's behavior, so the worst case
// is "no worse than before" rather than "wrong".
import type { Domain } from "./entity-domains";

export const WRITE_MANIFEST_HEADER = "x-write-manifest";

/** Roughly the safe budget for one response header on Vercel. */
export const MANIFEST_MAX_BYTES = 4096;

export interface WriteChange {
  op: "create" | "update" | "delete";
  /** List endpoint whose cached rows can be patched, or null when there isn't one. */
  endpoint: string | null;
  id: string;
  /** The authoritative row, when the write returned one. */
  row?: Record<string, unknown>;
}

export interface WriteManifest {
  /** Cache domains this write rippled into. Never empty. */
  domains: Domain[];
  changes: WriteChange[];
  /** Set when the encoder had to drop detail to fit the header budget. */
  truncated?: boolean;
}

function toBase64Url(json: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(json, "utf8").toString("base64url");
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(raw, "base64url").toString("utf8");
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a manifest for the response header.
 *
 * base64url rather than raw JSON because a row can carry any user text — a
 * name with an accent, an emoji in a note — and a header value must be
 * ASCII. Returns "" when there is nothing worth sending.
 */
export function encodeWriteManifest(manifest: WriteManifest): string {
  const domains = (manifest.domains || []).filter(Boolean);
  if (domains.length === 0) return "";

  const attempts: WriteManifest[] = [
    { domains, changes: manifest.changes || [] },
    // Rung 2: keep WHICH rows changed, drop what they now contain. The client
    // can still tombstone deletes and invalidate precisely; it just has to
    // wait a round trip to render the new values.
    { domains, changes: (manifest.changes || []).map(({ op, endpoint, id }) => ({ op, endpoint, id })), truncated: true },
    // Rung 3: domains only — exactly the pre-manifest behavior.
    { domains, changes: [], truncated: true },
  ];

  for (const attempt of attempts) {
    const encoded = toBase64Url(JSON.stringify(attempt));
    if (encoded.length <= MANIFEST_MAX_BYTES) return encoded;
  }
  return "";
}

/**
 * Decode a manifest from a response header.
 *
 * Never throws: a header we can't read must degrade to "no manifest" (which
 * falls back to the heuristic write-sync path), never fail the write.
 */
export function decodeWriteManifest(raw: string | null | undefined): WriteManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const domains = Array.isArray(parsed.domains)
      ? parsed.domains.filter((d: unknown): d is Domain => typeof d === "string" && d.length > 0)
      : [];
    if (domains.length === 0) return null;
    const changes = Array.isArray(parsed.changes)
      ? parsed.changes.filter(
          (c: any) =>
            c && typeof c === "object" &&
            (c.op === "create" || c.op === "update" || c.op === "delete") &&
            typeof c.id === "string" && c.id.length > 0,
        ).map((c: any) => ({
          op: c.op as WriteChange["op"],
          endpoint: typeof c.endpoint === "string" ? c.endpoint : null,
          id: c.id as string,
          ...(c.row && typeof c.row === "object" && !Array.isArray(c.row) ? { row: c.row } : {}),
        }))
      : [];
    return { domains, changes, ...(parsed.truncated ? { truncated: true } : {}) };
  } catch {
    return null;
  }
}
