// "Send this anywhere": every way an artifact can leave the app, from one
// button. Nothing is written until a choice is tapped; only the link options
// write (they mint the artifact's public read-only link).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { copyText } from "@/lib/clipboard";
import {
  type ShareableArtifact, artifactPlainText, canNativeShare, copyArtifactText,
  downloadArtifact, emailHref, ensureShareLink, nativeShare, publicShareUrl,
  revokeShareLink, shareArtifactAsFile, smsHref,
} from "@/lib/artifact-share";
import { Share2, Link2, Copy, Mail, MessageSquare, Download, FileUp, Send, Link2Off, Loader2 } from "lucide-react";

/** An uploaded document's own file, sent as it is (PDF, photo…). */
export interface ShareableDocumentFile { id: string; name: string; mimeType?: string }

async function fetchDocumentFile(doc: ShareableDocumentFile): Promise<File> {
  const res = await apiRequest("GET", `/api/documents/${encodeURIComponent(doc.id)}/file`);
  const blob = await res.blob();
  return new File([blob], doc.name || "document", { type: doc.mimeType || blob.type || "application/octet-stream" });
}

export function ArtifactShareMenu({ artifact, documentFile, trigger, align = "end" }: {
  artifact: ShareableArtifact;
  documentFile?: ShareableDocumentFile;
  /** Custom trigger content; defaults to a round share icon button. */
  trigger?: React.ReactNode;
  align?: "start" | "end" | "center";
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const saved = !!artifact.id && !artifact.data && !documentFile;
  const native = canNativeShare();
  const existingUrl = artifact.shareToken ? publicShareUrl(artifact.shareToken) : undefined;

  const withLink = async (use: (url: string) => Promise<void> | void) => {
    if (!artifact.id) return;
    setBusy(true);
    try {
      const url = existingUrl || await ensureShareLink(artifact.id);
      void qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      await use(url);
    } catch {
      toast({ title: "Couldn't create a share link", description: "Nothing was shared. Try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const copied = (ok: boolean, what: string): void => void
    toast(ok ? { title: `${what} copied` } : { title: `Couldn't copy the ${what.toLowerCase()}`, variant: "destructive" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ? (
          <button type="button" onClick={(e) => e.stopPropagation()} aria-label={`Share ${artifact.title || "artifact"}`} data-testid="button-artifact-share">
            {trigger}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            aria-label={`Share ${artifact.title || "artifact"}`}
            title="Share"
            data-testid="button-artifact-share"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-60 z-[70]" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Send “{artifact.title || "artifact"}”</DropdownMenuLabel>
        {native && (
          <DropdownMenuItem
            onSelect={() => { void nativeShare({ title: artifact.title, text: artifactPlainText(artifact) }); }}
            data-testid="share-native"
          >
            <Send className="h-4 w-4 mr-2" /> Share to an app…
          </DropdownMenuItem>
        )}
        {documentFile && (
          <DropdownMenuItem
            onSelect={async () => {
              setBusy(true);
              try {
                const file = await fetchDocumentFile(documentFile);
                const r = native ? await nativeShare({ title: artifact.title, files: [file] }) : "unsupported";
                if (r === "unsupported") {
                  const url = URL.createObjectURL(file);
                  const a = document.createElement("a");
                  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
              } catch {
                toast({ title: "Couldn't get the file", description: "This document may have no file kept — only its details.", variant: "destructive" });
              } finally {
                setBusy(false);
              }
            }}
            data-testid="share-document-file"
          >
            <FileUp className="h-4 w-4 mr-2" /> {native ? "Send the file…" : "Download the file"}
          </DropdownMenuItem>
        )}
        {native && !documentFile && (
          <DropdownMenuItem
            onSelect={() => {
              void shareArtifactAsFile(artifact).then(r => {
                if (r === "unsupported") { downloadArtifact(artifact); toast({ title: "Saved as a file", description: "This browser can't send files directly, so it was downloaded." }); }
              });
            }}
            data-testid="share-file"
          >
            <FileUp className="h-4 w-4 mr-2" /> Send as a file…
          </DropdownMenuItem>
        )}
        {saved && (
          <DropdownMenuItem
            onSelect={() => withLink(async (url) => {
              const r = native ? await nativeShare({ title: artifact.title, url }) : "unsupported";
              if (r === "unsupported") copied(await copyText(url), "Link");
            })}
            data-testid="share-link"
          >
            <Link2 className="h-4 w-4 mr-2" /> {native ? "Share a view-only link…" : "Copy view-only link"}
          </DropdownMenuItem>
        )}
        {saved && native && (
          <DropdownMenuItem onSelect={() => withLink(async (url) => { copied(await copyText(url), "Link"); })} data-testid="share-copy-link">
            <Link2 className="h-4 w-4 mr-2" /> Copy view-only link
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => { void copyArtifactText(artifact).then(ok => copied(ok, "Text")); }} data-testid="share-copy-text">
          <Copy className="h-4 w-4 mr-2" /> Copy as text
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { window.location.href = emailHref(artifact, existingUrl); }} data-testid="share-email">
          <Mail className="h-4 w-4 mr-2" /> Email
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { window.location.href = smsHref(artifact, existingUrl); }} data-testid="share-sms">
          <MessageSquare className="h-4 w-4 mr-2" /> Text message
        </DropdownMenuItem>
        {!documentFile && (
          <DropdownMenuItem onSelect={() => downloadArtifact(artifact)} data-testid="share-download">
            <Download className="h-4 w-4 mr-2" /> Download
          </DropdownMenuItem>
        )}
        {saved && artifact.shareToken && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={async () => {
                try {
                  await revokeShareLink(artifact.id!);
                  void qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
                  toast({ title: "Link turned off", description: "Anyone with the old link can no longer open it." });
                } catch {
                  toast({ title: "Couldn't turn the link off", variant: "destructive" });
                }
              }}
              data-testid="share-revoke"
            >
              <Link2Off className="h-4 w-4 mr-2" /> Turn off view-only link
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
