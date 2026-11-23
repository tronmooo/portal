// Notes workspace (owner request 2026-11-22/23): a full-screen notebook.
// Saved notes on the left (search, categories); on the right one note on a
// sheet: rich text with check lists, a category, tags, a profile link,
// attachments and an AI box. It saves itself; the X goes back to AI Chat.
//
// A note is stored as MARKDOWN (chat, search and every list read it). The
// rich editor is a view of that markdown (shared/note-markdown.ts); a note
// holding something the editor cannot show opens as plain markdown instead,
// so editing never drops it.
//
// Rules it keeps:
//  - Opening writes nothing (Rule 3): a note is created by the first text typed.
//  - A save never writes over another note (J1 / W4): a `deduped` create is
//    not adopted.
//  - The AI proposes; "Use this" applies (W5).
//  - A failed list is an error with a retry, never "no notes" (Rule 7).
//  - The category filter hides rows, so it says so and is never stored (Rule 4).
//  - Delete takes two taps (Rule 8).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import DOMPurify from "dompurify";
import {
  Bold, CheckSquare, Code, Heading1, Heading2, Italic, Link as LinkIcon, List, ListOrdered, ListTodo, Loader2,
  Paperclip, Plus, Quote, Search, Sparkles, Strikethrough, Trash2, FileText,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { WorkspaceShell, WorkspaceAiBar, aiErrorText, leaveWorkspace } from "@/components/workspace/WorkspaceShell";
import {
  attachmentLink, markdownToNoteHtml, noteAttachments, noteCategory, noteDocToMarkdown, noteLabels,
  noteNeedsPlainEditor, noteTagsFor, type NoteNode,
} from "@shared/note-markdown";

interface NoteRow { id: string; title: string; content: string; tags?: string[]; updatedAt?: string; createdAt?: string; linkedProfiles?: string[] }
interface ProfileRow { id: string; name: string; type: string }

export const NOTE_AUTOSAVE_MS = 900;
export const NOTE_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,.doc,.docx";

/** A note with no typed title is named by its first line. */
export function noteTitleFromText(content: string): string {
  const first = String(content || "").split("\n")
    .map((l) => l.replace(/^[#>\-\s[\]x\d.]+/i, "").replace(/[*_`~\\]/g, "").trim()).find(Boolean) || "";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

/** One steady colour per category name. */
export function categoryHue(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
const dot = (name: string) => ({ background: `hsl(${categoryHue(name)} 70% 50%)` });
const snippet = (md: string) => String(md || "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`~\-[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
function ago(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  const [category, setCategory] = useState("");
  const [profileId, setProfileId] = useState("");
  const [state, setState] = useState<SaveState>("new");
  const [search, setSearch] = useState("");
  // A VIEW filter over the list: never stored, always named when it hides rows.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  // "rich" unless the note needs plain markdown, or the writer asked for it.
  const [mode, setMode] = useState<"rich" | "plain">("rich");
  const preferPlain = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Latest values for the save loop, which runs outside render.
  const latest = useRef({ noteId, title, titleTyped, content, tags, category, profileId });
  latest.current = { noteId, title, titleTyped, content, tags, category, profileId };
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
      const tagList = noteTagsFor(v.tags.split(","), v.category);
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
          if (row?.id && !row.deduped) {
            setNoteId(row.id);
            latest.current = { ...latest.current, noteId: row.id };
          }
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

  // ── the rich editor: a view of the note's markdown ─────────────────────────
  const loading = useRef(false);
  const touchRef = useRef(touch);
  touchRef.current = touch;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        underline: false, // markdown has no underline; what it cannot store is not offered
        link: {
          openOnClick: false,
          // An attachment is a link to a saved document inside the app.
          isAllowedUri: (url, ctx) => String(url || "").startsWith("#/documents/") || !!ctx.defaultValidate(url),
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: "<p></p>",
    editorProps: { attributes: { class: "note-rich outline-none min-h-[45vh]", "data-testid": "note-rich-editor", "aria-label": "Note" } },
    onUpdate: ({ editor: ed }) => {
      if (loading.current) return;
      setContent(noteDocToMarkdown(ed.getJSON() as NoteNode));
      touchRef.current();
    },
  });
  const loadIntoEditor = useCallback((md: string) => {
    if (!editor) return;
    loading.current = true;
    try { editor.commands.setContent(markdownToNoteHtml(md), { emitUpdate: false }); } finally { loading.current = false; }
  }, [editor]);

  const openNote = async (n: NoteRow | null) => {
    await saveNow();
    const md = n?.content ?? "";
    const plain = preferPlain.current || noteNeedsPlainEditor(md);
    setProposal(null);
    setNoteId(n?.id ?? null);
    setTitle(n?.title ?? "");
    setTitleTyped(!!n);
    setContent(md);
    setTags(noteLabels(n?.tags).join(", "));
    setCategory(noteCategory(n?.tags));
    setProfileId("");
    setState(n ? "saved" : "new");
    setMode(plain ? "plain" : "rich");
    if (!plain) loadIntoEditor(md);
    setListOpen(false);
  };

  const switchMode = () => {
    if (mode === "rich") { preferPlain.current = true; setMode("plain"); return; }
    if (noteNeedsPlainEditor(content)) {
      toast({ title: "This note stays in Markdown", description: "It has a table, a picture or HTML that the rich editor would drop." });
      return;
    }
    preferPlain.current = false;
    loadIntoEditor(content);
    setMode("rich");
  };

  /** Replace the whole note's text (AI suggestion, dropped text). */
  const replaceContent = (md: string) => {
    setContent(md);
    if (mode === "rich") {
      if (noteNeedsPlainEditor(md)) setMode("plain"); else loadIntoEditor(md);
    }
    touch();
  };
  const appendMarkdown = (md: string) => replaceContent(content.trim() ? `${content.replace(/\s+$/, "")}\n\n${md}` : md);

  const insertPrefix = (prefix: string) => {
    const el = textRef.current;
    const at = el ? el.selectionStart : content.length;
    const lineStart = content.lastIndexOf("\n", at - 1) + 1;
    setContent(content.slice(0, lineStart) + prefix + content.slice(lineStart));
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

  // An attachment is a file saved to Documents and linked from the note.
  const attach = async (file: File | undefined | null) => {
    if (!file) return;
    if (file.size > NOTE_ATTACH_MAX_BYTES) { toast({ title: "File too large", description: "Attachments can be up to 10 MB.", variant: "destructive" }); return; }
    setAttaching(true);
    try {
      const data: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Couldn't read that file."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const r = await apiRequest("POST", "/api/upload/save-only", {
        fileName: file.name, mimeType: file.type || "application/octet-stream", fileData: data,
        ...(profileId ? { profileIds: [profileId] } : {}),
      });
      const j = await r.json();
      if (!j?.documentId) throw new Error("The file was not saved.");
      void invalidateDomain("documents");
      appendMarkdown(attachmentLink({ name: file.name, documentId: String(j.documentId) }));
    } catch (err) {
      toast({ title: "Couldn't attach that file", description: aiErrorText(err), variant: "destructive" });
    } finally {
      setAttaching(false);
    }
  };

  const onDropFile = async (e: React.DragEvent) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (file.type.startsWith("text/") || /\.(md|csv)$/i.test(file.name)) appendMarkdown(await file.text());
    else await attach(file);
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) { const c = noteCategory(n.tags); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [notes]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = [...notes].sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    if (categoryFilter) rows = rows.filter((n) => noteCategory(n.tags) === categoryFilter);
    return q ? rows.filter((n) => `${n.title} ${n.content} ${(n.tags || []).join(" ")}`.toLowerCase().includes(q)) : rows;
  }, [notes, search, categoryFilter]);
  const hiddenByCategory = categoryFilter ? notes.length - notes.filter((n) => noteCategory(n.tags) === categoryFilter).length : 0;

  const attachments = useMemo(() => noteAttachments(content), [content]);
  const proposalHtml = useMemo(() => (proposal === null ? "" : DOMPurify.sanitize(markdownToNoteHtml(proposal))), [proposal]);

  const tool = "h-8 w-8 rounded-md flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary";
  const on = (name: string, attrs?: Record<string, any>) => (mode === "rich" && editor?.isActive(name, attrs)) || undefined;

  const list = (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 pb-2 flex gap-2 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
            className="w-full h-9 rounded-full border border-border bg-background pl-8 pr-3 text-sm outline-none"
            data-testid="input-notes-search"
          />
        </div>
        <button type="button" onClick={() => void openNote(null)} className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-1" data-testid="button-note-new">
          <Plus className="h-4 w-4" /> New
        </button>
      </div>
      {categories.length > 0 && (
        <div className="px-3 pb-2 flex gap-1.5 overflow-x-auto shrink-0" data-testid="notes-category-filter">
          <button type="button" onClick={() => setCategoryFilter(null)} aria-pressed={!categoryFilter}
            className="shrink-0 h-7 px-2.5 rounded-full border border-border text-xs aria-pressed:bg-foreground aria-pressed:text-background">
            All · {notes.length}
          </button>
          {categories.map(([name, count]) => (
            <button key={name} type="button" onClick={() => setCategoryFilter(categoryFilter === name ? null : name)} aria-pressed={categoryFilter === name}
              className="shrink-0 h-7 px-2.5 rounded-full border border-border text-xs flex items-center gap-1.5 aria-pressed:bg-foreground aria-pressed:text-background"
              data-testid={`notes-category-${name}`}>
              <span className="h-2 w-2 rounded-full" style={dot(name)} /> {name} · {count}
            </button>
          ))}
        </div>
      )}
      {categoryFilter && hiddenByCategory > 0 && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground shrink-0" data-testid="notes-filter-notice">
          Showing {categoryFilter} only — {hiddenByCategory} other {hiddenByCategory === 1 ? "note is" : "notes are"} hidden.{" "}
          <button type="button" className="underline" onClick={() => setCategoryFilter(null)}>Show all</button>
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5" data-testid="notes-list">
        {notesQuery.isLoading ? (
          <p className="p-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</p>
        ) : notesQuery.isError && notes.length === 0 ? (
          <div className="p-3 text-xs" data-testid="notes-list-error">
            <p className="text-destructive">Couldn't load your notes.</p>
            <button type="button" className="underline mt-1" onClick={() => notesQuery.refetch()}>Retry</button>
          </div>
        ) : shown.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {search.trim() ? `No note matches "${search.trim()}"${categoryFilter ? ` in ${categoryFilter}` : ""}.`
              : categoryFilter ? `No notes in ${categoryFilter}.`
              : "No notes yet. Start typing to write the first."}
          </p>
        ) : shown.map((n) => {
          const cat = noteCategory(n.tags);
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => void openNote(n)}
              className={`w-full text-left rounded-xl px-3 py-2.5 border transition-colors ${n.id === noteId ? "border-primary bg-primary/10" : "border-border/60 bg-card hover:bg-muted/60"}`}
              data-testid={`note-row-${n.id}`}
            >
              <div className="text-sm font-semibold truncate">{n.title || "Untitled"}</div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">{snippet(n.content) || "Empty note"}</div>
              <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
                {cat && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={dot(cat)} />{cat}</span>}
                <span className="ml-auto">{ago(n.updatedAt || n.createdAt)}</span>
              </div>
            </button>
          );
        })}
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
        <aside className={`${listOpen ? "flex" : "hidden"} md:flex flex-col w-full md:w-80 border-r border-border bg-muted/30 min-h-0`}>{list}</aside>
        <div className={`${listOpen ? "hidden" : "flex"} md:flex flex-1 min-w-0 flex-col`}>
          {/* What the note IS: category, tags, who it is linked to. */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap shrink-0">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {category.trim() && <span className="h-2.5 w-2.5 rounded-full" style={dot(category.trim())} />}
              <input
                list="note-categories"
                value={category}
                onChange={(e) => { setCategory(e.target.value); touch(); }}
                placeholder="Category"
                aria-label="Category"
                className="h-8 w-36 rounded-full border border-border bg-background px-3 text-xs text-foreground outline-none"
                data-testid="input-note-category"
              />
              <datalist id="note-categories">{categories.map(([name]) => <option key={name} value={name} />)}</datalist>
            </label>
            <input
              value={tags}
              onChange={(e) => { setTags(e.target.value); touch(); }}
              placeholder="Tags, comma separated"
              aria-label="Tags"
              className="h-8 w-48 rounded-full border border-border bg-background px-3 text-xs outline-none"
              data-testid="input-note-tags"
            />
            {!noteId && profiles.length > 1 && (
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                aria-label="Link this note to a profile"
                title="Link this note to a profile"
                className="h-8 rounded-full border border-border bg-background px-2 text-xs"
                data-testid="select-note-profile"
              >
                <option value="">Not linked to a profile</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</option>)}
              </select>
            )}
            <div className="flex-1" />
            <button type="button" onClick={switchMode} className="h-8 px-3 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground"
              title={mode === "rich" ? "Edit the note as plain markdown text" : "Edit the note as formatted text"} data-testid="button-note-mode">
              {mode === "rich" ? "Markdown" : "Rich text"}
            </button>
          </div>
          {/* Formatting. */}
          <div className="flex items-center gap-0.5 px-3 py-1 border-b border-border bg-muted/30 flex-wrap shrink-0" data-testid="note-toolbar">
            {mode === "rich" ? (
              <>
                <button type="button" className={tool} aria-label="Bold" aria-pressed={on("bold")} onClick={() => editor?.chain().focus().toggleBold().run()} data-testid="button-note-bold"><Bold className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Italic" aria-pressed={on("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Strikethrough" aria-pressed={on("strike")} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough className="h-4 w-4" /></button>
                <span className="w-px h-5 bg-border mx-1" />
                <button type="button" className={tool} aria-label="Heading" aria-pressed={on("heading", { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Subheading" aria-pressed={on("heading", { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></button>
                <span className="w-px h-5 bg-border mx-1" />
                <button type="button" className={tool} aria-label="Checklist" aria-pressed={on("taskList")} onClick={() => editor?.chain().focus().toggleTaskList().run()} data-testid="button-note-checklist"><ListTodo className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Bulleted list" aria-pressed={on("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Numbered list" aria-pressed={on("orderedList")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Quote" aria-pressed={on("blockquote")} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Code" aria-pressed={on("codeBlock")} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}><Code className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Link" aria-pressed={on("link")} onClick={() => {
                  const url = window.prompt("Link address");
                  if (url === null) return;
                  if (!url.trim()) editor?.chain().focus().unsetLink().run();
                  else editor?.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
                }}><LinkIcon className="h-4 w-4" /></button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => insertPrefix("- [ ] ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted" data-testid="button-note-checklist"><ListTodo className="h-4 w-4" /> Checklist</button>
                <button type="button" onClick={() => insertPrefix("- ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted"><List className="h-4 w-4" /> List</button>
                <button type="button" onClick={() => insertPrefix("## ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted"><Heading2 className="h-4 w-4" /> Heading</button>
              </>
            )}
            <span className="w-px h-5 bg-border mx-1" />
            <button type="button" disabled={attaching} onClick={() => { const el = fileRef.current; if (el) { el.value = ""; el.click(); } }}
              className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted disabled:opacity-50" data-testid="button-note-attach">
              {attaching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />} Attach
            </button>
            <input ref={fileRef} type="file" accept={ATTACH_ACCEPT} className="hidden" onChange={(e) => void attach(e.target.files?.[0])} data-testid="input-note-attach" />
            <button type="button" onClick={() => void makeTask()} disabled={!content.trim() && !title.trim()} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted disabled:opacity-40" data-testid="button-note-to-task"><CheckSquare className="h-4 w-4" /> Make a task</button>
          </div>
          {/* The sheet. */}
          <div className="flex-1 min-h-0 overflow-y-auto bg-muted/20" onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDropFile(e)}>
            <div className="bubble max-w-3xl my-4 mx-3 md:mx-auto px-5 md:px-10 py-6 md:py-8 min-h-[60vh]" data-testid="note-sheet">
              {mode === "rich" ? (
                <div className="relative">
                  {!content.trim() && <p className="absolute top-0 left-0 text-muted-foreground/60 pointer-events-none">Start typing, paste, or drop a file here…</p>}
                  <EditorContent editor={editor} className="prose prose-sm max-w-none" />
                </div>
              ) : (
                <textarea
                  ref={textRef}
                  value={content}
                  onChange={(e) => { setContent(e.target.value); touch(); }}
                  placeholder="Start typing, paste, or drop a file here…"
                  aria-label="Note"
                  className="block w-full min-h-[55vh] bg-transparent text-sm leading-relaxed outline-none resize-none font-mono"
                  data-testid="input-note-content"
                />
              )}
              {attachments.length > 0 && (
                <div className="mt-6 pt-4 border-t border-border/60" data-testid="note-attachments">
                  <p className="micro-label text-muted-foreground mb-2">Attachments</p>
                  <div className="flex flex-wrap gap-2">
                    {attachments.map((a) => (
                      <button key={a.documentId} type="button" onClick={async () => { await saveNow(); hashNavigate(`/documents/${a.documentId}`); }}
                        className="h-9 px-3 rounded-full border border-border bg-background text-xs flex items-center gap-1.5 hover:bg-muted" title="Open in Documents"
                        data-testid={`note-attachment-${a.documentId}`}>
                        <FileText className="h-3.5 w-3.5" /> {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          {proposal !== null && (
            <div className="border-t border-border bg-card px-4 py-3 shrink-0 max-h-[40vh] overflow-y-auto" data-testid="note-ai-proposal">
              <p className="text-xs font-semibold flex items-center gap-1.5 mb-2"><Sparkles className="h-3.5 w-3.5 text-primary" /> AI suggestion — your note is unchanged until you choose</p>
              <div className="prose prose-sm max-w-none note-rich bg-muted/40 rounded-md p-3" dangerouslySetInnerHTML={{ __html: proposalHtml }} />
              <div className="flex gap-2 mt-2">
                <button type="button" className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold" onClick={() => { const p = proposal; setProposal(null); replaceContent(p); }} data-testid="button-note-ai-use">Use this</button>
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
