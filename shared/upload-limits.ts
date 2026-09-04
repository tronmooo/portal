// ─── How big a file may be, said once ───────────────────────────────────────
//
// Five surfaces enforced four different ceilings — a photo on a liability was
// capped at 2 MB, a profile photo at 5 MB, a chat attachment and a Smart Fill
// scan at 10 MB — and not one of them said so until the file had already been
// chosen and rejected. The number a user is held to should not depend on which
// screen they happened to be on, and they should be able to find it out before
// they pick the file rather than after.
//
// Two limits, because there really are two kinds of upload: an inline IMAGE
// that gets stored and rendered on a card, and a DOCUMENT the extractor reads.
// Shared so the server can hold callers to the same numbers the UI promises.

/** Photos: avatars, a picture of a car, a receipt snapshot on a bill. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Documents and chat attachments: PDFs, scans, statements. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** "8 MB", "512 KB" — the same wording in the hint and in the rejection. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    // Whole megabytes read as limits; fractions read as measurements.
    return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Why a file was refused, in a sentence that names BOTH numbers.
 *
 * "Image too large" leaves the user to guess by how much and to what target;
 * every one of these messages used to do exactly that, and two of them did not
 * even name the limit.
 */
export function tooLargeMessage(fileBytes: number, limitBytes: number): string {
  return `That file is ${formatBytes(fileBytes)}. The limit is ${formatBytes(limitBytes)}.`;
}

/** The hint to show NEXT TO the picker, before anything is chosen. */
export function uploadLimitHint(limitBytes: number): string {
  return `Up to ${formatBytes(limitBytes)}`;
}
