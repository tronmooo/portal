// One content tag for an uploaded file, computed the same way everywhere.
//
// Every stored upload carries `sha256:<32 hex>` in its tags. Two places depend
// on that tag meaning exactly the same thing for the same bytes:
//
//   • processFileUpload's idempotent re-upload guard — a retry of an identical
//     file short-circuits to the existing document instead of creating a twin.
//   • the /api/upload error path — before reporting a failure, it looks up
//     whether the file it just choked on is nonetheless already saved.
//
// If those two computed the tag even slightly differently (one stripping the
// data-URI prefix, the other not) the guard would look like it worked while the
// lookup silently found nothing. Hence one function.
//
// It lives in server/ rather than being exported from ai-engine because routes.ts
// loads the AI module graph LAZILY (see the AiEngineMod proxies) to keep cold
// start off the read path — importing a one-line hash helper from there would
// pull @anthropic-ai/sdk back into every request.
import { createHash } from "crypto";

/**
 * The `sha256:…` tag for a base64 payload. Accepts a raw data URI or bare
 * base64 with or without embedded whitespace — all three normalize to the same
 * tag, because a client that re-sends the same file may format it differently.
 */
export function uploadContentTag(base64Data: string): string {
  let clean = String(base64Data || "");
  if (clean.includes(",")) clean = clean.split(",").pop() || clean;
  clean = clean.replace(/\s/g, "");
  return `sha256:${createHash("sha256").update(clean).digest("hex").slice(0, 32)}`;
}
