// What the Artifacts tab's Delete sends. Its confirmation promises "This
// permanently removes the file and any history. This cannot be undone." — so
// an uploaded file is PURGED (row and the bytes in the storage bucket; the
// data only it provided goes with it, the server's default "cascade"). A plain
// DELETE /api/documents/:id is a soft delete that keeps the bytes for a Trash
// no screen offers, which left every "permanently removed" file in the bucket
// for good (integrity run ui-records.document, 2026-11-27). An artifact (note,
// report, doc, sheet, checklist) is deleted by its own route, which also
// drops its version history (WA7).
export function deleteRequestFor(item: { id: string; isArtifact?: boolean }): { method: "DELETE" | "POST"; url: string } {
  return item.isArtifact
    ? { method: "DELETE", url: `/api/artifacts/${item.id}` }
    : { method: "POST", url: `/api/documents/${item.id}/purge` };
}
