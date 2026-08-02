// shared/document-lazy.ts
//
// The one spelling of "the bytes are not in this payload — fetch them".
//
// Document previews travel through the chat response as
// `{ id, name, mimeType, data }`. `data` is either inline base64 or this
// sentinel. Inlining is only ever a pessimisation: base64 is ~1.33x the file
// size, it rides inside the AI response (so the whole reply waits on the
// download + encode), and the model never sees it anyway — `summarizeResult`
// strips `fileData` before the bytes reach the prompt. The client fetches the
// blob itself from /api/documents/:id/file, through a refcounted LRU that
// dedupes with the preview's own prefetch.
//
// It lived as a bare "__LAZY_LOAD__" string literal in ten places across the
// engine and the viewer. `open_document` was the one document path that did
// NOT use it and shipped the real bytes instead — the "asking about a document
// makes the whole reply slow" report (2026-08-02). A shared constant is how
// that stays fixed: a path that forgets the sentinel now fails to compile
// rather than silently going back to inlining megabytes.

/** Marks a document preview whose bytes the client must fetch on demand. */
export const LAZY_DOCUMENT_SENTINEL = "__LAZY_LOAD__";

/** True when a preview's `data` field carries actual inline bytes. */
export function hasInlineDocumentData(data: unknown): data is string {
  return typeof data === "string" && data.length > 0 && data !== LAZY_DOCUMENT_SENTINEL;
}
