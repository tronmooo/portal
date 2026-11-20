// A new NOTE for a profile: a title and a body, saved as a Note record
// (POST /api/notes — the same service chat's "save a quick note" uses), so it
// shows under Notes & Artifacts and chat can find it.
//
// The profile's "Notes" box used to save only `profile.notes`, a free-text
// memo on the profile row: "Car Maintenance Ideas" typed there and saved never
// appeared in Notes or Artifacts, and the box had no title (Journal tutorial
// QA, 2026-11-20).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatApiError } from "@/lib/formatError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function NewNoteForm({ profileId, onDone, autoFocus = true }: {
  profileId: string;
  /** Called after a save and on Cancel. */
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const t = title.trim();
      const body = content.trim();
      // A title alone is still a note: its text is the title.
      const r = await apiRequest("POST", "/api/notes", { title: t || undefined, content: body || t, profileId });
      return r.json();
    },
    onSuccess: (note: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast(note?.deduped
        ? { title: "You already have this note", description: `"${note.title}" was not saved twice.` }
        : { title: "Note saved", description: `"${note?.title || title}" is in Notes & Artifacts.` });
      setTitle(""); setContent("");
      onDone?.();
    },
    onError: (err: Error) => toast({ title: "Couldn't save note", description: formatApiError(err), variant: "destructive" }),
  });

  const empty = !title.trim() && !content.trim();
  return (
    <div className="space-y-2" data-testid="new-note-form">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        aria-label="Note title"
        className="h-8 text-sm"
        autoFocus={autoFocus}
        data-testid="new-note-title"
      />
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !empty) save.mutate(); }}
        rows={3}
        placeholder="Write the note…"
        aria-label="Note text"
        className="text-sm"
        data-testid="new-note-content"
      />
      <div className="flex gap-2">
        <Button size="sm" className="h-7 text-xs" disabled={empty || save.isPending} onClick={() => save.mutate()} data-testid="new-note-save">
          {save.isPending ? "Saving…" : "Save note"}
        </Button>
        {onDone && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setTitle(""); setContent(""); onDone(); }}>Cancel</Button>
        )}
      </div>
    </div>
  );
}
