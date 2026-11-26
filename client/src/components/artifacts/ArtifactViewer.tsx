// The full-screen artifact viewer — the one place an artifact is opened,
// whether from a chat card or the Artifacts tab. It shows the WHOLE artifact
// (never a half-width pane with "Unknown artifact type"), with an X at the
// upper right, a star, a share menu that sends it anywhere, and the
// artifact's own controls (checklist boxes, chart switches, an HTML app).
//
// It renders the LIVE row: a saved artifact is found again in the
// /api/artifacts list by id, so a checklist ticked here, in the tab or from
// chat reads the same (Rule 6/7). Opening it writes nothing (Rule 3).
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { apiRequest } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { formatTimeAgo } from "@/lib/format";
import { ArtifactContent } from "./ArtifactContent";
import { ArtifactShareMenu } from "./ArtifactShareMenu";
import { artifactKind, displayTypeOf, KindBadge } from "./artifact-kinds";
import { StructuredArtifactBody, isStructuredArtifact } from "@/components/ArtifactPanel";
import { X, Star, MoreHorizontal, Pencil, MessageSquare, Archive, ExternalLink } from "lucide-react";

export interface ArtifactViewerProps {
  /** A saved artifact row, or a structured chat artifact ({ type, title, data }). */
  artifact: any | null;
  onClose: () => void;
  /** Where it was opened from — decides which "open elsewhere" links show. */
  from: "chat" | "artifacts";
  /** Owner names for the subtitle (the tab knows them). */
  owners?: string[];
}

export function ArtifactViewer({ artifact, onClose, from, owners }: ArtifactViewerProps) {
  const qc = useQueryClient();
  const saved = !!artifact?.id && !isStructuredArtifact(artifact);
  const { data: list } = useQuery<any[]>({
    queryKey: ["/api/artifacts"],
    queryFn: () => apiRequest("GET", "/api/artifacts").then(r => r.json()),
    enabled: saved,
  });
  const live = useMemo(() => {
    if (!artifact) return null;
    if (!saved || !Array.isArray(list)) return artifact;
    return list.find(a => a?.id === artifact.id) || artifact;
  }, [artifact, list, saved]);

  const pinMut = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) =>
      (await apiRequest("PATCH", `/api/artifacts/${id}`, { pinned })).json(),
    onMutate: async ({ id, pinned }) => {
      await qc.cancelQueries({ queryKey: ["/api/artifacts"] });
      const prev = qc.getQueryData<any[]>(["/api/artifacts"]);
      qc.setQueryData<any[]>(["/api/artifacts"], (old) => old ? old.map(a => a.id === id ? { ...a, pinned } : a) : old);
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["/api/artifacts"], ctx.prev); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["/api/artifacts"] }); },
  });

  const open = !!artifact;
  const type = (live && !isStructuredArtifact(live) ? displayTypeOf(live) : live?.type) as string | undefined;
  const kind = artifactKind(type);
  const Icon = kind.icon;
  // A note that holds a chart spec is a chart: the notes editor would show JSON.
  const editable = saved && (type === "note" || type === "doc" || type === "sheet");
  const updated = live?.updatedAt || live?.createdAt;

  const edit = () => {
    if (!live?.id) return;
    const id = live.id;
    onClose();
    if (type === "note") hashNavigate(`/workspace/notes?note=${encodeURIComponent(id)}&from=artifacts`);
    else hashNavigate(`/editor/${id}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        hideCloseButton
        className="p-0 gap-0 flex flex-col overflow-hidden left-0 top-0 translate-x-0 translate-y-0 w-full max-w-none h-[100dvh] max-h-none rounded-none border-0 sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-4xl sm:h-[92dvh] sm:max-h-[92dvh] sm:rounded-2xl sm:border data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0"
        data-testid="artifact-viewer"
      >
        {live && (
          <>
            {/* Header: what it is, then star · share · more · X (upper right). */}
            <div
              className="shrink-0 border-b border-border/60 bg-background/80 backdrop-blur px-3 sm:px-5 pb-3"
              style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
            >
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 h-10 w-10 shrink-0 rounded-xl flex items-center justify-center border"
                  style={{ background: `hsl(${kind.hsl} / 0.14)`, borderColor: `hsl(${kind.hsl} / 0.4)`, boxShadow: `0 0 18px hsl(${kind.hsl} / 0.25)` }}
                >
                  <Icon className="h-5 w-5" style={{ color: `hsl(${kind.hsl})` }} />
                </span>
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-base sm:text-lg font-semibold leading-snug line-clamp-3" data-testid="artifact-viewer-title">
                    {live.title || "Artifact"}
                  </DialogTitle>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <KindBadge type={type} />
                    {updated && <span>Updated {formatTimeAgo(updated)}</span>}
                    {owners && owners.length > 0 && <span className="truncate max-w-[12rem]">· {owners.join(", ")}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {saved && (
                    <button
                      type="button"
                      onClick={() => pinMut.mutate({ id: live.id, pinned: !live.pinned })}
                      className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-muted/60 transition-colors"
                      aria-label={live.pinned ? "Remove star" : "Star"}
                      aria-pressed={!!live.pinned}
                      title={live.pinned ? "Starred" : "Star"}
                      data-testid="button-artifact-viewer-star"
                    >
                      <Star className={`h-4 w-4 ${live.pinned ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
                    </button>
                  )}
                  <ArtifactShareMenu artifact={live} />
                  {(saved || from === "chat") && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                          aria-label="More"
                          data-testid="button-artifact-viewer-more"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52 z-[70]">
                        {editable && (
                          <DropdownMenuItem onSelect={edit}>
                            <Pencil className="h-4 w-4 mr-2" /> {type === "note" ? "Edit note" : "Open in editor"}
                          </DropdownMenuItem>
                        )}
                        {saved && from === "artifacts" && (
                          <DropdownMenuItem
                            onSelect={() => { const id = live.id; onClose(); hashNavigate(`/chat?artifact=${encodeURIComponent(id)}`); }}
                            data-testid="artifact-open-in-chat"
                          >
                            <MessageSquare className="h-4 w-4 mr-2" /> Open in Chat
                          </DropdownMenuItem>
                        )}
                        {from === "chat" && (
                          <DropdownMenuItem onSelect={() => { onClose(); hashNavigate("/artifacts"); }} data-testid="artifact-open-in-artifacts">
                            <Archive className="h-4 w-4 mr-2" /> Show in Artifacts
                          </DropdownMenuItem>
                        )}
                        {saved && live.shareToken && (
                          <DropdownMenuItem onSelect={() => window.open(`/#/share/${live.shareToken}`, "_blank", "noopener")}>
                            <ExternalLink className="h-4 w-4 mr-2" /> Open view-only link
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-9 w-9 rounded-full flex items-center justify-center bg-muted/50 hover:bg-muted transition-colors"
                    aria-label="Close"
                    data-testid="button-artifact-viewer-close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {/* A note opens read-only here; Edit opens it in the Notes
                  workspace (QA 2026-11-24). A doc/sheet opens in its editor. */}
              {editable && (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={edit}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
                    data-testid={type === "note" ? "button-edit-note" : "button-open-editor"}
                  >
                    <Pencil className="h-3.5 w-3.5" /> {type === "note" ? "Edit" : "Open in editor"}
                  </button>
                </div>
              )}
            </div>

            {/* The whole artifact, scrolling under the header. */}
            <div className="flex-1 overflow-y-auto overscroll-contain" data-testid="artifact-viewer-body">
              <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-5" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
                <SectionErrorBoundary name="artifact-viewer" inline>
                  {isStructuredArtifact(live)
                    ? <StructuredArtifactBody type={live.type} data={live.data} />
                    : <ArtifactContent artifact={live} artifactId={live.id} isArtifact={saved} fill />}
                </SectionErrorBoundary>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ArtifactViewer;
