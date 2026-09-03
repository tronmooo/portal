// ─── Document deletion: one lifecycle, every surface ────────────────────────
//
// Deleting a document is not "remove a row from the Documents list". A document
// in this app is a SOURCE: extraction writes its fields onto profiles, derives
// calendar events from its dates, links it to assets/liabilities/people, and
// feeds the cached AI summaries that the profile pages render. Delete only the
// row and every one of those keeps rendering data whose source no longer
// exists — the user's report: "I deleted it in Documents and the asset profile
// still shows it, and the AI still quotes the policy number."
//
// So deletion runs HERE, in one place, and every entry point calls it: the
// Documents page, an asset/liability profile's Documents tab, the AI's
// manage_document tool, an undo of a document create. Same cascade, same
// provenance rules, same cache busts, wherever the user clicked.
//
// Two things this module refuses to guess at:
//
//  1. Provenance decides what dies. A field is removed only while it still
//     holds what THIS document wrote (`fields._docFields[docId]`) — anything
//     edited since is the user's — and only while no OTHER document vouches
//     for the same value. Two documents carrying the same property address
//     means deleting one removes one provenance link, not the address. See
//     splitDocumentContributedFields.
//
//  2. The user decides whether derived data dies at all. `mode: "cascade"`
//     takes back everything this document contributed; `mode: "document-only"`
//     removes the file and every reference to it but leaves the extracted data
//     standing on its own — de-sourced, no longer claiming a document that is
//     gone. The UI asks before either one, with real counts from
//     computeDocumentDeletionImpact.
import type { IStorage } from "./storage";
import { fieldPatchBetween } from "../shared/field-patch";
import {
  removeDocumentContributedFields,
  splitDocumentContributedFields,
} from "@shared/profile-field-identity";

// ─── "This app made this event from that document" ──────────────────────────
//
// Extraction has written document-derived events under SIX different shapes
// over the app's life, and only the newest carries the `document-extraction`
// tag. Matching on that tag alone left the other five behind — 28 of the 69
// document-linked events in a real account — so deleting the document left its
// expiration sitting on the calendar with no source. That is the orphan the
// user reported, and it survived the first fix because the fix only knew about
// the shape the CURRENT code writes.
//
// `source` looked like the obvious discriminator and is not: one legacy shape
// writes `source: "manual"` on an event whose own description says
// "Auto-created from document". Tags plus that description prefix identify all
// six; nothing else does.
const AUTO_EVENT_TAGS = new Set([
  "document-extraction", // current extraction path
  "auto-extraction",     // legacy AI extraction
  "auto-reminder",       // the "⏰ 30d reminder: …" leaders for an expiry
  "from-document",       // legacy, paired with expiration-alert
  "expiration-alert",
]);

/** Every auto-created shape says so here; a user's own event does not. */
const AUTO_EVENT_DESCRIPTION = /^\s*auto-created from\b/i;

/**
 * Is this event something the app derived FROM this document, as opposed to
 * something the user made and linked themselves?
 *
 * A user CAN link a document to an event by hand (CalendarManagerPanel), so
 * `linkedDocuments` alone proves nothing — the marker has to be positive
 * evidence of auto-creation. A hand-made event carries neither an auto tag nor
 * an "Auto-created from…" description, so it is never this document's to take.
 */
export function isDocumentDerivedEvent(ev: any): boolean {
  const tags: string[] = Array.isArray(ev?.tags) ? ev.tags : [];
  if (tags.some((t) => AUTO_EVENT_TAGS.has(String(t)))) return true;
  return AUTO_EVENT_DESCRIPTION.test(String(ev?.description ?? ""));
}

/** Preference key holding a profile's cached AI summary (see /api/profiles/:id/ai-summary). */
export const aiSummaryCacheKey = (profileId: string) => `profile_ai_${profileId}`;

export type DocumentDeletionMode = "cascade" | "document-only";

export function parseDeletionMode(raw: unknown): DocumentDeletionMode {
  // Default is "cascade": a delete with no stated intent takes the derived
  // data with it, which is what "delete this document" means to a user and
  // what every caller before this parameter existed already did.
  return raw === "document-only" ? "document-only" : "cascade";
}

export interface DocumentFieldImpact {
  profileId: string;
  profileName: string;
  /** Field paths this document is the sole source of — removed by "cascade". */
  fields: string[];
  /** Field paths another document also vouches for — the VALUE always stays. */
  sharedFields: string[];
}

export interface DocumentEventImpact {
  eventId: string;
  title: string;
  date?: string;
  /** False when the event is linked to other documents too — then it is only unlinked. */
  soleSource: boolean;
}

export interface DocumentDeletionImpact {
  documentId: string;
  documentName: string;
  documentType?: string;
  /** Extracted fields stored on the document itself. */
  extractedFieldCount: number;
  /** Profiles this document is linked to (its cards disappear from each). */
  linkedProfiles: Array<{ id: string; name: string; type?: string }>;
  /** Per-profile breakdown of the fields this document wrote. */
  fieldImpacts: DocumentFieldImpact[];
  /** Total profile fields "cascade" would remove. */
  derivedFieldCount: number;
  /** Fields kept even under "cascade" because another document also holds them. */
  sharedFieldCount: number;
  /** Calendar dates derived from this document. */
  derivedEvents: DocumentEventImpact[];
  derivedEventCount: number;
  /** Profiles whose cached AI summary is discarded so the AI stops quoting this. */
  aiSummaryProfileCount: number;
}

export interface DocumentDeletionResult {
  deleted: boolean;
  mode: DocumentDeletionMode;
  removedFieldCount: number;
  keptSharedFieldCount: number;
  removedEventCount: number;
  unlinkedEventCount: number;
  clearedAiSummaryCount: number;
  affectedProfileIds: string[];
}

type AnyStorage = IStorage & Record<string, any>;

async function loadDocumentMeta(storage: AnyStorage, documentId: string): Promise<any | undefined> {
  // Metadata-only where the storage offers it — neither the impact preview nor
  // the cascade needs the file bytes, and a document blob is megabytes.
  try {
    if (typeof storage.getDocumentMeta === "function") {
      const meta = await storage.getDocumentMeta(documentId);
      if (meta) return meta;
    }
  } catch { /* fall through to the full read */ }
  try {
    return await storage.getDocument(documentId);
  } catch {
    return undefined;
  }
}

/** Every profile that references this document, from either side of the link. */
function profilesReferencing(profiles: any[], doc: any, documentId: string): any[] {
  const linked = new Set<string>(Array.isArray(doc?.linkedProfiles) ? doc.linkedProfiles : []);
  return (profiles || []).filter((p: any) => {
    if (linked.has(p?.id)) return true;
    // The reverse edge: a profile carrying the id in its own `documents` array.
    // The two representations drift, and a profile holding a one-sided
    // reference is exactly how a deleted document keeps its card on an asset.
    return Array.isArray(p?.documents) && p.documents.includes(documentId);
  });
}

/**
 * What deleting this document would take with it — the numbers the confirmation
 * dialog shows. Read-only.
 */
export async function computeDocumentDeletionImpact(
  storage: AnyStorage,
  documentId: string,
): Promise<DocumentDeletionImpact | undefined> {
  const doc = await loadDocumentMeta(storage, documentId);
  if (!doc) return undefined;

  const [profiles, events] = await Promise.all([
    storage.getProfiles().catch(() => [] as any[]),
    storage.getEvents().catch(() => [] as any[]),
  ]);

  const fieldImpacts: DocumentFieldImpact[] = [];
  let derivedFieldCount = 0;
  let sharedFieldCount = 0;
  for (const p of profiles as any[]) {
    const { exclusive, shared } = splitDocumentContributedFields(p?.fields, documentId);
    const exclusiveKeys = Object.keys(exclusive);
    const sharedKeys = Object.keys(shared);
    if (exclusiveKeys.length === 0 && sharedKeys.length === 0) continue;
    // Preview the real removal: a field the user has since edited no longer
    // matches what the document saved, so it would survive the cascade and
    // must not be counted as a loss here.
    const preview = removeDocumentContributedFields(p.fields as Record<string, any>, exclusive);
    fieldImpacts.push({
      profileId: p.id,
      profileName: p.name || "Unnamed",
      fields: preview.removed,
      sharedFields: sharedKeys,
    });
    derivedFieldCount += preview.removed.length;
    sharedFieldCount += sharedKeys.length;
  }

  const derivedEvents: DocumentEventImpact[] = [];
  for (const ev of events as any[]) {
    const linked: string[] = Array.isArray(ev?.linkedDocuments) ? ev.linkedDocuments : [];
    if (!linked.includes(documentId)) continue;
    if (!isDocumentDerivedEvent(ev)) continue;
    derivedEvents.push({
      eventId: ev.id,
      title: ev.title || "Untitled",
      date: ev.date || ev.startDate,
      soleSource: linked.filter((d) => d !== documentId).length === 0,
    });
  }

  const referencing = profilesReferencing(profiles as any[], doc, documentId);
  // Every profile that either shows this document or carries a field from it
  // has a cached AI summary written while the document existed.
  const aiProfileIds = new Set<string>([
    ...referencing.map((p: any) => p.id),
    ...fieldImpacts.map((f) => f.profileId),
  ]);

  const extracted = doc.extractedData;
  return {
    documentId,
    documentName: doc.name || "Untitled document",
    documentType: doc.type,
    extractedFieldCount:
      extracted && typeof extracted === "object" ? Object.keys(extracted).length : 0,
    linkedProfiles: referencing.map((p: any) => ({ id: p.id, name: p.name || "Unnamed", type: p.type })),
    fieldImpacts,
    derivedFieldCount,
    sharedFieldCount,
    derivedEvents,
    derivedEventCount: derivedEvents.length,
    aiSummaryProfileCount: aiProfileIds.size,
  };
}

/**
 * Delete a document everywhere.
 *
 * Runs regardless of which screen the delete started from, and in both modes
 * ends with: no document row, no file in the bucket, no entity link, no
 * profile still listing it, no cached AI summary written while it existed.
 * The modes differ only in what happens to the data it CONTRIBUTED.
 *
 * Every cascade step is best-effort and logged: a failure to tidy one derived
 * record must not leave the user unable to delete the document.
 */
export async function deleteDocumentEverywhere(
  storage: AnyStorage,
  documentId: string,
  mode: DocumentDeletionMode = "cascade",
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void } = console,
): Promise<DocumentDeletionResult> {
  const result: DocumentDeletionResult = {
    deleted: false,
    mode,
    removedFieldCount: 0,
    keptSharedFieldCount: 0,
    removedEventCount: 0,
    unlinkedEventCount: 0,
    clearedAiSummaryCount: 0,
    affectedProfileIds: [],
  };

  const doc = await loadDocumentMeta(storage, documentId);
  const affected = new Set<string>();

  // ── 1. Profile fields ──────────────────────────────────────────────────
  // Both modes rewrite `_docFields`: the provenance link to a deleted document
  // is itself stale data, and leaving it behind is what would let a later
  // delete of a DIFFERENT document think this one still vouches for a value.
  // Only "cascade" removes the values.
  try {
    const profiles = await storage.getProfiles();
    for (const p of profiles as any[]) {
      const sources = p?.fields?._docFields;
      const recorded = sources && typeof sources === "object" ? sources[documentId] : undefined;
      if (!recorded || typeof recorded !== "object") continue;

      const { exclusive, shared } = splitDocumentContributedFields(p.fields, documentId);
      result.keptSharedFieldCount += Object.keys(shared).length;

      // Under "document-only" nothing is removed — the extracted data stays and
      // becomes independent data, which is precisely what dropping this
      // document's `_docFields` entry (below) makes it.
      const cascade =
        mode === "cascade"
          ? removeDocumentContributedFields(p.fields as Record<string, any>, exclusive)
          : { fields: { ...(p.fields as Record<string, any>) }, removed: [] as string[] };

      const nextSources: Record<string, any> = { ...sources };
      delete nextSources[documentId];

      // Top-level keys need an explicit null so the storage merge removes them;
      // nested groups are already rewritten without their entry.
      const removedTopLevel = cascade.removed.filter((path) => !path.includes("."));
      // Only the keys the cascade changed: the whole map it read, written
      // back, reverted any edit that landed on this profile meanwhile.
      const patch: Record<string, any> = fieldPatchBetween(p.fields as Record<string, any>, cascade.fields);
      for (const k of removedTopLevel) patch[k] = null;
      patch._docFields = Object.keys(nextSources).length > 0 ? nextSources : null;

      await storage.updateProfile(p.id, { fields: patch } as any);
      affected.add(p.id);
      result.removedFieldCount += cascade.removed.length;
      if (cascade.removed.length > 0) {
        logger.info(
          `[doc-delete:${mode}] ${documentId} → removed ${cascade.removed.length} field(s) from ${p.name}: ${cascade.removed.join(", ")}`,
        );
      }
      if (Object.keys(shared).length > 0) {
        logger.info(
          `[doc-delete:${mode}] ${documentId} → kept ${Object.keys(shared).length} field(s) on ${p.name}: another document is also their source`,
        );
      }
    }
  } catch (err: any) {
    logger.error(`[doc-delete:${mode}] field cascade failed for ${documentId}: ${err?.message || err}`);
  }

  // ── 2. Derived calendar events ─────────────────────────────────────────
  // Only events this app auto-created FROM this document (see
  // isDocumentDerivedEvent), never anything the user made themselves. An event
  // that other documents also feed is unlinked, not deleted — it is not this
  // document's to take.
  try {
    const events = await storage.getEvents();
    for (const ev of events as any[]) {
      const linked: string[] = Array.isArray(ev?.linkedDocuments) ? ev.linkedDocuments : [];
      if (!linked.includes(documentId)) continue;
      if (!isDocumentDerivedEvent(ev)) continue;
      const others = linked.filter((d) => d !== documentId);
      if (others.length > 0 || mode === "document-only") {
        // "document-only" keeps the date — it is derived DATA — but the event
        // must stop pointing at a document that no longer exists.
        await storage.updateEvent(ev.id, { linkedDocuments: others } as any);
        result.unlinkedEventCount++;
        continue;
      }
      await storage.deleteEvent(ev.id);
      result.removedEventCount++;
      logger.info(`[doc-delete:${mode}] ${documentId} → removed derived event ${ev.id} "${ev.title}"`);
    }
  } catch (err: any) {
    logger.error(`[doc-delete:${mode}] event cascade failed for ${documentId}: ${err?.message || err}`);
  }

  // ── 3. Reverse profile → document references ───────────────────────────
  // storage.deleteDocument clears the profiles listed in the DOCUMENT's
  // linkedProfiles. A profile whose own `documents` array holds the id while
  // the document's side does not is invisible to that pass — and a one-sided
  // reference like that is exactly how the deleted document kept its card on
  // the asset profile.
  try {
    const profiles = await storage.getProfiles();
    for (const p of profiles as any[]) {
      if (!Array.isArray(p?.documents) || !p.documents.includes(documentId)) continue;
      await storage.updateProfile(p.id, {
        documents: p.documents.filter((d: string) => d !== documentId),
      } as any);
      affected.add(p.id);
    }
  } catch (err: any) {
    logger.error(`[doc-delete:${mode}] profile back-reference cleanup failed for ${documentId}: ${err?.message || err}`);
  }

  // ── 4. The document itself ─────────────────────────────────────────────
  // Soft-deletes the row, clears the residual base64, drops entity_links and
  // removes the file (and its preview) from the storage bucket.
  try {
    result.deleted = await storage.deleteDocument(documentId);
  } catch (err: any) {
    logger.error(`[doc-delete:${mode}] delete failed for ${documentId}: ${err?.message || err}`);
    result.deleted = false;
  }

  // ── 5. AI retrieval ────────────────────────────────────────────────────
  // The profile AI summary is a CACHED DERIVATIVE of the document — the one in
  // the user's screenshot quotes the policy number and premium straight out of
  // it, on a 2-hour TTL, and would go on quoting them long after the document
  // was gone. Discard it for every profile this document touched, in BOTH
  // modes: even under "document-only" the summary was written against a
  // document that no longer exists.
  //
  // This is the whole AI retrieval surface for documents today: every other AI
  // path (chat context, profile detail embeds, document search) reads the
  // documents table live and is filtered on `deleted_at`, so it stops seeing
  // this document the moment step 4 lands. There is no embedding store or
  // standing semantic index to purge; when one is added it purges here.
  const aiTargets = new Set<string>(affected);
  for (const pid of (doc?.linkedProfiles as string[]) || []) if (pid) aiTargets.add(pid);
  for (const pid of aiTargets) {
    try {
      // Empty string, not a delete: the read path treats "" as a miss and
      // regenerates from the post-delete data.
      await storage.setPreference(aiSummaryCacheKey(pid), "");
      result.clearedAiSummaryCount++;
      affected.add(pid);
    } catch (err: any) {
      logger.warn(`[doc-delete:${mode}] AI summary cache clear failed for ${pid}: ${err?.message || err}`);
    }
  }

  result.affectedProfileIds = Array.from(affected);
  return result;
}

// ─── Repairing the orphans the old cascade left behind ──────────────────────
//
// The cascade above stops NEW orphans. It does nothing about the ones already
// sitting in the database from every delete that happened before it existed —
// events whose source document is deleted or gone entirely, still rendering on
// the calendar, in Upcoming and in Recurring & Important Dates, with nothing
// behind them. A real account had 40, including an expiry dated year 1085.
//
// The rule is the same one the cascade uses, which is the point of sharing
// isDocumentDerivedEvent: an event is orphaned only if this app auto-created it
// from a document AND every document it names is gone. An event still linked to
// one live document is not an orphan, and a user's own event is never one no
// matter what it links to.

export interface OrphanedDocumentEvent {
  eventId: string;
  title: string;
  date?: string;
  /** The dead document ids it still names. */
  documentIds: string[];
}

export interface OrphanRepairResult {
  scanned: number;
  orphaned: OrphanedDocumentEvent[];
  removed: number;
  dryRun: boolean;
}

/**
 * Find (and optionally remove) events whose source document no longer exists.
 *
 * Defaults to a dry run: it reports what it would take and touches nothing, so
 * the list can be read before anything is deleted.
 */
export async function repairOrphanedDocumentEvents(
  storage: AnyStorage,
  opts: { dryRun?: boolean } = {},
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void } = console,
): Promise<OrphanRepairResult> {
  const dryRun = opts.dryRun !== false;
  const [events, documents] = await Promise.all([
    storage.getEvents().catch(() => [] as any[]),
    storage.getDocuments().catch(() => [] as any[]),
  ]);
  // getDocuments already excludes soft-deleted rows, so "not in this set" covers
  // both a deleted document and one whose row is gone outright.
  const live = new Set<string>((documents as any[]).map((d: any) => d?.id).filter(Boolean));

  const orphaned: OrphanedDocumentEvent[] = [];
  for (const ev of events as any[]) {
    const linked: string[] = Array.isArray(ev?.linkedDocuments) ? ev.linkedDocuments : [];
    if (linked.length === 0) continue;
    if (!isDocumentDerivedEvent(ev)) continue;
    if (linked.some((id) => live.has(id))) continue; // still has a living source
    orphaned.push({ eventId: ev.id, title: ev.title || "Untitled", date: ev.date, documentIds: linked });
  }

  let removed = 0;
  if (!dryRun) {
    for (const o of orphaned) {
      try {
        await storage.deleteEvent(o.eventId);
        removed++;
        logger.info(`[doc-orphan-repair] removed ${o.eventId} "${o.title}" (${o.date ?? "no date"})`);
      } catch (err: any) {
        logger.error(`[doc-orphan-repair] failed to remove ${o.eventId}: ${err?.message || err}`);
      }
    }
  }

  return { scanned: (events as any[]).length, orphaned, removed, dryRun };
}
