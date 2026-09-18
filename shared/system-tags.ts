// ── System tags ─────────────────────────────────────────────────────────────
// Documents carry tags the app writes for itself: the upload-dedupe content
// hash ("sha256:9c82…"), the extract-only marker ("image-discarded"), and the
// namespaced grammar tasks use ("recur:weekly"). None of them is something a
// person chose, and the Artifacts page was rendering them as "#sha256:9c8249b8…"
// chips next to real tags (QA 2026-09-18, F-55). One predicate, used by every
// tag strip, so the rule cannot drift between screens.

/** A tag the app wrote for its own bookkeeping — never shown as a chip. */
export function isSystemTag(tag: unknown): boolean {
  const t = String(tag ?? "").trim().replace(/^#/, "");
  if (!t) return true;
  if (t === "image-discarded") return true;
  if (/^sha(1|256|512)\b/i.test(t)) return true;
  // A colon namespace ("recur:weekly", "src:upload") is machine grammar.
  if (/^[a-z][a-z0-9_-]*:/i.test(t)) return true;
  return false;
}

/** The tags a person actually applied, in their original order. */
export function userVisibleTags(tags: readonly unknown[] | null | undefined): string[] {
  return (tags || []).map((t) => String(t ?? "")).filter((t) => !isSystemTag(t));
}
