// ── One confirmation for deleting a document, everywhere ─────────────────────
//
// User, 2026-08-05: "When you delete a document, you should delete all the data
// that comes with it and it should ask before you delete a document. If there is
// data I've saved with the document there should be an option when you delete the
// document it should say are you sure? Do you want to remove all the data in the
// info?"
//
// Four screens delete documents — the Info tab, a profile's Documents tab, the
// Documents page under Trackers, and a liability's documents card. They had four
// different answers to "does this ask first?" (three did, the liability card
// deleted on the spot with no prompt at all) and none of them mentioned the
// profile fields the document had written. So this is one component: same
// question, same wording, same options, wherever the delete is triggered.
//
// WHAT IT ASKS. The dialog fetches the fields this document actually put on your
// profiles (/api/documents/:id/derived-fields) and names them. If there are any,
// it offers to remove them along with the file — checked by default, because
// that is what the user asked for and what "delete the document" ought to mean.
// Unchecking keeps the data and deletes only the file.
//
// A field the user has EDITED since the document saved it is called out
// separately: purging it discards their own work, not just the document's, and
// that deserves to be said before they agree rather than discovered afterwards.
//
// The list is not decoration — the server computes the purge from the SAME
// function that produced this preview (shared/document-field-provenance), so
// what is listed is exactly what is removed. A confirm prompt whose promise
// doesn't match its action is worse than no prompt at all.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle } from "lucide-react";
import type { DocumentDerivedField } from "@shared/document-field-provenance";

interface DerivedFieldsResponse {
  documentId: string;
  documentName: string;
  profiles: Array<{ id: string; name: string; fields: DocumentDerivedField[] }>;
  total: number;
  editedCount: number;
}

export interface DeleteDocumentTarget {
  id: string;
  name?: string;
}

export function DeleteDocumentDialog({
  document: target,
  onOpenChange,
  onConfirm,
  isDeleting,
}: {
  /** The document awaiting confirmation, or null when the dialog is closed. */
  document: DeleteDocumentTarget | null;
  onOpenChange: (open: boolean) => void;
  /**
   * Runs the delete. `purgeFields` is the user's answer to "remove the data
   * too?" — pass it straight through to DELETE /api/documents/:id.
   * Each caller keeps its own mutation so its optimistic cache updates and
   * invalidations stay intact.
   */
  onConfirm: (docId: string, purgeFields: boolean) => void;
  isDeleting?: boolean;
}) {
  // Default ON: "delete the document" should mean the data goes with it.
  const [purge, setPurge] = useState(true);

  const { data, isLoading } = useQuery<DerivedFieldsResponse>({
    queryKey: ["/api/documents", target?.id, "derived-fields"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/documents/${target!.id}/derived-fields`)).json(),
    enabled: !!target?.id,
    // Always ask fresh: the whole point is to state the CURRENT truth about what
    // is on the profile right now, and a field edited a minute ago changes the
    // warning this dialog shows.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const derived = data?.profiles || [];
  const total = data?.total || 0;
  const edited = data?.editedCount || 0;
  const name = target?.name || data?.documentName || "this document";

  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) setPurge(true); // never carry a choice into the next document
        onOpenChange(open);
      }}
    >
      <AlertDialogContent data-testid="dialog-confirm-delete-document">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{name}"?</AlertDialogTitle>
          <AlertDialogDescription>
            The file is permanently removed, from every profile it's linked to — not just
            the one you're looking at. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : total > 0 ? (
          <div className="rounded-lg border p-3 space-y-2" data-testid="doc-delete-derived">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox
                checked={purge}
                onCheckedChange={(v) => setPurge(v === true)}
                className="mt-0.5"
                data-testid="doc-delete-purge-fields"
              />
              <span className="text-sm">
                <span className="font-medium">
                  Also remove the {total} {total === 1 ? "field" : "fields"} it saved
                </span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Uncheck to keep this data on the profile and delete only the file.
                </span>
              </span>
            </label>

            {derived.map((p) => (
              <div key={p.id} className="pl-7">
                {derived.length > 1 && (
                  <div className="micro-label text-muted-foreground">{p.name}</div>
                )}
                <div className="flex flex-wrap gap-1 mt-1">
                  {p.fields.map((f) => (
                    <span
                      key={f.path}
                      className={`rounded-md px-1.5 py-0.5 text-[11px] ${
                        f.edited
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-muted text-muted-foreground"
                      }`}
                      title={`${f.label}: ${f.value}${f.edited ? " (edited since the document saved it)" : ""}`}
                    >
                      {f.label}
                    </span>
                  ))}
                </div>
              </div>
            ))}

            {edited > 0 && purge && (
              <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 pl-7">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  {edited === 1
                    ? "1 field has been edited since the document saved it — your change will be removed too."
                    : `${edited} fields have been edited since the document saved them — your changes will be removed too.`}
                </span>
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="doc-delete-no-derived">
            This document hasn't saved any fields to a profile, so nothing else is affected.
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete-document">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={isDeleting}
            onClick={() => {
              if (target) onConfirm(target.id, total > 0 && purge);
            }}
            data-testid="button-confirm-delete-document"
          >
            {total > 0 && purge ? "Delete file and data" : "Delete file"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DeleteDocumentDialog;
