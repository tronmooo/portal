// shared/domain/documents-artifacts.ts — Documents and Artifacts have
// different jobs.
//
//   Documents: uploaded / source files — PDFs, receipts, policies, licences,
//              medical reports. They have bytes (or had them) and extraction.
//   Artifacts: AI-created or authored outputs — reports, summaries, plans,
//              generated documents, tables, analyses.
//
// The Artifacts page merged both stores into one list under two labels. This
// module classifies each item by what it IS, states each library's purpose,
// and makes the relationship explicit when an artifact was derived from a
// document.
//
// Pure. Pinned by tests/consistency-layer-libraries.test.ts.

export type LibraryPurpose = "document" | "artifact";

export const LIBRARY_PURPOSE: Record<LibraryPurpose, { label: string; description: string }> = {
  document: { label: "Documents", description: "Uploaded source files: PDFs, receipts, policies, licences, medical reports." },
  artifact: { label: "Artifacts", description: "AI-created outputs: reports, summaries, plans, generated documents, tables and analyses." },
};

export interface LibraryItemLike {
  id?: string;
  /** Present on documents. */
  mimeType?: string | null;
  fileData?: string | null;
  storagePath?: string | null;
  storage_path?: string | null;
  extractedData?: unknown;
  /** Present on artifacts. */
  type?: string | null;
  content?: string | null;
  source?: "chat" | "manual" | "ai" | string | null;
  /** The document an artifact was generated from, when known. */
  sourceDocumentId?: string | null;
  linkedDocuments?: readonly string[] | null;
  tags?: readonly unknown[] | null;
}

const ARTIFACT_TYPES = new Set(["checklist", "note", "markdown", "code", "html", "react", "svg", "mermaid", "chart", "doc", "sheet"]);

/** Which library an item belongs to, from its shape — never from the page that lists it. */
export function libraryPurposeOf(item: LibraryItemLike | null | undefined): LibraryPurpose {
  if (!item) return "artifact";
  if (item.mimeType || item.fileData || item.storagePath || item.storage_path) return "document";
  if (item.extractedData && typeof item.extractedData === "object" && !item.type) return "document";
  if (item.type && ARTIFACT_TYPES.has(String(item.type))) return "artifact";
  if (typeof item.content === "string") return "artifact";
  return "document";
}

export interface DerivationLink {
  artifactId: string;
  documentId: string;
}

/** The explicit document → artifact relationships in a set. */
export function derivationLinks(items: readonly LibraryItemLike[]): DerivationLink[] {
  const out: DerivationLink[] = [];
  for (const it of items) {
    if (libraryPurposeOf(it) !== "artifact" || !it.id) continue;
    const ids = new Set<string>();
    if (it.sourceDocumentId) ids.add(String(it.sourceDocumentId));
    for (const d of it.linkedDocuments || []) if (d) ids.add(String(d));
    for (const t of it.tags || []) {
      const m = /^(?:source|from|doc):([0-9a-f-]{8,})$/i.exec(String(t ?? ""));
      if (m) ids.add(m[1]);
    }
    for (const documentId of ids) out.push({ artifactId: it.id, documentId });
  }
  return out;
}

export interface SplitLibrary<T extends LibraryItemLike> {
  documents: T[];
  artifacts: T[];
  links: DerivationLink[];
}

/** Two lists with distinct membership, plus the explicit links between them. */
export function splitLibrary<T extends LibraryItemLike>(items: readonly T[]): SplitLibrary<T> {
  const documents: T[] = [], artifacts: T[] = [];
  for (const it of items) (libraryPurposeOf(it) === "document" ? documents : artifacts).push(it);
  return { documents, artifacts, links: derivationLinks(items) };
}
