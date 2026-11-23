// Notes workspace (owner request 2026-11-22): a full-screen note editor with
// the saved notes beside it. Saves itself; the X goes back to AI Chat.
//
// Rules it keeps:
//  - Opening writes nothing (Rule 3): a note is created by the first text typed.
//  - A save never writes over another note (J1): when the server answers that
//    a note with this exact text already exists, this editor does NOT adopt
//    that row — it would then overwrite it with whatever is typed next.
//  - The AI proposes; "Use this" applies. Nothing the AI returns is saved on
//    its own.
//  - A failed list is an error with a retry, never "no notes" (Rule 7).
//  - Delete takes two taps (Rule 8).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Heading2, List, ListTodo, Loader2, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { WorkspaceShell, WorkspaceAiBar, aiErrorText, leaveWorkspace } from "@/components/workspace/WorkspaceShell";

interface NoteRow { id: string; title: string; content: string; tags?: string[]; updatedAt?: string; createdAt?: string; linkedProfiles?: string[] }
interface ProfileRow { id: string; name: string; type: string }

export const NOTE_AUTOSAVE_MS = 900;

/** A note with no typed title is named by its first line. */
export function noteTitleFromText(content: string): string {
  const first = String(content || "").split("\n").map((l) => l.replace(/^[#\-\s[\]x]+/i, "").trim()).find(Boolean) || "";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

type SaveState = "new" | "dirty" | "saving" | "saved" | "error";
const STATUS: Record<SaveState, string> = {
  new: "Not saved yet", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Couldn't save — will retry",
};

export default function NotesWorkspacePage() {
  useEffect(() => { document.title = "Notes — Portol"; }, []);
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const qc = useQueryClient();
  // The list beside the editor is its own query; the artifacts domain covers
  // every other screen that shows notes.
  const refreshNotes = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["/api/notes"] });
    void invalidateDomain("artifacts");
  }, [qc]);

  const notesQuery = useQuery<NoteRow[]>({ queryKey: ["/api/notes"] });
  const profilesQuery = useQuery<ProfileRow[]>({ queryKey: ["/api/profiles"] });
  const notes = Array.isArray(notesQuery.data) ? notesQuery.data : [];
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : [];

  const [noteId, setNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [titleTyped, setTitleTyped] = useState(false);
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [profileId, setProfileId] = useState("");
  const [state, setState] = useState<SaveState>("new");
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Latest values for the save loop, which runs outside render.
  const latest = useRef({ noteId, title, titleTyped, content, tags, profileId });
  latest.current = { noteId, title, titleTyped, content, tags, profileId };
  const dirty = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveNow = useCallback((): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    chain.current = chain.current.then(async () => {
      if (!dirty.current) return;
      const v = latest.current;
      if (!v.content.trim()) return; // a note is its text; nothing to save yet
      dirty.current = false;
      setState("saving");
      const tagList = v.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const noteTitle = (v.titleTyped ? v.title.trim() : "") || noteTitleFromText(v.content) || "Note";
      try {
        if (v.noteId) {
          await apiRequest("PATCH", `/api/notes/${v.noteId}`, { title: noteTitle, content: v.content, tags: tagList });
        } else {
          const r = await apiRequest("POST", "/api/notes", {
            title: noteTitle, content: v.content, tags: tagList, ...(v.profileId ? { profileId: v.profileId } : {}),
          });
          const row = await r.json();
          // The same text already exists as another note: that note stays
          // untouched, and this one is created once its text differs.
          if (row?.id && !row.deduped) setNoteId(row.id);
          if (row?.id && !row.deduped) latest.current = { ...latest.current, noteId: row.id };
        }
        refreshNotes();
        setState(dirty.current ? "dirty" : "saved");
      } catch {
        dirty.current = true;
        setState("error");
      }
    });
    return chain.current;
  }, [refreshNotes]);

  const touch = useCallback(() => {
    dirty.current = true;
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, NOTE_AUTOSAVE_MS);
  }, [saveNow]);

  // Leaving by any road saves what is pending.
  useEffect(() => () => { if (dirty.current) void saveNow(); }, [saveNow]);

  const openNote = async (n: NoteRow | null) => {
    await saveNow();
    setProposal(null);
    setNoteId(n?.id ?? null);
    setTitle(n?.title ?? "");
    setTitleTyped(!!n);
    setContent(n?.content ?? "");
    setTags((n?.tags || []).join(", "));
    setProfileId("");
    setState(n ? "saved" : "new");
    setListOpen(false);
    if (!n) textRef.current?.focus();
  };

  const insert = (prefix: string) => {
    const el = textRef.current;
    const at = el ? el.selectionStart : content.length;
    const lineStart = content.lastIndexOf("\n", at - 1) + 1;
    const next = content.slice(0, lineStart) + prefix + content.slice(lineStart);
    setContent(next);
    touch();
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + prefix.length, at + prefix.length); });
  };

  const askAi = async (instruction: string) => {
    setAiBusy(true);
    try {
      const r = await apiRequest("POST", "/api/workspace/notes/assist", { instruction, content });
      const j = await r.json();
      if (typeof j?.content !== "string" || !j.content.trim()) throw new Error("The AI returned nothing.");
      setProposal(j.content);
    } catch (err) {
      toast({ title: "AI couldn't help with that", description: aiErrorText(err), variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  };

  const makeTask = async () => {
    const taskTitle = (titleTyped ? title.trim() : "") || noteTitleFromText(content);
    if (!taskTitle) return;
    try {
      await apiRequest("POST", "/api/tasks", { title: taskTitle, ...(content.trim() ? { description: content.slice(0, 2000) } : {}) });
      void invalidateDomain("tasks");
      toast({ title: "Task created", description: taskTitle });
    } catch (err) {
      toast({ title: "Couldn't create the task", description: aiErrorText(err), variant: "destructive" });
    }
  };

  const removeNote = async () => {
    if (!noteId) return;
    try {
      dirty.current = false;
      await apiRequest("DELETE", `/api/notes/${noteId}`);
      refreshNotes();
      toast({ title: "Note deleted" });
      await openNote(null);
    } catch (err) {
      toast({ title: "Couldn't delete the note", description: aiErrorText(err), variant: "destructive" });
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = [...notes].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    return q ? rows.filter((n) => `${n.title} ${n.content} ${(n.tags || []).join(" ")}`.toLowerCase().includes(q)) : rows;
  }, [notes, search]);

  const onDropText = async (e: React.DragEvent) => {
    const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith("text/") || /\.(txt|md|csv)$/i.test(f.name));
    if (!file) return;
    e.preventDefault();
    const text = await file.text();
    setContent((c) => (c ? `${c}\n\n${text}` : text));
    touch();
  };

  const list = (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 flex gap-2 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
            className="w-full h-9 rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none"
            data-testid="input-notes-search"
          />
        </div>
        <button type="button" onClick={() => void openNote(null)} className="h-9 px-2.5 rounded-md border border-border text-sm flex items-center gap-1 hover:bg-muted" data-testid="button-note-new">
          <Plus className="h-4 w-4" /> New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1" data-testid="notes-list">
        {notesQuery.isLoading ? (
          <p className="p-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</p>
        ) : notesQuery.isError && notes.length === 0 ? (
          <div className="p-3 text-xs" data-testid="notes-list-error">
            <p className="text-destructive">Couldn't load your notes.</p>
            <button type="button" className="underline mt-1" onClick={() => notesQuery.refetch()}>Retry</button>
          </div>
        ) : shown.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{search.trim() ? `No note matches "${search.trim()}".` : "No notes yet. Start typing to write the first."}</p>
        ) : shown.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => void openNote(n)}
            className={`w-full text-left rounded-md px-2.5 py-2 border ${n.id === noteId ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/60"}`}
            data-testid={`note-row-${n.id}`}
          >
            <div className="text-sm font-medium truncate">{n.title || "Untitled"}</div>
            <div className="text-[11px] text-muted-foreground truncate">{String(n.content || "").replace(/\s+/g, " ").slice(0, 80)}</div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <WorkspaceShell
      kind="notes"
      status={STATUS[state]}
      onClose={async () => { await saveNow(); leaveWorkspace(); }}
      title={
        <input
          value={titleTyped ? title : (title || noteTitleFromText(content))}
          onChange={(e) => { setTitle(e.target.value); setTitleTyped(true); touch(); }}
          placeholder="Untitled note"
          aria-label="Note title"
          className="w-full bg-transparent text-base font-semibold outline-none truncate"
          data-testid="input-note-title"
        />
      }
      actions={
        <>
          <button type="button" onClick={() => setListOpen((v) => !v)} className="md:hidden h-9 px-2.5 rounded-md border border-border text-xs" data-testid="button-notes-list">
            {listOpen ? "Editor" : `Notes (${notes.length})`}
          </button>
          {noteId && (
            <button
              type="button"
              onClick={() => confirm("delete", () => void removeNote())}
              className={`h-9 px-2.5 rounded-md border text-xs flex items-center gap-1 ${isArmed("delete") ? "border-destructive text-destructive" : "border-border text-muted-foreground"}`}
              data-testid="button-note-delete"
            >
              <Trash2 className="h-3.5 w-3.5" /> {isArmed("delete") ? "Tap again to delete" : <span className="hidden sm:inline">Delete</span>}
            </button>
          )}
        </>
      }
    >
      <div className="flex-1 min-h-0 flex">
        <aside className={`${listOpen ? "flex" : "hidden"} md:flex flex-col w-full md:w-72 border-r border-border bg-card/50 min-h-0`}>{list}</aside>
        <div className={`${listOpen ? "hidden" : "flex"} md:flex flex-1 min-w-0 flex-col`}>
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/30 flex-wrap shrink-0">
            <button type="button" onClick={() => insert("- [ ] ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted" data-testid="button-note-checklist"><ListTodo className="h-4 w-4" /> Checklist</button>
            <button type="button" onClick={() => insert("- ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted"><List className="h-4 w-4" /> List</button>
            <button type="button" onClick={() => insert("## ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted"><Heading2 className="h-4 w-4" /> Heading</button>
            <div className="w-px h-5 bg-border mx-1" />
            <button type="button" onClick={() => void makeTask()} disabled={!content.trim() && !title.trim()} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted disabled:opacity-40" data-testid="button-note-to-task"><CheckSquare className="h-4 w-4" /> Make a task</button>
            <div className="flex-1" />
            <input
              value={tags}
              onChange={(e) => { setTags(e.target.value); touch(); }}
              placeholder="Tags, comma separated"
              aria-label="Tags"
              className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs outline-none"
              data-testid="input-note-tags"
            />
            {!noteId && profiles.length > 1 && (
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                aria-label="Link this note to a profile"
                title="Link this note to a profile"
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                data-testid="select-note-profile"
              >
                <option value="">Not linked</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</option>)}
              </select>
            )}
          </div>
          <div className="flex-1 min-h-0 flex flex-col" onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDropText(e)}>
            <textarea
              ref={textRef}
              value={content}
              onChange={(e) => { setContent(e.target.value); touch(); }}
              placeholder="Start typing, paste, or drop a text file here…"
              aria-label="Note"
              className="flex-1 block w-full max-w-3xl mx-auto bg-transparent px-5 py-5 text-base leading-relaxed outline-none resize-none"
              data-testid="input-note-content"
            />
          </div>
          {proposal !== null && (
            <div className="border-t border-border bg-card px-4 py-3 shrink-0 max-h-[40vh] overflow-y-auto" data-testid="note-ai-proposal">
              <p className="text-xs font-semibold flex items-center gap-1.5 mb-2"><Sparkles className="h-3.5 w-3.5 text-primary" /> AI suggestion — your note is unchanged until you choose</p>
              <pre className="whitespace-pre-wrap text-sm font-sans bg-muted/40 rounded-md p-3">{proposal}</pre>
              <div className="flex gap-2 mt-2">
                <button type="button" className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold" onClick={() => { setContent(proposal); setProposal(null); touch(); }} data-testid="button-note-ai-use">Use this</button>
                <button type="button" className="h-9 px-3 rounded-md border border-border text-sm" onClick={() => setProposal(null)} data-testid="button-note-ai-discard">Discard</button>
              </div>
            </div>
          )}
          <WorkspaceAiBar
            placeholder="Ask AI to organize, tidy or turn this note into a checklist…"
            busy={aiBusy}
            onAsk={(i) => void askAi(i)}
            suggestions={content.trim() ? ["Organize this note", "Turn this into a checklist", "Fix spelling and grammar"] : []}
            testId="note-ai"
          />
        </div>
      </div>
    </WorkspaceShell>
  );
}
