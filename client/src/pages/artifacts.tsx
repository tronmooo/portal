import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckSquare, FileText, Pin, Plus, X, ArrowLeft, Trash2, PinOff } from "lucide-react";
import { Link } from "wouter";
import type { Artifact } from "@shared/schema";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

function useArtifactMutations() {
  const { toast } = useToast();

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/artifacts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Deleted" });
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      apiRequest("PATCH", `/api/artifacts/${id}`, { pinned }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] }),
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  return { deleteMutation, pinMutation };
}

function ChecklistCard({ artifact, onDeleteRequest }: { artifact: Artifact; onDeleteRequest: (a: Artifact) => void }) {
  const { toast } = useToast();
  const { pinMutation } = useArtifactMutations();
  const total = artifact.items.length;
  const done = artifact.items.filter((i) => i.checked).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const toggleMutation = useMutation({
    mutationFn: (itemId: string) => apiRequest("POST", `/api/artifacts/${artifact.id}/toggle/${itemId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] }),
    onError: () => toast({ title: "Failed to toggle item", variant: "destructive" }),
  });

  return (
    <Card className="relative" data-testid={`card-artifact-${artifact.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <CheckSquare className="h-4 w-4 text-primary shrink-0" />
            <CardTitle className="text-sm font-medium truncate">{artifact.title}</CardTitle>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => pinMutation.mutate({ id: artifact.id, pinned: !artifact.pinned })}
              aria-label={artifact.pinned ? "Unpin" : "Pin"}
              data-testid={`button-pin-artifact-${artifact.id}`}
            >
              {artifact.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => onDeleteRequest(artifact)}
              aria-label={`Delete ${artifact.title}`}
              data-testid={`button-delete-artifact-${artifact.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[10px] text-muted-foreground">{done}/{total}</span>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="space-y-1.5">
          {artifact.items.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <Checkbox
                checked={item.checked}
                onCheckedChange={() => toggleMutation.mutate(item.id)}
                className="h-3.5 w-3.5"
                data-testid={`checkbox-${item.id}`}
              />
              <span className={`text-xs ${item.checked ? "line-through text-muted-foreground" : ""}`}>
                {item.text}
              </span>
            </div>
          ))}
        </div>
        {artifact.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-border">
            {artifact.tags.map((t, i) => (
              <span key={i} className="text-[10px] text-muted-foreground">#{t}</span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NoteCard({ artifact, onDeleteRequest }: { artifact: Artifact; onDeleteRequest: (a: Artifact) => void }) {
  const { pinMutation } = useArtifactMutations();

  return (
    <Card className="relative" data-testid={`card-artifact-${artifact.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-primary shrink-0" />
            <CardTitle className="text-sm font-medium truncate">{artifact.title}</CardTitle>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => pinMutation.mutate({ id: artifact.id, pinned: !artifact.pinned })}
              aria-label={artifact.pinned ? "Unpin" : "Pin"}
              data-testid={`button-pin-artifact-${artifact.id}`}
            >
              {artifact.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => onDeleteRequest(artifact)}
              aria-label={`Delete ${artifact.title}`}
              data-testid={`button-delete-artifact-${artifact.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <p className="text-xs text-foreground/80 whitespace-pre-wrap line-clamp-6">{artifact.content}</p>
        {artifact.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-border">
            {artifact.tags.map((t, i) => (
              <span key={i} className="text-[10px] text-muted-foreground">#{t}</span>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground mt-2">
          Updated {new Date(artifact.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </p>
      </CardContent>
    </Card>
  );
}

export default function ArtifactsPage() {
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<"checklist" | "note">("checklist");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [items, setItems] = useState<string[]>([""]);
  const [deleteTarget, setDeleteTarget] = useState<Artifact | null>(null);

  const { data: artifacts = [], isLoading } = useQuery<Artifact[]>({
    queryKey: ["/api/artifacts"],
    queryFn: () => apiRequest("GET", "/api/artifacts").then((r) => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/artifacts", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      setTitle(""); setContent(""); setItems([""]); setShowCreate(false);
      toast({ title: "Created" });
    },
    onError: () => toast({ title: "Failed to create artifact", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/artifacts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const pinned = artifacts.filter((a) => a.pinned);
  const unpinned = artifacts.filter((a) => !a.pinned);

  const handleCreate = () => {
    if (!title.trim()) return;
    if (createType === "checklist") {
      createMutation.mutate({
        type: "checklist",
        title: title.trim(),
        items: items.filter((i) => i.trim()).map((text) => ({ text: text.trim(), checked: false })),
      });
    } else {
      createMutation.mutate({ type: "note", title: title.trim(), content });
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button
                className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
                aria-label="Back"
                data-testid="button-back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-lg font-semibold">Artifacts</h1>
          </div>
          <p className="text-xs text-muted-foreground">{artifacts.length} checklists & notes</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} data-testid="button-create-artifact">
          {showCreate ? (
            <><X className="h-3.5 w-3.5 mr-1" /> Cancel</>
          ) : (
            <><Plus className="h-3.5 w-3.5 mr-1" /> New</>
          )}
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="p-4 space-y-3">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={createType === "checklist" ? "default" : "outline"}
              onClick={() => setCreateType("checklist")}
              className="text-xs"
            >
              <CheckSquare className="h-3 w-3 mr-1" /> Checklist
            </Button>
            <Button
              size="sm"
              variant={createType === "note" ? "default" : "outline"}
              onClick={() => setCreateType("note")}
              className="text-xs"
            >
              <FileText className="h-3 w-3 mr-1" /> Note
            </Button>
          </div>
          <Input
            placeholder="Title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="input-artifact-title"
          />
          {createType === "checklist" ? (
            <div className="space-y-1.5">
              {items.map((item, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder={`Item ${i + 1}...`}
                    value={item}
                    onChange={(e) => {
                      const n = [...items];
                      n[i] = e.target.value;
                      setItems(n);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && item.trim()) setItems([...items, ""]);
                    }}
                    data-testid={`input-item-${i}`}
                  />
                  {items.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => setItems(items.filter((_, j) => j !== i))}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setItems([...items, ""])}
                className="text-xs"
              >
                <Plus className="h-3 w-3 mr-1" /> Add item
              </Button>
            </div>
          ) : (
            <Textarea
              placeholder="Note content..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              data-testid="input-artifact-content"
            />
          )}
          <Button
            size="sm"
            disabled={!title.trim() || createMutation.isPending}
            onClick={handleCreate}
            className="w-full"
            data-testid="button-save-artifact"
          >
            Create {createType === "checklist" ? "Checklist" : "Note"}
          </Button>
        </Card>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this {deleteTarget?.type}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-artifact"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : artifacts.length === 0 ? (
        <div className="text-center py-12">
          <CheckSquare className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">No artifacts yet</h3>
          <p className="text-xs text-muted-foreground mb-4">Create checklists and notes to organise your life.</p>
          <Button size="sm" onClick={() => setShowCreate(true)} data-testid="button-create-artifact-empty">
            <Plus className="h-3.5 w-3.5 mr-1" /> Create Your First Artifact
          </Button>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Pin className="h-3 w-3" /> Pinned
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {pinned.map((a) =>
                  a.type === "checklist" ? (
                    <ChecklistCard key={a.id} artifact={a} onDeleteRequest={setDeleteTarget} />
                  ) : (
                    <NoteCard key={a.id} artifact={a} onDeleteRequest={setDeleteTarget} />
                  )
                )}
              </div>
            </div>
          )}
          {unpinned.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {unpinned.map((a) =>
                a.type === "checklist" ? (
                  <ChecklistCard key={a.id} artifact={a} onDeleteRequest={setDeleteTarget} />
                ) : (
                  <NoteCard key={a.id} artifact={a} onDeleteRequest={setDeleteTarget} />
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
