// client/src/lib/pending-review.ts
//
// The handoff between "a document was just uploaded and extracted" (chat page)
// and the full-screen review at #/documents/:id/review.
//
// The extraction payload only ever existed inside the chat page's message
// state, which the review page cannot see. This module is the seam: the upload
// success handler stashes the payload here keyed by document id, navigates,
// and the review page picks it up. A sessionStorage copy (with the inline
// preview bytes stripped — the page re-fetches the binary through the
// authenticated /file endpoint anyway) survives a reload of the review page;
// nothing here outlives the browser session, because a pending review is a
// moment, not a record.

import type { ChatMessage } from "@shared/schema";

export type PendingExtraction = NonNullable<ChatMessage["pendingExtraction"]>;

const memory = new Map<string, PendingExtraction>();

const storageKey = (documentId: string) => `portol.pendingReview.${documentId}`;

/** The payload minus inline binary — sessionStorage has a small quota. */
function stripBinary(extraction: PendingExtraction): PendingExtraction {
  if (!extraction.documentPreview) return extraction;
  return { ...extraction, documentPreview: { ...extraction.documentPreview, data: "" } };
}

export function stashPendingReview(documentId: string, extraction: PendingExtraction): void {
  memory.set(documentId, extraction);
  try {
    sessionStorage.setItem(storageKey(documentId), JSON.stringify(stripBinary(extraction)));
  } catch {
    // Quota or privacy mode — the in-memory copy still carries this session.
  }
}

export function loadPendingReview(documentId: string): PendingExtraction | null {
  const hit = memory.get(documentId);
  if (hit) return hit;
  try {
    const raw = sessionStorage.getItem(storageKey(documentId));
    if (!raw) return null;
    return JSON.parse(raw) as PendingExtraction;
  } catch {
    return null;
  }
}

export function clearPendingReview(documentId: string): void {
  memory.delete(documentId);
  try {
    sessionStorage.removeItem(storageKey(documentId));
  } catch {
    // Already gone or storage unavailable — either way there is nothing to clear.
  }
}
