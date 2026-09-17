// shared/document-scope.ts
// =============================================================================
// Which documents are a profile's documents? ONE answer.
// =============================================================================
//
// User report, 2026-09-17: a person's Info tab said "Documents 3" while the
// Documents tab under the same person listed 2.
//
// The two surfaces were counting by different rules. Info read the server
// embed (`profile.relatedDocuments`), which the memory store builds from the
// document's `linkedProfiles` OR the profile's `documents` id list — and that
// second list is where propagateDocumentToAncestors files a child asset's
// document against the parent. The Documents tab read the live
// `/api/documents?profileId=` list, kept the rows whose `linkedProfiles`
// contain the profile, and listed anything reached through a descendant in a
// separate block. Two rules, two numbers.
//
// This module is the rule. Both surfaces call it on the same rows, so the
// number and the list cannot disagree again:
//
//   · A document is OF a profile when the document itself says so —
//     `linkedProfiles` contains the profile id. That is the link the Documents
//     tab renders, the link a "move to Jane" rewrites, and the link every
//     scope filter reads.
//   · A document reached only through a descendant (the Honda's registration,
//     seen from its owner) is NOT the person's own document. The Documents tab
//     shows those under their own heading; `includeDescendants` is how a
//     caller asks for them, explicitly, when it wants that view.
//   · A profile's `documents` id list is not consulted. It is a propagation
//     cache, not a link, and reading it was the extra "1".
//
// Pure: no I/O, no clock, so the client and the server reach the same answer.

export interface DocumentLinkShape {
  id: string;
  linkedProfiles?: ReadonlyArray<string> | null;
}

/** True when the document is linked to this profile directly. */
export function isDocumentOfProfile(
  doc: DocumentLinkShape | null | undefined,
  profileId: string,
): boolean {
  if (!doc || !profileId) return false;
  const linked = doc.linkedProfiles;
  return Array.isArray(linked) && linked.includes(profileId);
}

export interface DocumentsForProfileOptions {
  /**
   * Profile ids BELOW this profile (children, grandchildren…). When given, a
   * document linked to any of them is included as well — the Documents tab's
   * "under this profile's assets" view. Left out, only direct links count,
   * which is what the Info count and the Documents list both show.
   */
  includeDescendants?: Iterable<string>;
}

/**
 * The documents that belong to `profileId`, from any mix of sources (the
 * server embed, the live list, both), deduplicated by id. When the same
 * document arrives twice, later copies are merged over earlier ones, so a
 * fresher list row wins over a cached embed row without losing fields the
 * list omits. Order is first-seen order.
 */
export function documentsForProfile<T extends DocumentLinkShape>(
  docs: Iterable<T | null | undefined> | null | undefined,
  profileId: string,
  opts: DocumentsForProfileOptions = {},
): T[] {
  if (!docs || !profileId) return [];
  const descendants = opts.includeDescendants ? new Set(opts.includeDescendants) : null;
  // Merge first, then decide — so the latest copy's links are the ones
  // judged. A document unlinked since the embed was cached is still in the
  // embed with the old links; the live list row, arriving later, replaces
  // them and the document drops out of both surfaces together.
  const byId = new Map<string, T>();
  for (const doc of docs) {
    if (!doc || typeof doc !== "object" || !doc.id) continue;
    const prev = byId.get(doc.id);
    byId.set(doc.id, prev ? { ...prev, ...doc } : doc);
  }
  const out: T[] = [];
  for (const doc of byId.values()) {
    const direct = isDocumentOfProfile(doc, profileId);
    const viaDescendant = !direct && !!descendants && Array.isArray(doc.linkedProfiles)
      && doc.linkedProfiles.some((id) => descendants.has(id));
    if (direct || viaDescendant) out.push(doc);
  }
  return out;
}
