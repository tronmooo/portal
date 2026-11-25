// Version history for what is written in the workspaces: a note, a journal
// entry, a document (owner request 2026-11-25: "view and restore previous
// document versions"; "version history and undo").
//
// A version is the text a record HAD, kept at the moment a save replaced it.
// The editors autosave every second or two, so a version is not kept for
// every save: a new one is kept only when the last is at least
// VERSION_MIN_GAP_MS old (or the caller forces it — a restore always keeps
// what it replaces). Kept on the account as one preferences row per record
// (`versions:<kind>:<id>`, the record-details precedent: no table, no
// migration), newest first, bounded in count and in size.
//
// Pure. Pinned by tests/content-versions.test.ts.

export type VersionKind = "note" | "journal" | "document";
export const VERSION_KINDS: VersionKind[] = ["note", "journal", "document"];
export const isVersionKind = (v: unknown): v is VersionKind => VERSION_KINDS.includes(v as VersionKind);

export const VERSION_MAX_COUNT = 30;
/** Autosaves closer together than this are one sitting: one version. */
export const VERSION_MIN_GAP_MS = 10 * 60 * 1000;
/** One version larger than this is not kept (a document full of embedded pictures). */
export const VERSION_MAX_BYTES = 400_000;
/** All versions of one record together. The oldest go first. */
export const VERSION_TOTAL_BYTES = 1_500_000;

export interface ContentVersion {
  id: string;
  /** When this text was replaced (ISO). */
  savedAt: string;
  title: string;
  content: string;
  /** Why it was kept: an edit, or a restore that put an older version back. */
  reason: "edit" | "restore";
}

export const versionsKey = (kind: VersionKind, id: string) => `versions:${kind}:${id}`;
export const VERSIONS_KEY_PREFIX = "versions:";

const bytes = (s: string) => s.length; // a bound, not an exact count

export function parseVersions(raw: unknown): ContentVersion[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: ContentVersion[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const row = v as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.savedAt !== "string" || typeof row.content !== "string") continue;
    if (!Number.isFinite(Date.parse(row.savedAt))) continue;
    out.push({ id: row.id, savedAt: row.savedAt, title: typeof row.title === "string" ? row.title : "", content: row.content, reason: row.reason === "restore" ? "restore" : "edit" });
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export interface KeepVersionInput {
  /** What the record holds now, about to be replaced. */
  previous: { title: string; content: string };
  /** What is being written. */
  next: { title?: string; content?: string };
  now: Date;
  /** Keep it whatever the gap (a restore). */
  force?: boolean;
  reason?: ContentVersion["reason"];
  /** A fresh id for the version. */
  id: string;
}

export type KeepVersionResult =
  | { kept: true; versions: ContentVersion[]; version: ContentVersion }
  | { kept: false; versions: ContentVersion[]; why: "unchanged" | "empty" | "too-soon" | "too-large" };

/**
 * Decide whether the text being replaced becomes a version, and answer the
 * list as it should be stored. Never throws: a version that cannot be kept is
 * a reason, and the save it rides on goes ahead.
 */
export function keepVersion(existing: ContentVersion[], input: KeepVersionInput): KeepVersionResult {
  const versions = parseVersions(existing);
  const prev = String(input.previous.content ?? "");
  const nextContent = input.next.content;
  if (nextContent === undefined || nextContent === prev) return { kept: false, versions, why: "unchanged" };
  if (!prev.trim()) return { kept: false, versions, why: "empty" };
  // The same text is already the newest version (a retry, a double save).
  if (versions[0]?.content === prev) return { kept: false, versions, why: "unchanged" };
  if (!input.force && versions[0] && input.now.getTime() - Date.parse(versions[0].savedAt) < VERSION_MIN_GAP_MS) {
    return { kept: false, versions, why: "too-soon" };
  }
  if (bytes(prev) > VERSION_MAX_BYTES) return { kept: false, versions, why: "too-large" };
  const version: ContentVersion = {
    id: input.id, savedAt: input.now.toISOString(), title: String(input.previous.title ?? "").slice(0, 300), content: prev, reason: input.reason ?? "edit",
  };
  const next = [version, ...versions].slice(0, VERSION_MAX_COUNT);
  let total = next.reduce((n, v) => n + bytes(v.content), 0);
  while (next.length > 1 && total > VERSION_TOTAL_BYTES) total -= bytes(next.pop()!.content);
  return { kept: true, versions: next, version };
}

/** What a list of versions shows: no body, a preview and a size. */
export interface VersionSummary { id: string; savedAt: string; title: string; reason: ContentVersion["reason"]; preview: string; words: number }

const plain = (s: string) => s.replace(/<(br|\/p|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function summarizeVersion(v: ContentVersion): VersionSummary {
  const text = plain(v.content).replace(/\s+/g, " ").trim();
  return { id: v.id, savedAt: v.savedAt, title: v.title, reason: v.reason, preview: text.slice(0, 220), words: text ? text.split(" ").length : 0 };
}
