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
//
// Phone layout (owner, 2026-11-23): the shared header (X | title | Save), one
// formatting row that scrolls sideways (never off screen), then ONE scroll
// area — the compact options (category, tags, profile), the note growing with
// what is written, and its attachments as small thumbnails and file rows.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import DOMPurify from "dompurify";
import {
  Bold, CheckSquare, Code, Heading1, Heading2, Italic, Link as LinkIcon, List, ListOrdered, ListTodo, Loader2,
  Plus, Quote, Search, Sparkles, Strikethrough, Trash2, FileText, X,
  FolderOpen, History, Lightbulb, MessagesSquare, PenLine, Redo2, Star, StickyNote, Undo2,
} from "lucide-react";
import {
  AiConversation, DictateButton, DraftRecoveryBar, VersionHistory, WorkspaceTabs,
  readLastOpened, rememberLastOpened, useDraftRecovery, type WorkspaceTab,
} from "@/components/workspace/WorkspaceApp";
import {
  FavoriteButton, NotesBrowser, NotesCategories, NotesInsightsTab, categoryDot, noteAgo, noteSnippet, useRefreshNotes, type NoteRow,
} from "@/components/workspace/NotesTabs";
import { useDocumentBlobUrl } from "@/lib/document-preview";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import {
  AttachMenu, WorkspaceShell, WorkspaceAiBar, aiErrorText, leaveWorkspace, readFileAsDataUrl, useAutoGrow,
} from "@/components/workspace/WorkspaceShell";
import {
  attachmentLink, markdownToNoteHtml, noteAttachments, noteCategory, noteDocToMarkdown, noteLabels,
  noteNeedsPlainEditor, noteTagsFor, type NoteNode,
} from "@shared/note-markdown";

export { categoryHue } from "@/components/workspace/NotesTabs";
interface ProfileRow { id: string; name: string; type: string }

export const NOTE_AUTOSAVE_MS = 900;
export const NOTE_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_NAME = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

/** Take one attachment's link out of a note's markdown (the file stays in Documents). */
export function removeAttachmentLink(markdown: string, documentId: string): string {
  const id = documentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`\\[(?:[^\\]\\\\]|\\\\.)*\\]\\(#/documents/${id}\\)`, "g");
  return String(markdown || "")
    .replace(new RegExp(`\\n?[ \\t]*${link.source}[ \\t]*(?=\\n|$)`, "g"), "")
    .replace(link, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

/** A picture attached to a note: a small thumbnail that opens it. */
function AttachmentThumb({ id, name, onOpen, onRemove, armed }: { id: string; name: string; onOpen: () => void; onRemove: () => void; armed: boolean }) {
  const blob = useDocumentBlobUrl(id, "image/jpeg");
  return (
    <div className="relative h-16 w-16 rounded-lg overflow-hidden border border-border bg-muted shrink-0" data-testid={`note-attachment-${id}`}>
      <button type="button" className="h-full w-full flex items-center justify-center text-[11px] text-muted-foreground" onClick={onOpen} title={`Open ${name}`} aria-label={`Open ${name}`}>
        {blob.url ? <img src={blob.url} alt={name} className="h-full w-full object-cover" /> : blob.error ? "Couldn't load" : <Loader2 className="h-4 w-4 animate-spin" />}
      </button>
      <button type="button" onClick={onRemove} aria-label={armed ? "Tap again to remove this attachment" : "Remove attachment"}
        className={`absolute top-0.5 right-0.5 h-5 rounded-full text-[11px] px-1 flex items-center gap-0.5 ${armed ? "bg-destructive text-destructive-foreground" : "bg-background/85 text-foreground"}`}>
        <X className="h-3 w-3" />{armed ? "Remove?" : ""}
      </button>
    </div>
  );
}

/** A note with no typed title is named by its first line. */
export function noteTitleFromText(content: string): string {
  const first = String(content || "").split("\n")
    .map((l) => l.replace(/^[#>\-\s[\]x\d.]+/i, "").replace(/[*_`~\\]/g, "").trim()).find(Boolean) || "";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

const dot = categoryDot;
const snippet = (md: string) => noteSnippet(md);
const ago = noteAgo;

/** The Notes app's own navigation (owner request 2026-11-25). */
export type NotesTab = "all" | "editor" | "categories" | "assistant" | "insights" | "favorites";
const NOTES_TABS: WorkspaceTab<NotesTab>[] = [
  { id: "all", label: "All Notes", icon: StickyNote },
  { id: "editor", label: "Editor", icon: PenLine },
  { id: "categories", label: "Categories", icon: FolderOpen },
  { id: "assistant", label: "AI Assistant", icon: MessagesSquare },
  { id: "insights", label: "AI Insights", icon: Lightbulb },
  { id: "favorites", label: "Favorites", icon: Star },
];
const isNotesTab = (v: unknown): v is NotesTab => NOTES_TABS.some((t) => t.id === v);

type SaveState = "new" | "dirty" | "saving" | "saved" | "error";
const STATUS: Record<SaveState, string> = {
  new: "Not saved yet", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Couldn't save — will retry",
};

export default function NotesWorkspacePage() {
  useEffect(() => { document.title = "Notes — Portol"; }, []);
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  // The list beside the editor is its own query; the artifacts domain covers
  // every other screen that shows notes.
  const refreshNotes = useRefreshNotes();

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
  // Which of the app's tabs is showing. A deep link to one note opens the
  // Editor; otherwise the tab last used, else the Editor.
  const remembered = useMemo(() => readLastOpened("notes"), []);
  const [tab, setTabState] = useState<NotesTab>(() => {
    const q = new URLSearchParams(typeof window !== "undefined" ? (window.location.hash.split("?")[1] || "") : "");
    if (q.get("note")) return "editor";
    const asked = q.get("tab");
    return isNotesTab(asked) ? asked : isNotesTab(remembered.tab) ? remembered.tab : "editor";
  });
  const setTab = useCallback((next: NotesTab) => { setTabState(next); rememberLastOpened("notes", { tab: next }); }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const draft = useDraftRecovery("notes");
  const { keep: keepDraft, clear: clearDraft, dismiss: dismissDraft } = draft;
  const preferPlain = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(textRef, mode === "plain" ? content : "");
  const latestContent = useRef(content);
  latestContent.current = content;

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
        // On the server now: the copy kept on this device is no longer needed.
        if (!dirty.current) clearDraft();
        if (latest.current.noteId) rememberLastOpened("notes", { id: latest.current.noteId });
      } catch {
        dirty.current = true;
        setState("error");
      }
    });
    return chain.current;
  }, [refreshNotes, clearDraft]);

  const touch = useCallback(() => {
    dirty.current = true;
    setState("dirty");
    // Kept on this device until the save lands (draft recovery). Read on the
    // next tick: the state the caller just set is in `latest` by then.
    setTimeout(() => { const v = latest.current; keepDraft({ id: v.noteId, title: v.titleTyped ? v.title : "", text: v.content }); }, 0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, NOTE_AUTOSAVE_MS);
  }, [saveNow, keepDraft]);

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
    editorProps: { attributes: { class: "note-rich outline-none min-h-[45vh] text-base", "data-testid": "note-rich-editor", "aria-label": "Note" } },
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
    setHistoryOpen(false);
    rememberLastOpened("notes", { id: n?.id ?? null });
  };
  /** Open a note in the Editor tab (from a list, an insight, a category). */
  const openInEditor = (n: NoteRow | null) => { setTab("editor"); void openNote(n); };
  const openById = (id: string) => { const n = notes.find((x) => x.id === id); if (n) openInEditor(n); };

  // Opened for ONE note (Artifacts → a note → Edit): #/workspace/notes?note=<id>
  // opens that note for editing, and the X goes back to Artifacts. QA
  // 2026-11-24: a saved note opened from Artifacts was read-only, and the only
  // road to its editor was Chat → Notes. Opening still writes nothing (W3).
  const deepLink = useMemo(() => {
    const q = new URLSearchParams(typeof window !== "undefined" ? (window.location.hash.split("?")[1] || "") : "");
    return { noteId: q.get("note"), from: q.get("from") };
  }, []);
  // With no deep link, the note last open comes back (owner, 2026-11-25:
  // "automatic restoration of the last opened entry"). A note that is gone is
  // simply not found. Still a read: nothing is written by opening.
  const wantedId = deepLink.noteId || remembered.id || null;
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (!wantedId || openedDeepLink.current || !editor) return;
    if (!notesQuery.isSuccess) return;
    openedDeepLink.current = true;
    const n = notes.find((x) => x.id === wantedId);
    if (n) void openNote(n);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedId, notes, editor, notesQuery.isSuccess]);
  const leave = () => { if (deepLink.from === "artifacts") hashNavigate("/artifacts"); else leaveWorkspace(); };

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
    latestContent.current = md;
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
  const attach = async (picked: File[] | File | undefined | null) => {
    const list = (Array.isArray(picked) ? picked : picked ? [picked] : []);
    if (list.length === 0) return;
    setAttaching(true);
    try {
      const links: string[] = [];
      for (const file of list) {
        if (file.size > NOTE_ATTACH_MAX_BYTES) { toast({ title: `${file.name || "That file"} is too large`, description: "Attachments can be up to 10 MB.", variant: "destructive" }); continue; }
        try {
          const data = await readFileAsDataUrl(file);
          const r = await apiRequest("POST", "/api/upload/save-only", {
            fileName: file.name || "photo.jpg", mimeType: file.type || "application/octet-stream", fileData: data,
            ...(profileId ? { profileIds: [profileId] } : {}),
          });
          const j = await r.json();
          if (!j?.documentId) throw new Error("The file was not saved.");
          links.push(attachmentLink({ name: file.name || "photo.jpg", documentId: String(j.documentId) }));
        } catch (err) {
          toast({ title: `Couldn't attach ${file.name || "that file"}`, description: aiErrorText(err), variant: "destructive" });
        }
      }
      if (links.length) {
        void invalidateDomain("documents");
        const now = latestContent.current;
        replaceContent(now.trim() ? `${now.replace(/\s+$/, "")}\n\n${links.join("\n\n")}` : links.join("\n\n"));
      }
    } finally {
      setAttaching(false);
    }
  };
  // A kept draft that the server already has (the save landed as the tab
  // closed) is not an unsaved draft: it is dropped without asking.
  useEffect(() => {
    const d = draft.leftover;
    if (d && notesQuery.isSuccess && notes.some((n) => String(n.content || "").trim() === d.text.trim())) dismissDraft();
  }, [draft.leftover, notes, notesQuery.isSuccess, dismissDraft]);
  /** Put back writing that was kept on this device and never reached the server. */
  const restoreDraft = async () => {
    const d = draft.leftover;
    if (!d) return;
    draft.taken();
    setTab("editor");
    await openNote(d.id ? notes.find((n) => n.id === d.id) ?? null : null);
    if (d.title) { setTitle(d.title); setTitleTyped(true); }
    replaceContent(d.text);
  };
  /** The server restored an older version of the open note: show it, already saved. */
  const showRestored = (row: any) => {
    const md = String(row?.content ?? "");
    const plain = preferPlain.current || noteNeedsPlainEditor(md);
    dirty.current = false;
    latestContent.current = md;
    setContent(md);
    setMode(plain ? "plain" : "rich");
    if (!plain) loadIntoEditor(md);
    setState("saved");
    setHistoryOpen(false);
    refreshNotes();
  };
  const openRow = noteId ? notes.find((n) => n.id === noteId) : undefined;
  const listState = { loading: notesQuery.isLoading, failed: notesQuery.isError, retry: () => void notesQuery.refetch() };
  const askAssistant = async (turns: Array<{ role: "user" | "assistant"; content: string }>) => {
    const r = await apiRequest("POST", "/api/workspace/notes/chat", {
      messages: turns, openNote: { id: noteId, title: titleTyped ? title : "", content: latestContent.current },
    });
    const j = await r.json();
    if (typeof j?.answer !== "string" || !j.answer.trim()) throw new Error("The AI returned nothing.");
    const read = Number(j.notesRead) || 0;
    return { answer: j.answer, remembered: Array.isArray(j.remembered) ? j.remembered.map(String) : [], note: `Read ${read} of ${Math.max(read, Number(j.notesTotal) || 0)} notes${j.usedPortol ? ", and your Portol records" : ""}.` };
  };

  const detach = (documentId: string) => replaceContent(removeAttachmentLink(latestContent.current, documentId));

  const onDropFile = async (e: React.DragEvent) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (file.type.startsWith("text/") || /\.(md|csv)$/i.test(file.name)) appendMarkdown(await file.text());
    else await attach(Array.from(e.dataTransfer.files));
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

  const tool = "h-8 w-8 shrink-0 rounded-md flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40 aria-pressed:bg-primary/15 aria-pressed:text-primary";
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

  const pending = () => dirty.current && !!latestContent.current.trim();
  const optionInput = "ws-field h-7 rounded-full border border-border bg-background px-2.5 text-xs text-foreground outline-none min-w-0";

  return (
    <WorkspaceShell
      kind="notes"
      status={STATUS[state]}
      unsaved={state === "dirty" || state === "error" || state === "saving"}
      onClose={async () => { await saveNow(); if (pending()) return false; leave(); }}
      save={{
        state: state === "new" ? "empty" : state,
        disabled: !content.trim(),
        onSave: async () => { await saveNow(); return !pending(); },
      }}
      title={
        <input
          value={titleTyped ? title : (title || noteTitleFromText(content))}
          onChange={(e) => { setTitle(e.target.value); setTitleTyped(true); touch(); }}
          placeholder="Untitled note"
          aria-label="Note title"
          className="ws-title w-full bg-transparent text-sm font-semibold outline-none truncate"
          data-testid="input-note-title"
        />
      }
      actions={tab === "editor" ? (
        <button type="button" onClick={() => setListOpen((v) => !v)} className="md:hidden h-8 px-2.5 rounded-full border border-border text-xs shrink-0" data-testid="button-notes-list">
          {listOpen ? "Editor" : `Notes (${notes.length})`}
        </button>
      ) : undefined}
      tabs={<WorkspaceTabs label="Notes sections" tabs={NOTES_TABS.map((t) => (t.id === "all" ? { ...t, badge: notes.length || null } : t.id === "favorites" ? { ...t, badge: notes.filter((n) => n.pinned).length || null } : t))} active={tab} onPick={setTab} />}
      banner={draft.leftover ? <DraftRecoveryBar draft={draft.leftover} onRestore={() => void restoreDraft()} onDiscard={draft.dismiss} /> : undefined}
    >
      {(tab === "all" || tab === "favorites") && (
        <NotesBrowser
          notes={notes} list={listState} favoritesOnly={tab === "favorites"} openId={noteId}
          categoryFilter={categoryFilter} onCategoryFilter={setCategoryFilter}
          onOpen={openInEditor}
          onDeleted={(id) => { if (id === noteId) { dirty.current = false; void openNote(null); } }}
        />
      )}
      {tab === "categories" && (
        <NotesCategories notes={notes} list={listState} onOpen={openInEditor}
          onBrowse={(name) => { setCategoryFilter(name); setTab("all"); }} />
      )}
      {tab === "assistant" && (
        <AiConversation
          app="notes" testId="notes-assistant" ask={askAssistant} memoryApp="notes"
          intro="Ask about anything you have written. The assistant reads your notes, names the note an answer comes from, and can summarise, connect ideas or brainstorm with you."
          suggestions={["What have I been writing about most?", "Summarize my notes from this month", "Which notes mention a plan I haven't finished?", "Brainstorm next steps from the note I have open"]}
          placeholder="Ask about your notes…"
        />
      )}
      {tab === "insights" && <NotesInsightsTab notes={notes} list={listState} onOpen={openById} />}
      {/* The Editor stays mounted behind the other tabs: what is being written is never dropped by looking elsewhere. */}
      <div className={tab === "editor" ? "flex-1 min-h-0 min-w-0 flex" : "hidden"} data-testid="notes-editor-tab">
        <aside className={`${listOpen ? "flex" : "hidden"} md:flex flex-col w-full md:w-72 border-r border-border bg-muted/30 min-h-0`}>{list}</aside>
        <div className={`${listOpen ? "hidden" : "flex"} md:flex flex-1 min-w-0 flex-col`}>
          {/* Formatting: one row that scrolls sideways on a phone, so nothing falls off screen. */}
          <div className="flex items-center gap-0.5 px-1.5 py-0.5 border-b border-border bg-muted/30 overflow-x-auto overflow-y-hidden shrink-0 [scrollbar-width:none]" data-swipe-ignore data-testid="note-toolbar">
            {mode === "rich" ? (
              <>
                <button type="button" className={tool} aria-label="Undo" title="Undo" disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()} data-testid="button-note-undo"><Undo2 className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Redo" disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()} data-testid="button-note-redo"><Redo2 className="h-4 w-4" /></button>
                <span className="w-px h-5 bg-border mx-0.5 shrink-0" />
                <button type="button" className={tool} aria-label="Bold" aria-pressed={on("bold")} onClick={() => editor?.chain().focus().toggleBold().run()} data-testid="button-note-bold"><Bold className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Italic" aria-pressed={on("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Strikethrough" aria-pressed={on("strike")} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough className="h-4 w-4" /></button>
                <span className="w-px h-5 bg-border mx-0.5 shrink-0" />
                <button type="button" className={tool} aria-label="Heading" aria-pressed={on("heading", { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="h-4 w-4" /></button>
                <button type="button" className={tool} aria-label="Subheading" aria-pressed={on("heading", { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></button>
                <span className="w-px h-5 bg-border mx-0.5 shrink-0" />
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
                <button type="button" onClick={() => insertPrefix("- [ ] ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted shrink-0" data-testid="button-note-checklist"><ListTodo className="h-4 w-4" /> Checklist</button>
                <button type="button" onClick={() => insertPrefix("- ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted shrink-0"><List className="h-4 w-4" /> List</button>
                <button type="button" onClick={() => insertPrefix("## ")} className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted shrink-0"><Heading2 className="h-4 w-4" /> Heading</button>
              </>
            )}
            <span className="w-px h-5 bg-border mx-0.5 shrink-0" />
            <button type="button" onClick={() => void makeTask()} disabled={!content.trim() && !title.trim()} title="Make a task from this note"
              className="h-8 px-2 rounded-md text-xs flex items-center gap-1 hover:bg-muted disabled:opacity-40 shrink-0 whitespace-nowrap" data-testid="button-note-to-task"><CheckSquare className="h-4 w-4" /> Task</button>
            <button type="button" onClick={switchMode} className="h-8 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 whitespace-nowrap"
              title={mode === "rich" ? "Edit the note as plain markdown text" : "Edit the note as formatted text"} data-testid="button-note-mode">
              {mode === "rich" ? "Markdown" : "Rich text"}
            </button>
          </div>
          {/* One scroll area: options, the note (it grows with what is written), attachments. */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain" data-workspace-scroll onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDropFile(e)}>
            <div className="max-w-3xl mx-auto px-3 sm:px-6 pt-2 pb-6 min-h-full flex flex-col" data-testid="note-sheet">
              {/* What the note IS: category, tags, who it is linked to — one compact line. */}
              <div className="flex items-center gap-1.5 flex-wrap" data-testid="note-options">
                <label className="flex items-center gap-1 min-w-0">
                  {category.trim() && <span className="h-2 w-2 rounded-full shrink-0" style={dot(category.trim())} />}
                  <input
                    list="note-categories"
                    value={category}
                    onChange={(e) => { setCategory(e.target.value); touch(); }}
                    placeholder="Category"
                    aria-label="Category"
                    className={`${optionInput} w-24`}
                    data-testid="input-note-category"
                  />
                  <datalist id="note-categories">{categories.map(([name]) => <option key={name} value={name} />)}</datalist>
                </label>
                <input
                  value={tags}
                  onChange={(e) => { setTags(e.target.value); touch(); }}
                  placeholder="Tags"
                  aria-label="Tags, comma separated"
                  title="Tags, comma separated"
                  className={`${optionInput} flex-1 basis-24`}
                  data-testid="input-note-tags"
                />
                {!noteId && profiles.length > 1 && (
                  <select
                    value={profileId}
                    onChange={(e) => setProfileId(e.target.value)}
                    aria-label="Link this note to a profile"
                    title="Link this note to a profile"
                    className={`${optionInput} max-w-[9rem] px-2`}
                    data-testid="select-note-profile"
                  >
                    <option value="">No profile</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</option>)}
                  </select>
                )}
                <AttachMenu onFiles={(f) => void attach(f)} busy={attaching} testId="note-attach" />
                <DictateButton testId="button-note-dictate" onText={(spoken) => {
                  if (mode === "rich" && editor) editor.chain().focus().insertContent(`${spoken} `).run();
                  else replaceContent(latestContent.current.trim() ? `${latestContent.current.replace(/\s+$/, "")} ${spoken}` : spoken);
                }} />
                {noteId && openRow && <FavoriteButton note={openRow} className="h-7 w-7" />}
                {noteId && (
                  <button type="button" onClick={async () => { await saveNow(); setHistoryOpen((v) => !v); }} aria-pressed={historyOpen} title="Earlier versions of this note"
                    className="h-7 px-2 rounded-full border border-border text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground aria-pressed:bg-muted shrink-0" data-testid="button-note-history">
                    <History className="h-3.5 w-3.5" /> History
                  </button>
                )}
                {noteId && (
                  <button
                    type="button"
                    onClick={() => confirm("delete", () => void removeNote())}
                    aria-label={isArmed("delete") ? "Tap again to delete this note" : "Delete this note"}
                    className={`h-7 px-2 rounded-full text-xs flex items-center gap-1 shrink-0 ${isArmed("delete") ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    data-testid="button-note-delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {isArmed("delete") ? "Tap again" : ""}
                  </button>
                )}
              </div>
              {historyOpen && noteId && (
                <div className="mt-2 bubble p-3" data-testid="note-history">
                  <VersionHistory kind="note" id={noteId} onRestored={showRestored}
                    renderPreview={(v) => <div className="prose prose-sm max-w-none note-rich" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdownToNoteHtml(v.content)) }} />} />
                </div>
              )}
              <div className="mt-2 flex-1 flex flex-col min-h-[50vh]">
                {mode === "rich" ? (
                  <div className="relative flex-1 flex flex-col">
                    {!content.trim() && <p className="absolute top-0 left-0 text-base text-muted-foreground/60 pointer-events-none">Start typing, paste, or drop a file here…</p>}
                    <EditorContent editor={editor} className="workspace-writing prose prose-sm max-w-none flex-1 flex flex-col [&>.ProseMirror]:flex-1" />
                  </div>
                ) : (
                  <textarea
                    ref={textRef}
                    value={content}
                    onChange={(e) => { setContent(e.target.value); touch(); }}
                    placeholder="Start typing, paste, or drop a file here…"
                    aria-label="Note"
                    rows={10}
                    className="workspace-writing block w-full flex-[1_0_auto] min-h-[50vh] bg-transparent text-base leading-relaxed outline-none resize-none overflow-hidden font-mono"
                    data-testid="input-note-content"
                  />
                )}
              </div>
              {attachments.length > 0 && (
                <div className="mt-3 pt-2 border-t border-border/60 space-y-1.5" data-testid="note-attachments">
                  {attachments.some((a) => IMAGE_NAME.test(a.name)) && (
                    <div className="flex gap-1.5 flex-wrap">
                      {attachments.filter((a) => IMAGE_NAME.test(a.name)).map((a) => (
                        <AttachmentThumb key={a.documentId} id={a.documentId} name={a.name} armed={isArmed(`att:${a.documentId}`)}
                          onOpen={async () => { await saveNow(); hashNavigate(`/documents/${a.documentId}`); }}
                          onRemove={() => confirm(`att:${a.documentId}`, () => detach(a.documentId))} />
                      ))}
                    </div>
                  )}
                  {attachments.filter((a) => !IMAGE_NAME.test(a.name)).map((a) => (
                    <div key={a.documentId} className="flex items-center gap-2 h-9 pl-2 pr-1 rounded-lg border border-border bg-muted/30 min-w-0" data-testid={`note-attachment-${a.documentId}`}>
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <button type="button" onClick={async () => { await saveNow(); hashNavigate(`/documents/${a.documentId}`); }}
                        className="flex-1 min-w-0 text-left text-xs truncate hover:underline" title="Open in Documents">{a.name}</button>
                      <button type="button" onClick={() => confirm(`att:${a.documentId}`, () => detach(a.documentId))}
                        aria-label={isArmed(`att:${a.documentId}`) ? "Tap again to remove this attachment" : "Remove attachment"}
                        className={`h-7 rounded-full text-[11px] px-2 flex items-center gap-0.5 shrink-0 ${isArmed(`att:${a.documentId}`) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                        <X className="h-3 w-3" />{isArmed(`att:${a.documentId}`) ? "Remove?" : ""}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {proposal !== null && (
            <div className="border-t border-border bg-card px-3 py-2 shrink-0 max-h-[40%] overflow-y-auto overscroll-contain" data-testid="note-ai-proposal">
              <p className="text-[11px] font-semibold flex items-center gap-1.5 mb-1.5"><Sparkles className="h-3.5 w-3.5 text-primary" /> AI suggestion — your note is unchanged until you choose</p>
              <div className="prose prose-sm max-w-none note-rich bg-muted/40 rounded-md p-2.5" dangerouslySetInnerHTML={{ __html: proposalHtml }} />
              <div className="flex gap-2 mt-1.5">
                <button type="button" className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold" onClick={() => { const p = proposal; setProposal(null); replaceContent(p); }} data-testid="button-note-ai-use">Use this</button>
                <button type="button" className="h-8 px-3 rounded-full border border-border text-xs" onClick={() => setProposal(null)} data-testid="button-note-ai-discard">Discard</button>
              </div>
            </div>
          )}
          <WorkspaceAiBar
            placeholder="Ask AI to organize or tidy this note…"
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
