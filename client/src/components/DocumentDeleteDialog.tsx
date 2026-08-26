// ─── Delete a document: the one confirmation, everywhere ────────────────────
//
// A document is a SOURCE, not a file in a list. Extraction writes its fields
// onto profiles, derives calendar dates from it, links it to assets and
// liabilities, and feeds the cached AI summaries those pages render. So
// "delete" is genuinely two different asks, and the user is the only one who
// can say which they mean:
//
//   • Delete the document AND the data it created — the policy number, the
//     renewal date, the premium. Only what THIS document is the sole source of;
//     anything another document also vouches for, or the user has since edited,
//     stays either way.
//   • Delete the document only — the extracted data stays, standing on its own,
//     no longer claiming a source that no longer exists.
//
// Both are global: the document leaves every surface at once. The counts come
// from GET /api/documents/:id/delete-impact, computed from the same provenance
// the server deletes by, so the dialog cannot promise something the cascade
// won't do.
//
// This component owns the mutation too, so every entry point (Documents page,
// an asset's Documents tab, a liability's, anywhere later) gets the same
// prompt, the same request and the same invalidation — the alternative is three
// copies drifting apart, which is how the Documents page and the asset profile
// ended up disagreeing about whether a document existed.
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type DocumentDeletionMode = "cascade" | "document-only";

interface DeleteImpact {
  documentId: string;
  documentName: string;
  documentType?: string;
  extractedFieldCount: number;
  linkedProfiles: Array<{ id: string; name: string; type?: string }>;
  derivedFieldCount: number;
  sharedFieldCount: number;
  derivedEventCount: number;
  aiSummaryProfileCount: number;
}

interface Props {
  /** The document to delete; null closes the dialog. */
  documentId: string | null;
  /** Shown while the impact preview is still loading. */
  documentName?: string;
  onOpenChange: (open: boolean) => void;
  /** Fired after a successful delete — for local list/selection cleanup. */
  onDeleted?: (documentId: string, mode: DocumentDeletionMode) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "66 extracted fields, 3 important dates, and 1 linked asset" — only the non-zero parts. */
function describeImpact(impact: DeleteImpact): string | null {
  const parts: string[] = [];
  if (impact.derivedFieldCount > 0) parts.push(plural(impact.derivedFieldCount, "extracted field"));
  if (impact.derivedEventCount > 0) parts.push(plural(impact.derivedEventCount, "important date"));
  if (impact.linkedProfiles.length > 0) parts.push(plural(impact.linkedProfiles.length, "linked record"));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function DocumentDeleteDialog({ documentId, documentName, onOpenChange, onDeleted }: Props) {
  const { toast } = useToast();

  const impactQuery = useQuery<DeleteImpact>({
    queryKey: ["/api/documents", documentId, "delete-impact"],
    enabled: !!documentId,
    // The dialog is the only reader and it must reflect the data as it stands
    // right now — a preview cached from before the user edited a field would
    // promise a removal the cascade then declines to make.
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/documents/${documentId}/delete-impact`);
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (mode: DocumentDeletionMode) => {
      const id = documentId!;
      await apiRequest("DELETE", `/api/documents/${id}?mode=${mode}`);
      return { id, mode };
    },
    onSuccess: ({ id, mode }) => {
      // Documents feed profiles, the calendar and the trackers page. Every one
      // of those domains has to be told, or the document survives on a screen
      // the deleting screen can't see.
      invalidateDomains("documents", "profiles", "trackers", "events");
      toast({
        title: mode === "cascade" ? "Document and its data deleted" : "Document deleted",
        description:
          mode === "cascade"
            ? "Removed everywhere, along with the data only it provided."
            : "The extracted data was kept and no longer lists this document as its source.",
      });
      onOpenChange(false);
      onDeleted?.(id, mode);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const impact = impactQuery.data;
  const name = impact?.documentName || documentName || "this document";
  const summary = impact ? describeImpact(impact) : null;
  const busy = deleteMutation.isPending;
  const hasDerivedData = !!impact && (impact.derivedFieldCount > 0 || impact.derivedEventCount > 0);

  return (
    <AlertDialog open={!!documentId} onOpenChange={(open) => { if (!open && !busy) onOpenChange(false); }}>
      <AlertDialogContent data-testid="dialog-confirm-delete-document">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {impactQuery.isLoading && <p>Checking what this document created…</p>}
              {!impactQuery.isLoading && summary && (
                <p data-testid="text-delete-impact">
                  This document created or contributed to {summary}.
                </p>
              )}
              {!impactQuery.isLoading && !summary && (
                <p>This document hasn’t contributed any data to your other records.</p>
              )}
              {!!impact && impact.sharedFieldCount > 0 && (
                <p className="text-xs">
                  {plural(impact.sharedFieldCount, "field")} another document also confirms will be kept
                  either way — only this document’s link to them is removed.
                </p>
              )}
              {!!impact && impact.aiSummaryProfileCount > 0 && (
                <p className="text-xs">
                  The AI will stop using this document on{" "}
                  {plural(impact.aiSummaryProfileCount, "profile")}.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Two destructive choices, each labelled with what it costs — not an
            "are you sure?" that makes the decision for the user. When the
            document created nothing, the two are the same act, so offering the
            choice would only be a question with one real answer. */}
        <div className="flex flex-col gap-2">
          {!impactQuery.isLoading && !!impact && !hasDerivedData ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => deleteMutation.mutate("cascade")}
              data-testid="button-delete-document-and-data"
            >
              Delete document
            </Button>
          ) : (
          <>
          <Button
            variant="destructive"
            className="h-auto flex-col items-start py-2 text-left whitespace-normal"
            disabled={busy}
            onClick={() => deleteMutation.mutate("cascade")}
            data-testid="button-delete-document-and-data"
          >
            <span className="font-medium">Delete document and its data</span>
            <span className="text-xs font-normal opacity-90">
              Removes the document and the data created only from it.
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto flex-col items-start py-2 text-left whitespace-normal"
            disabled={busy}
            onClick={() => deleteMutation.mutate("document-only")}
            data-testid="button-delete-document-only"
          >
            <span className="font-medium">Delete document only</span>
            <span className="text-xs font-normal text-muted-foreground">
              Keeps the extracted data but removes the document and its source links.
            </span>
          </Button>
          </>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="button-cancel-delete-document">
            Cancel
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DocumentDeleteDialog;
