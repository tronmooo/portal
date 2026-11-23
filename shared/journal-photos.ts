// A journal entry's photos (owner request 2026-11-23). A photo is a file
// saved to Documents; the entry points at it with one tag, `photo:<id>`.
// No new column: the entry's tags already travel with every save, and the
// composer that owns the entry is the one that writes them.
//
// A file that is not a photo (a PDF, a letter) is attached the same way with
// `file:<id>` (owner request 2026-11-23: "photos, pictures and documents").
//
// Pure. Pinned by tests/journal-workspace.dom.test.tsx.

export const PHOTO_TAG_PREFIX = "photo:";
export const FILE_TAG_PREFIX = "file:";
export const JOURNAL_MAX_PHOTOS = 8;
export const JOURNAL_MAX_FILES = 8;

const isPhotoTag = (t: unknown): t is string => typeof t === "string" && t.startsWith(PHOTO_TAG_PREFIX) && t.length > PHOTO_TAG_PREFIX.length;
const isFileTag = (t: unknown): t is string => typeof t === "string" && t.startsWith(FILE_TAG_PREFIX) && t.length > FILE_TAG_PREFIX.length;
const isPointer = (t: string) => t.startsWith(PHOTO_TAG_PREFIX) || t.startsWith(FILE_TAG_PREFIX);

/** The documents an entry's photos are, in the order they were added. */
export function journalPhotoIds(tags: string[] | undefined | null): string[] {
  return [...new Set((tags || []).filter(isPhotoTag).map((t) => t.slice(PHOTO_TAG_PREFIX.length)))];
}
/** The documents attached to an entry that are not photos. */
export function journalFileIds(tags: string[] | undefined | null): string[] {
  return [...new Set((tags || []).filter(isFileTag).map((t) => t.slice(FILE_TAG_PREFIX.length)))];
}
/** The entry's own tags, without the photo and file pointers. */
export function journalLabels(tags: string[] | undefined | null): string[] {
  return (tags || []).filter((t) => typeof t === "string" && !isPointer(t));
}
export function journalTagsFor(labels: string[], photoIds: string[], fileIds: string[] = []): string[] {
  const clean = [...new Set(labels.map((l) => l.trim()).filter((l) => l && !isPointer(l)))];
  return [
    ...clean,
    ...[...new Set(photoIds)].slice(0, JOURNAL_MAX_PHOTOS).map((id) => `${PHOTO_TAG_PREFIX}${id}`),
    ...[...new Set(fileIds)].slice(0, JOURNAL_MAX_FILES).map((id) => `${FILE_TAG_PREFIX}${id}`),
  ];
}
