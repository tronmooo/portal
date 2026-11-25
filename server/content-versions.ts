// Version history for notes, journal entries and documents: the storage side
// of shared/content-versions.ts.
//
// `keepVersionBeforeWrite` is called by the route that is about to replace a
// record's text, with what the record holds NOW. It never fails the save it
// rides on: a version that cannot be kept (lock busy, storage error) is
// logged and the write goes ahead.
//
// `restoreVersion` puts an older text back as the record's text. What it
// replaces is kept as a version first (forced), so a restore can itself be
// undone. The read-modify-write of the versions row runs under a lock and
// re-reads the row inside it (Rule 6).
import { randomUUID } from "crypto";
import { storage } from "./storage";
import { NOTE_TYPE } from "./content-service";
import {
  keepVersion, parseVersions, summarizeVersion, versionsKey,
  type ContentVersion, type VersionKind, type VersionSummary,
} from "@shared/content-versions";

const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (await storage.acquireUserLock(name, LOCK_TTL_MS)) break;
    if (Date.now() > deadline) throw new Error("versions lock busy");
    await new Promise((r) => setTimeout(r, 120));
  }
  try { return await fn(); } finally { await storage.releaseUserLock(name).catch(() => { /* the ttl frees it */ }); }
}

interface RecordText { title: string; content: string }

/** The record's current title and text, or null when it is not that kind of record. */
export async function readRecordText(kind: VersionKind, id: string): Promise<RecordText | null> {
  if (kind === "journal") {
    const row = ((await storage.getJournalEntries()) || []).find((e: any) => e.id === id) as any;
    return row ? { title: String(row.title || ""), content: String(row.content || "") } : null;
  }
  const row = (await storage.getArtifact(id)) as any;
  if (!row) return null;
  if (kind === "note" ? row.type !== NOTE_TYPE : row.type !== "doc") return null;
  return { title: String(row.title || ""), content: String(row.content || "") };
}

export async function listVersions(kind: VersionKind, id: string): Promise<VersionSummary[]> {
  return parseVersions(await storage.getPreference(versionsKey(kind, id))).map(summarizeVersion);
}

export async function getVersion(kind: VersionKind, id: string, versionId: string): Promise<ContentVersion | null> {
  return parseVersions(await storage.getPreference(versionsKey(kind, id))).find((v) => v.id === versionId) ?? null;
}

/**
 * Keep the text that is about to be replaced. Safe to call on every save:
 * the rule (shared/content-versions.ts) keeps one version per sitting.
 */
export async function keepVersionBeforeWrite(
  kind: VersionKind, id: string, previous: RecordText | null | undefined, next: { title?: string; content?: string },
  opts: { force?: boolean; reason?: ContentVersion["reason"] } = {},
): Promise<boolean> {
  if (!previous || next.content === undefined || next.content === previous.content || !previous.content.trim()) return false;
  const key = versionsKey(kind, id);
  try {
    return await withLock(key, async () => {
      const result = keepVersion(parseVersions(await storage.getPreference(key)), {
        previous, next, now: new Date(), force: opts.force, reason: opts.reason, id: randomUUID(),
      });
      if (!result.kept) return false;
      await storage.setPreference(key, JSON.stringify(result.versions));
      return true;
    });
  } catch (err) {
    console.warn(`[versions] could not keep a version of ${kind} ${id}:`, (err as Error)?.message);
    return false;
  }
}

/** The record is gone: its versions go with it. */
export async function forgetVersions(kind: VersionKind, id: string): Promise<void> {
  const key = versionsKey(kind, id);
  try {
    if ((await storage.getPreference(key)) !== null) await storage.setPreference(key, "[]");
  } catch (err) {
    console.warn(`[versions] could not clear versions of ${kind} ${id}:`, (err as Error)?.message);
  }
}

export type RestoreResult =
  | { ok: true; record: any; restoredFrom: string }
  | { ok: false; status: number; error: string };

/** Put a version's text back. The text it replaces is kept first. */
export async function restoreVersion(kind: VersionKind, id: string, versionId: string): Promise<RestoreResult> {
  const current = await readRecordText(kind, id);
  if (!current) return { ok: false, status: 404, error: "That record no longer exists." };
  const version = await getVersion(kind, id, versionId);
  if (!version) return { ok: false, status: 404, error: "That version is no longer kept." };
  if (version.content === current.content) return { ok: false, status: 409, error: "That version is what is saved now." };
  await keepVersionBeforeWrite(kind, id, current, { content: version.content }, { force: true, reason: "restore" });
  const record = kind === "journal"
    ? await storage.updateJournalEntry(id, { content: version.content } as any)
    : await storage.updateArtifact(id, { content: version.content } as any);
  if (!record) return { ok: false, status: 404, error: "That record no longer exists." };
  return { ok: true, record, restoredFrom: version.savedAt };
}
