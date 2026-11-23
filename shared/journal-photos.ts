// A journal entry's photos (owner request 2026-11-23). A photo is a file
// saved to Documents; the entry points at it with one tag, `photo:<id>`.
// No new column: the entry's tags already travel with every save, and the
// composer that owns the entry is the one that writes them.
//
// Pure. Pinned by tests/journal-workspace.dom.test.tsx.

export const PHOTO_TAG_PREFIX = "photo:";
export const JOURNAL_MAX_PHOTOS = 8;

const isPhotoTag = (t: unknown): t is string => typeof t === "string" && t.startsWith(PHOTO_TAG_PREFIX) && t.length > PHOTO_TAG_PREFIX.length;

/** The documents an entry's photos are, in the order they were added. */
export function journalPhotoIds(tags: string[] | undefined | null): string[] {
  return [...new Set((tags || []).filter(isPhotoTag).map((t) => t.slice(PHOTO_TAG_PREFIX.length)))];
}
/** The entry's own tags, without the photo pointers. */
export function journalLabels(tags: string[] | undefined | null): string[] {
  return (tags || []).filter((t) => typeof t === "string" && !t.startsWith(PHOTO_TAG_PREFIX));
}
export function journalTagsFor(labels: string[], photoIds: string[]): string[] {
  const clean = [...new Set(labels.map((l) => l.trim()).filter((l) => l && !l.startsWith(PHOTO_TAG_PREFIX)))];
  return [...clean, ...[...new Set(photoIds)].slice(0, JOURNAL_MAX_PHOTOS).map((id) => `${PHOTO_TAG_PREFIX}${id}`)];
}
