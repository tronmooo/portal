// Journal workspace (owner request 2026-11-22/23): a quiet page to write on.
// Past days run down the left as a timeline, each with its mood; the middle
// is today's page — the date, how you feel, a prompt if you want one, the
// writing, and photos. The AI at the bottom reads the journal (a summary of
// today or the week, themes, mood) and never rewrites what was written.
//
// It writes through the same journal API as the Journal page and chat:
//  - A new entry is a DRAFT create, then updates to that same entry (J1).
//  - A mood is sent as picked only when it was picked; otherwise it is
//    detected from the text (J2).
//  - Leaving or finishing titles an untitled entry from its text (J8).
//  - Opening writes nothing (Rule 3); a failed list is an error with a retry
//    (Rule 7); delete takes two taps (Rule 8); the X saves, then leaves (W2).
//
// Phone layout (owner, 2026-11-23): the shared header (X | day | Save), then
// ONE scroll area — a compact options line (whose journal, date, new, attach,
// delete), single-line mood chips, the title, and a writing area that grows
// with the entry (no height or length limit) — then the attachments as small
// thumbnails and file rows.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2, Plus, Trash2, X } from "lucide-react";
import type { JournalEntry, MoodLevel } from "@shared/schema";
import { detectMoodFromText } from "@shared/mood-detect";
import { getUserToday } from "@shared/timezone";
import { JOURNAL_MAX_FILES, JOURNAL_MAX_PHOTOS, journalFileIds, journalLabels, journalPhotoIds, journalTagsFor } from "@shared/journal-photos";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { parseLocalDate } from "@/lib/format";
import { useDocumentBlobUrl } from "@/lib/document-preview";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useProfileScope } from "@/hooks/useProfileScope";
import { scopeLabel, setFilterEveryone } from "@/lib/profileFilter";
import { MOOD_CONFIG } from "@/pages/journal";
import {
  AttachMenu, WorkspaceShell, WorkspaceAiBar, aiErrorText, leaveWorkspace, readFileAsDataUrl, useAutoGrow,
} from "@/components/workspace/WorkspaceShell";
import { hashNavigate } from "@/lib/hashNavigate";

/** Guided prompts. Fixed, never generated. */
export const JOURNAL_PROMPTS = [
  "What went well today?",
  "What is on my mind right now?",
  "What am I grateful for?",
  "What was hard today, and what did I learn from it?",
  "What do I want tomorrow to look like?",
];
export const JOURNAL_AUTOSAVE_MS = 1500;
const ACCENT = "262 70% 62%"; // the Journal's colour everywhere in the app
export const JOURNAL_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const MOODS = Object.keys(MOOD_CONFIG) as MoodLevel[];

interface ProfileRow { id: string; name: string; type: string }
type SaveState = "empty" | "dirty" | "saving" | "saved" | "error";
const STATUS: Record<SaveState, string> = {
  empty: "Nothing written yet", dirty: "Saving as you write", saving: "Saving…", saved: "Saved", error: "Couldn't save — will retry",
};

const shortDay = (day: string) => (parseLocalDate(day) ?? new Date()).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const longDay = (day: string) => (parseLocalDate(day) ?? new Date()).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const monthOf = (day: string) => (parseLocalDate(day) ?? new Date()).toLocaleDateString(undefined, { month: "long", year: "numeric" });

function Photo({ id, onRemove, armed }: { id: string; onRemove?: () => void; armed?: boolean }) {
  const blob = useDocumentBlobUrl(id, "image/jpeg");
  return (
    <div className="relative h-16 w-16 rounded-lg overflow-hidden border border-border bg-muted shrink-0" data-testid={`journal-photo-${id}`}>
      {blob.url ? (
        <button type="button" className="h-full w-full" onClick={() => hashNavigate(`/documents/${id}`)} aria-label="Open this photo" title="Open in Documents">
          <img src={blob.url} alt="Journal photo" className="h-full w-full object-cover" />
        </button>
      )
        : <div className="h-full w-full flex items-center justify-center text-[11px] text-muted-foreground">{blob.error ? "Couldn't load" : <Loader2 className="h-4 w-4 animate-spin" />}</div>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={armed ? "Tap again to remove this photo" : "Remove photo"}
          className={`absolute top-0.5 right-0.5 h-5 rounded-full text-[11px] px-1 flex items-center gap-0.5 ${armed ? "bg-destructive text-destructive-foreground" : "bg-background/85 text-foreground"}`}>
          <X className="h-3 w-3" />{armed ? "Remove?" : ""}
        </button>
      )}
    </div>
  );
}

/** A non-photo attachment: one compact row that opens it, with a two-tap remove. */
function FileRow({ id, onOpen, onRemove, armed }: { id: string; onOpen: () => void; onRemove: () => void; armed: boolean }) {
  const doc = useQuery<{ id: string; title?: string; name?: string; fileName?: string }>({ queryKey: [`/api/documents/${id}`] });
  const name = doc.data?.title || doc.data?.name || doc.data?.fileName || (doc.isError ? "Couldn't load this file" : "Attached file");
  return (
    <div className="flex items-center gap-2 h-9 pl-2 pr-1 rounded-lg border border-border bg-muted/30 min-w-0" data-testid={`journal-file-${id}`}>
      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 text-left text-xs truncate hover:underline" title="Open in Documents">{name}</button>
      <button type="button" onClick={onRemove} aria-label={armed ? "Tap again to remove this file" : "Remove file"}
        className={`h-7 rounded-full text-[11px] px-2 flex items-center gap-0.5 shrink-0 ${armed ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-muted"}`}>
        <X className="h-3 w-3" />{armed ? "Remove?" : ""}
      </button>
    </div>
  );
}

export default function JournalWorkspacePage() {
  useEffect(() => { document.title = "Journal — Portol"; }, []);
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const today = getUserToday(BROWSER_TIMEZONE);

  // The timeline follows the app-wide profile scope, like the Journal page:
  // same key, same ?profileIds=. A scope hides other people's entries, so the
  // rail names it and offers the way out (Rule 4).
  const scope = useProfileScope();
  const profileParam = scope.selectedIds.length > 0 ? `?profileIds=${scope.selectedIds.join(",")}` : "";
  const entriesQuery = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal", scope.mode, ...scope.selectedIds],
    queryFn: () => apiRequest("GET", `/api/journal${profileParam}`).then((r) => r.json()),
  });
  const profilesQuery = useQuery<ProfileRow[]>({ queryKey: ["/api/profiles"] });
  const entries = Array.isArray(entriesQuery.data) ? entriesQuery.data : [];
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : [];
  const selfId = profiles.find((p) => p.type === "self")?.id;
  const writers = profiles.filter((p) => ["self", "person", "pet"].includes(p.type));

  const [entryId, setEntryId] = useState<string | null>(null);
  const [entryDate, setEntryDate] = useState(today);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [mood, setMood] = useState<MoodLevel | null>(null); // null = not picked: detected from the text
  const [labels, setLabels] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [forProfileId, setForProfileId] = useState("");
  const [state, setState] = useState<SaveState>("empty");
  const [railOpen, setRailOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reflection, setReflection] = useState<{ answer: string; entriesRead: number } | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(textRef, text);

  const latest = useRef({ entryId, entryDate, title, text, mood, labels, photos, files, forProfileId });
  latest.current = { entryId, entryDate, title, text, mood, labels, photos, files, forProfileId };
  const dirty = useRef(false);
  const titled = useRef(false); // the open entry already has a title on the server
  const touched = useRef(false); // something was written to the open entry in this sitting
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Save what is on the page. `finish` also titles an untitled entry. */
  const saveNow = useCallback((finish = false): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    chain.current = chain.current.then(async () => {
      const v = latest.current;
      if (!v.text.trim()) return; // an entry is its words
      // Only an entry written in this sitting is titled on the way out:
      // opening an old untitled entry and leaving writes nothing (Rule 3).
      const owesTitle = finish && touched.current && !v.title.trim() && !titled.current;
      if (!dirty.current && !owesTitle) return;
      dirty.current = false;
      setState("saving");
      const tags = journalTagsFor(v.labels.split(","), v.photos, v.files);
      const titlePatch = v.title.trim() ? { title: v.title.trim() } : owesTitle ? { autoTitle: true } : {};
      try {
        let id = v.entryId;
        if (!id) {
          const r = await apiRequest("POST", "/api/journal", {
            content: v.text, ...(v.mood ? { mood: v.mood } : {}), tags, entryDate: v.entryDate, draft: true,
            ...(v.title.trim() ? { title: v.title.trim() } : {}),
            ...(v.forProfileId ? { linkedProfiles: [v.forProfileId] } : {}),
          });
          const row = await r.json();
          if (!row?.id) throw new Error("The entry was not saved.");
          id = String(row.id);
          setEntryId(id);
          latest.current = { ...latest.current, entryId: id };
          if (owesTitle) await apiRequest("PATCH", `/api/journal/${id}`, { autoTitle: true });
        } else {
          await apiRequest("PATCH", `/api/journal/${id}`, { content: v.text, tags, mood: v.mood || detectMoodFromText(v.text), ...titlePatch });
        }
        if (v.title.trim() || owesTitle) titled.current = true;
        void invalidateDomain("journal");
        setState(dirty.current ? "dirty" : "saved");
      } catch {
        dirty.current = true;
        setState("error");
      }
    });
    return chain.current;
  }, []);

  /** Something written is still not on the server (a failed save, or not written yet). */
  const pending = () => dirty.current && !!latest.current.text.trim();

  const touch = useCallback(() => {
    dirty.current = true;
    touched.current = true;
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, JOURNAL_AUTOSAVE_MS);
  }, [saveNow]);

  useEffect(() => () => { if (dirty.current) void saveNow(true); }, [saveNow]);

  const open = async (e: JournalEntry | null) => {
    await saveNow(true);
    setEntryId(e?.id ?? null);
    setEntryDate(e ? String(e.date).slice(0, 10) : today);
    setTitle(e?.title || "");
    setText(e?.content || "");
    setMood(e ? e.mood : null);
    setLabels(journalLabels(e?.tags).join(", "));
    setPhotos(journalPhotoIds(e?.tags));
    setFiles(journalFileIds(e?.tags));
    setForProfileId("");
    titled.current = !!e?.title;
    touched.current = false;
    dirty.current = false;
    setState(e ? "saved" : "empty");
    setReflection(null);
    setRailOpen(false);
    if (!e) textRef.current?.focus();
  };

  const remove = async () => {
    if (!entryId) return;
    try {
      dirty.current = false;
      await apiRequest("DELETE", `/api/journal/${entryId}`);
      void invalidateDomain("journal");
      toast({ title: "Entry deleted" });
      setEntryId(null); latest.current = { ...latest.current, entryId: null, text: "" };
      setText(""); setTitle(""); setMood(null); setLabels(""); setPhotos([]); setFiles([]); setEntryDate(today); titled.current = false; setState("empty");
    } catch (err) {
      toast({ title: "Couldn't delete the entry", description: aiErrorText(err), variant: "destructive" });
    }
  };

  /** Photos and files: each is saved to Documents, and the entry points at it. */
  const addFiles = async (picked: File[]) => {
    if (!text.trim()) { toast({ title: "Write something first", description: "An attachment belongs to an entry." }); return; }
    setAdding(true);
    try {
      for (const file of picked) {
        const isPhoto = file.type.startsWith("image/");
        const have = isPhoto ? latest.current.photos.length : latest.current.files.length;
        const max = isPhoto ? JOURNAL_MAX_PHOTOS : JOURNAL_MAX_FILES;
        if (have >= max) { toast({ title: `An entry holds up to ${max} ${isPhoto ? "photos" : "files"}`, variant: "destructive" }); continue; }
        if (file.size > JOURNAL_ATTACH_MAX_BYTES) { toast({ title: `${file.name || "That file"} is too large`, description: "Attachments can be up to 10 MB.", variant: "destructive" }); continue; }
        try {
          const data = await readFileAsDataUrl(file);
          const r = await apiRequest("POST", "/api/upload/save-only", {
            fileName: file.name || `journal-${entryDate}${isPhoto ? ".jpg" : ""}`, mimeType: file.type || "application/octet-stream", fileData: data,
          });
          const j = await r.json();
          if (!j?.documentId) throw new Error("The file was not saved.");
          const id = String(j.documentId);
          if (isPhoto) {
            const next = [...new Set([...latest.current.photos, id])];
            latest.current = { ...latest.current, photos: next };
            setPhotos(next);
          } else {
            const next = [...new Set([...latest.current.files, id])];
            latest.current = { ...latest.current, files: next };
            setFiles(next);
          }
          touch();
        } catch (err) {
          toast({ title: `Couldn't attach ${file.name || "that file"}`, description: aiErrorText(err), variant: "destructive" });
        }
      }
      void invalidateDomain("documents");
    } finally {
      setAdding(false);
    }
  };

  const ask = async (instruction: string) => {
    setReflecting(true);
    try {
      const r = await apiRequest("POST", "/api/workspace/journal/reflect", { instruction, draft: text });
      const j = await r.json();
      if (typeof j?.answer !== "string" || !j.answer.trim()) throw new Error("The AI returned nothing.");
      setReflection({ answer: j.answer, entriesRead: Number(j.entriesRead) || 0 });
    } catch (err) {
      toast({ title: "AI couldn't answer that", description: aiErrorText(err), variant: "destructive" });
    } finally {
      setReflecting(false);
    }
  };

  const sorted = useMemo(() => [...entries].sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt))), [entries]);
  const months = useMemo(() => {
    const out: Array<{ month: string; rows: JournalEntry[] }> = [];
    for (const e of sorted) {
      const m = monthOf(String(e.date).slice(0, 10));
      if (out[out.length - 1]?.month === m) out[out.length - 1].rows.push(e); else out.push({ month: m, rows: [e] });
    }
    return out;
  }, [sorted]);
  // The last seven days, oldest first: the mood of the latest entry of each.
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = parseLocalDate(today) ?? new Date();
    d.setDate(d.getDate() - (6 - i));
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { day, entry: sorted.find((e) => String(e.date).slice(0, 10) === day) || null, label: d.toLocaleDateString(undefined, { weekday: "narrow" }) };
  }), [sorted, today]);
  const ownerOf = (e: JournalEntry): string | null => {
    const linked = e.linkedProfiles || [];
    if (linked.length === 0 || (selfId && linked.includes(selfId))) return null;
    return profiles.find((p) => linked.includes(p.id))?.name ?? null;
  };

  const detected = text.trim() ? detectMoodFromText(text) : null;
  const shownMood = mood || detected;
  const accent = { "--accent-hsl": ACCENT } as React.CSSProperties;
  const chip = "ws-field h-7 rounded-full border border-border bg-background px-2.5 text-xs";

  const rail = (
    <div className="flex flex-col h-full min-h-0" style={accent}>
      <div className="p-3 shrink-0">
        <button type="button" onClick={() => void open(null)} className="w-full h-9 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 text-white"
          style={{ background: `hsl(${ACCENT})` }} data-testid="button-journal-new">
          <Plus className="h-4 w-4" /> New entry
        </button>
        <div className="mt-2.5 px-1" data-testid="journal-week">
          <p className="micro-label text-muted-foreground mb-1.5">This week</p>
          <div className="flex justify-between">
            {week.map((d) => {
              const cfg = d.entry ? MOOD_CONFIG[d.entry.mood] || MOOD_CONFIG.neutral : null;
              const Icon = cfg?.icon;
              return (
                <button key={d.day} type="button" disabled={!d.entry} onClick={() => d.entry && void open(d.entry)} title={d.entry ? `${longDay(d.day)} · ${cfg!.label}` : `${longDay(d.day)} · nothing written`}
                  className="flex flex-col items-center gap-0.5 disabled:opacity-60">
                  <span className={`h-7 w-7 rounded-full flex items-center justify-center ${cfg ? cfg.bg : "bg-muted"}`}>
                    {Icon ? <Icon className="h-3.5 w-3.5" style={{ color: cfg!.color }} /> : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />}
                  </span>
                  <span className={`text-[11px] ${d.day === today ? "font-bold text-foreground" : "text-muted-foreground"}`}>{d.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {scope.isFiltered && (
        <p className="px-4 pb-2 text-[11px] text-muted-foreground shrink-0" data-testid="journal-scope-notice">
          Showing {scopeLabel(scope.selectedNames, scope.mode, scope.selectedIds.length)} only — other people's entries are hidden.{" "}
          <button type="button" className="underline" title="Changes the profile filter for the whole app" onClick={() => setFilterEveryone()}>
            Show everyone
          </button>
        </p>
      )}
      <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3" data-testid="journal-timeline">
        {entriesQuery.isLoading ? (
          <p className="p-2 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your journal…</p>
        ) : entriesQuery.isError && entries.length === 0 ? (
          <div className="p-2 text-xs" data-testid="journal-timeline-error">
            <p className="text-destructive">Couldn't load your journal.</p>
            <button type="button" className="underline mt-1" onClick={() => entriesQuery.refetch()}>Retry</button>
          </div>
        ) : months.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {scope.isFiltered ? `No entries for ${scopeLabel(scope.selectedNames, scope.mode, scope.selectedIds.length)}.` : "Your entries will line up here, day by day."}
          </p>
        ) : months.map((m) => (
          <div key={m.month} className="mb-2.5">
            <p className="micro-label text-muted-foreground px-1 mb-1">{m.month}</p>
            <div className="relative pl-4 border-l border-border/70 ml-2 space-y-0.5">
              {m.rows.map((e) => {
                const cfg = MOOD_CONFIG[e.mood] || MOOD_CONFIG.neutral;
                const d = parseLocalDate(String(e.date).slice(0, 10)) ?? new Date();
                const who = ownerOf(e);
                const nPhotos = journalPhotoIds(e.tags).length;
                return (
                  <button key={e.id} type="button" onClick={() => void open(e)}
                    className={`relative w-full text-left rounded-lg px-2.5 py-1.5 border transition-colors ${e.id === entryId ? "bg-[hsl(var(--accent-hsl)/0.12)] border-[hsl(var(--accent-hsl)/0.6)]" : "border-transparent hover:bg-muted/60"}`}
                    data-testid={`journal-row-${e.id}`}>
                    <span className="absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full ring-2 ring-background" style={{ background: cfg.color }} />
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px] font-bold tabular-nums">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span>
                      <span className="text-[11px]" style={{ color: cfg.color }}>{cfg.label}</span>
                      {nPhotos > 0 && <span className="text-[11px] text-muted-foreground ml-auto">{nPhotos} {nPhotos === 1 ? "photo" : "photos"}</span>}
                    </div>
                    <div className="text-sm font-medium truncate">{e.title || String(e.content || "").split("\n")[0].slice(0, 60) || "Untitled"}</div>
                    {who && <div className="text-[11px] text-muted-foreground">{who}'s journal</div>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <WorkspaceShell
      kind="journal"
      status={STATUS[state]}
      unsaved={state === "dirty" || state === "error" || state === "saving"}
      title={<span className="text-sm font-semibold truncate block" title={longDay(entryDate)}>{shortDay(entryDate)}</span>}
      actions={
        <button type="button" onClick={() => setRailOpen((v) => !v)} className="md:hidden h-8 px-2.5 rounded-full border border-border text-xs shrink-0" data-testid="button-journal-rail">
          {railOpen ? "Write" : `Entries (${entries.length})`}
        </button>
      }
      save={{
        state: state === "empty" ? "empty" : state,
        disabled: !text.trim(),
        onSave: async () => { await saveNow(true); return !pending(); },
      }}
      onClose={async () => { await saveNow(true); if (pending()) return false; leaveWorkspace(); }}
    >
      <div className="flex-1 min-h-0 min-w-0 flex" style={accent}>
        <aside className={`${railOpen ? "flex" : "hidden"} md:flex flex-col w-full md:w-72 border-r border-border bg-muted/30 min-h-0`}>{rail}</aside>
        <div className={`${railOpen ? "hidden" : "flex"} md:flex flex-1 min-w-0 flex-col`}>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain" data-workspace-scroll>
            <div className="max-w-2xl mx-auto px-3 sm:px-5 pt-2 pb-6 min-h-full flex flex-col" data-testid="journal-page">
              {/* Options: whose journal, the day, new, attach, delete — one compact line. */}
              <div className="flex items-center gap-1.5 flex-wrap" data-testid="journal-options">
                {!entryId && writers.length > 1 && (
                  <select value={forProfileId} onChange={(e) => setForProfileId(e.target.value)} aria-label="Whose journal this entry is for"
                    className={`${chip} max-w-[10rem] px-2`} data-testid="select-journal-for">
                    {writers.map((p) => <option key={p.id} value={p.type === "self" ? "" : p.id}>{p.type === "self" ? "My journal" : `${p.name}'s journal`}</option>)}
                  </select>
                )}
                <input type="date" value={entryDate} max={today} disabled={!!entryId}
                  onChange={(e) => { if (e.target.value && e.target.value <= today) setEntryDate(e.target.value); }}
                  title={entryId ? "The day cannot move once the entry is saved" : "The day this entry is about"}
                  aria-label="Entry date" className={`${chip} disabled:opacity-60`} data-testid="input-journal-date" />
                <AttachMenu onFiles={(f) => void addFiles(f)} busy={adding} disabled={!text.trim()} disabledTitle="Write something first — an attachment belongs to an entry" testId="journal-attach" />
                <div className="flex-1" />
                {(entryId || text.trim()) && (
                  <button type="button" onClick={() => void open(null)} className="h-7 px-2 rounded-full text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground" data-testid="button-journal-done" title="Save this entry and start a new one">
                    <Plus className="h-3.5 w-3.5" /> New
                  </button>
                )}
                {entryId && (
                  <button type="button" onClick={() => confirm("delete", () => void remove())}
                    className={`h-7 px-2 rounded-full text-xs flex items-center gap-1 ${isArmed("delete") ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    aria-label={isArmed("delete") ? "Tap again to delete this entry" : "Delete this entry"}
                    data-testid="button-journal-delete">
                    <Trash2 className="h-3.5 w-3.5" /> {isArmed("delete") ? "Tap again" : ""}
                  </button>
                )}
              </div>

              {/* How you feel: small, single-line chips that wrap. */}
              <div className="mt-2" data-testid="journal-moods">
                <div className="flex gap-1 flex-wrap">
                  {MOODS.map((m) => {
                    const cfg = MOOD_CONFIG[m];
                    const Icon = cfg.icon;
                    const active = shownMood === m;
                    return (
                      <button key={m} type="button" aria-pressed={mood === m}
                        onClick={() => { setMood(mood === m ? null : m); touch(); }}
                        className={`h-6 px-2 rounded-full border text-[11px] leading-none whitespace-nowrap flex items-center gap-1 transition-colors ${active ? "border-transparent text-white" : "border-border text-muted-foreground hover:text-foreground"}`}
                        style={active ? { background: cfg.color, opacity: mood === m ? 1 : 0.7 } : undefined}
                        data-testid={`button-mood-${m}`}>
                        <Icon className="h-3 w-3" /> {cfg.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1 truncate" data-testid="journal-mood-source">
                  {mood ? <>You picked {MOOD_CONFIG[mood].label}. Tap it again to have it detected.</>
                    : detected ? <>Detected from your writing: {MOOD_CONFIG[detected].label}. Tap a mood to choose.</>
                    : <>Mood is optional — detected from what you write if you don't pick.</>}
                </p>
              </div>

              {/* The page: a title, then the writing — one continuous sheet. */}
              <input value={title} onChange={(e) => { setTitle(e.target.value); touch(); }} placeholder="Title (optional)"
                aria-label="Entry title" maxLength={120}
                className="mt-2 w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/50 border-b border-border/50 pb-1" data-testid="input-journal-title" />
              {!text.trim() && (
                <div className="flex gap-1.5 overflow-x-auto py-2 -mx-3 px-3 sm:mx-0 sm:px-0" data-swipe-ignore data-testid="journal-prompts">
                  {JOURNAL_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button"
                      onClick={() => { setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n\n${prompt}\n` : `${prompt}\n`)); touch(); textRef.current?.focus(); }}
                      className="shrink-0 h-6 px-2 rounded-full text-[11px] whitespace-nowrap border border-[hsl(var(--accent-hsl)/0.35)] text-[hsl(var(--accent-hsl))] hover:bg-[hsl(var(--accent-hsl)/0.1)]">
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
              <textarea ref={textRef} value={text} onChange={(e) => { setText(e.target.value); touch(); }}
                placeholder="Whatever is on your mind…" aria-label="Journal entry" rows={8}
                className="workspace-writing block w-full flex-[1_0_auto] min-h-[45vh] mt-2 bg-transparent text-base leading-7 outline-none resize-none overflow-hidden placeholder:text-muted-foreground/40"
                data-testid="input-journal-free-text" />

              {/* Attachments: small thumbnails and file rows. */}
              {(photos.length > 0 || files.length > 0) && (
                <div className="mt-3 pt-2 border-t border-border/60 space-y-1.5" data-testid="journal-photos">
                  {photos.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {photos.map((id) => (
                        <Photo key={id} id={id} armed={isArmed(`photo:${id}`)}
                          onRemove={() => confirm(`photo:${id}`, () => { const next = latest.current.photos.filter((x) => x !== id); latest.current = { ...latest.current, photos: next }; setPhotos(next); touch(); })} />
                      ))}
                    </div>
                  )}
                  {files.map((id) => (
                    <FileRow key={id} id={id} armed={isArmed(`file:${id}`)}
                      onOpen={async () => { await saveNow(); hashNavigate(`/documents/${id}`); }}
                      onRemove={() => confirm(`file:${id}`, () => { const next = latest.current.files.filter((x) => x !== id); latest.current = { ...latest.current, files: next }; setFiles(next); touch(); })} />
                  ))}
                </div>
              )}
              <input value={labels} onChange={(e) => { setLabels(e.target.value); touch(); }} placeholder="Tags, comma separated (optional)" aria-label="Tags"
                className="ws-field mt-2 w-full bg-transparent border-b border-border/50 text-sm py-1 outline-none placeholder:text-muted-foreground/40" data-testid="input-journal-tags" />
            </div>
          </div>
          {reflection && (
            <div className="border-t border-border bg-card px-3 py-2 shrink-0 max-h-[35%] overflow-y-auto overscroll-contain" data-testid="journal-ai-answer">
              <p className="text-[11px] font-semibold mb-1">From your journal · {reflection.entriesRead} {reflection.entriesRead === 1 ? "entry" : "entries"} read · your entries are not changed</p>
              <p className="text-sm whitespace-pre-wrap">{reflection.answer}</p>
              <button type="button" className="mt-1.5 h-7 px-3 rounded-full border border-border text-xs" onClick={() => setReflection(null)}>Close</button>
            </div>
          )}
          <WorkspaceAiBar
            placeholder="Ask AI about your journal…"
            busy={reflecting}
            onAsk={(i) => void ask(i)}
            suggestions={["Summarize today", "Summarize my last week", "What themes keep coming up?", "How has my mood been lately?"]}
            testId="journal-ai"
          />
        </div>
      </div>
    </WorkspaceShell>
  );
}
