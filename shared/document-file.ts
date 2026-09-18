// shared/document-file.ts — does this document have a file behind it? ONE answer.
// =============================================================================
//
// QA 2026-09-18 BUG-31: the Documents list printed "FORMAT: Image" for a
// receipt whose photo had been discarded at extraction time ("don't keep the
// photo"), and opening it said "This document was added without a file
// attached". Both were right about their own field — the row still carries
// `mimeType: image/jpeg`, and the viewer's `hasFile` was false — and wrong
// about each other, because the list derived its format from the MIME type
// alone while the viewer asked the server whether bytes exist.
//
// This module is the predicate both sides use. It reads, in order of
// authority, whatever the row carries:
//   · `hasFile` (the metadata endpoint's answer, resolved without moving bytes)
//   · `storagePath` (a Storage object exists — the list projection carries it)
//   · inline `fileData` (legacy base64 rows)
//   · the `image-discarded` tag (an extract-only upload: no bytes were kept)
// A row that says nothing either way is assumed to have a file — the viewer
// then fetches it and falls back to the "no file" card if the server disagrees.
//
// Pure: no I/O, so the client list, the viewer and the server agree.

/** Tag stamped on a document whose upload was read for extraction and dropped. */
export const DISCARDED_FILE_TAG = "image-discarded";

export interface DocumentFileShape {
  mimeType?: string | null;
  tags?: ReadonlyArray<string> | null;
  hasFile?: boolean | null;
  storagePath?: string | null;
  fileData?: string | null;
}

/** True when the document was stored WITHOUT its file (extract-only upload). */
export function wasFileDiscarded(doc: { tags?: ReadonlyArray<string> | null } | null | undefined): boolean {
  return Array.isArray(doc?.tags) && doc!.tags!.includes(DISCARDED_FILE_TAG);
}

/**
 * Whether a file (image, PDF, …) is attached to this document.
 * `true` unless the row proves otherwise — see the module note.
 */
export function documentHasFile(doc: DocumentFileShape | null | undefined): boolean {
  if (!doc) return false;
  if (doc.hasFile === true) return true;
  if (doc.hasFile === false) return false;
  if (typeof doc.storagePath === "string" && doc.storagePath.length > 0) return true;
  if (typeof doc.fileData === "string" && doc.fileData.length > 0 && doc.fileData !== "__LAZY_LOAD__") return true;
  if (wasFileDiscarded(doc)) return false;
  return true;
}

/** What the file's format is called in a list: "PDF", "Image", "Word", "File". */
export function mimeFormatLabel(mimeType: string | null | undefined): string {
  const m = String(mimeType || "").toLowerCase();
  if (!m) return "File";
  if (m.includes("pdf")) return "PDF";
  if (m.startsWith("image/") || m.includes("image")) return "Image";
  if (m.includes("word") || m.includes("msword") || m.includes("officedocument.wordprocessingml") || m.includes("/doc")) return "Word";
  if (m.includes("spreadsheet") || m.includes("excel") || m.includes("csv")) return "Spreadsheet";
  if (m.startsWith("text/") || m === "application/json") return "Text";
  return "File";
}

/** Shown where a list would otherwise print the file format of a file-less row. */
export const NO_FILE_FORMAT_LABEL = "No file";

/**
 * The "Format" a list should print: the MIME-derived label when a file is
 * attached, otherwise "No file" — so a row never advertises an image the
 * viewer cannot show.
 */
export function documentFormatLabel(doc: DocumentFileShape | null | undefined): string {
  if (!documentHasFile(doc)) return NO_FILE_FORMAT_LABEL;
  return mimeFormatLabel(doc?.mimeType);
}

// ── Internal tags ─────────────────────────────────────────────────────────────
// QA 2026-09-18 BUG-30: the Artifacts tag strip offered "#sha256:9c82…" and
// "#image-discarded" as filters. Those are bookkeeping the extractor stamps on
// a row (content fingerprint, the discarded-photo marker), not folders the
// user made. A tag is internal when it is namespaced with a colon
// ("sha256:…", "src:chat"), starts with an underscore, or is one of the
// known markers. Lists and chips read `visibleDocumentTags`.
const INTERNAL_TAGS = new Set<string>([DISCARDED_FILE_TAG]);

export function isInternalDocumentTag(tag: unknown): boolean {
  if (typeof tag !== "string") return true;
  const t = tag.trim();
  if (!t) return true;
  if (t.startsWith("_")) return true;
  if (t.includes(":")) return true;
  return INTERNAL_TAGS.has(t.toLowerCase());
}

/** The user-facing tags of a row, in order, without the internal ones. */
export function visibleDocumentTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => !isInternalDocumentTag(t));
}
