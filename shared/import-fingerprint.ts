/**
 * Identity of a backup file for "already restored" checks (D288).
 *
 * Restoring the same export twice used to double every task, expense and
 * event (profiles were matched, their records were not). The file's own
 * `exportedAt` plus the size of each collection is enough to recognise the
 * same file again; a later export of the same account carries a new
 * `exportedAt` and restores as the user intends.
 */
export const IMPORTED_BACKUP_PREF_PREFIX = "imported-backup:";

export function exportFingerprint(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  const exportedAt = String(data.exportedAt || "").trim();
  if (!exportedAt) return null;
  const counts = Object.keys(data)
    .filter((k) => Array.isArray(data[k]))
    .sort()
    .map((k) => `${k}=${data[k].length}`)
    .join(",");
  const raw = `${String(data.version || "")}|${exportedAt}|${counts}`;
  // FNV-1a over the descriptor: short, stable, no crypto needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16).padStart(8, "0")}-${exportedAt.replace(/[^0-9A-Za-z]/g, "").slice(0, 20)}`;
}

/** The message a repeated restore gets, naming when the file was restored before. */
export function alreadyRestoredMessage(restoredAtISO: string): string {
  const when = /^\d{4}-\d{2}-\d{2}/.test(restoredAtISO) ? restoredAtISO.slice(0, 10) : "earlier";
  return `This backup was already restored on ${when}. Restoring it again would duplicate its tasks, expenses and events. Export a fresh backup if you need a newer one.`;
}
