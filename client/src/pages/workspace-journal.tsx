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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImagePlus, Loader2, Plus, Trash2, X } from "lucide-react";
import type { JournalEntry, MoodLevel } from "@shared/schema";
import { detectMoodFromText } from "@shared/mood-detect";
import { getUserToday } from "@shared/timezone";
import { JOURNAL_MAX_PHOTOS, journalLabels, journalPhotoIds, journalTagsFor } from "@shared/journal-photos";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { parseLocalDate } from "@/lib/format";
import { useDocumentBlobUrl } from "@/lib/document-preview";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { MOOD_CONFIG } from "@/pages/journal";
import { WorkspaceShell, WorkspaceAiBar, aiErrorText, leaveWorkspace } from "@/components/workspace/WorkspaceShell";

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
const PHOTO_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
const MOODS = Object.keys(MOOD_CONFIG) as MoodLevel[];

interface ProfileRow { id: string; name: string; type: string }
type SaveState = "empty" | "dirty" | "saving" | "saved" | "error";
const STATUS: Record<SaveState, string> = {
  empty: "Nothing written yet", dirty: "Saving as you write", saving: "Saving…", saved: "Saved", error: "Couldn't save — will retry",
};

const longDay = (day: string) => (parseLocalDate(day) ?? new Date()).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const monthOf = (day: string) => (parseLocalDate(day) ?? new Date()).toLocaleDateString(undefined, { month: "long", year: "numeric" });

function Photo({ id, onRemove, armed }: { id: string; onRemove?: () => void; armed?: boolean }) {
  const blob = useDocumentBlobUrl(id, "image/jpeg");
  return (
    <div className="relative h-24 w-24 rounded-xl overflow-hidden border border-border bg-muted shrink-0" data-testid={`journal-photo-${id}`}>
      {blob.url ? <img src={blob.url} alt="Journal photo" className="h-full w-full object-cover" />
        : <div className="h-full w-full flex items-center justify-center text-[11px] text-muted-foreground">{blob.error ? "Couldn't load" : <Loader2 className="h-4 w-4 animate-spin" />}</div>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={armed ? "Tap again to remove this photo" : "Remove photo"}
          className={`absolute top-1 right-1 h-6 rounded-full text-[10px] px-1.5 flex items-center gap-0.5 ${armed ? "bg-destructive text-destructive-foreground" : "bg-background/85 text-foreground"}`}>
          <X className="h-3 w-3" />{armed ? "Remove?" : ""}
        </button>
      )}
    </div>
  );
}

export default function JournalWorkspacePage() {
  useEffect(() => { document.title = "Journal — Portol"; }, []);
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const today = getUserToday(BROWSER_TIMEZONE);

  const entriesQuery = useQuery<JournalEntry[]>({ queryKey: ["/api/journal"] });
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
  const [forProfileId, setForProfileId] = useState("");
  const [state, setState] = useState<SaveState>("empty");
  const [railOpen, setRailOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reflection, setReflection] = useState<{ answer: string; entriesRead: number } | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const latest = useRef({ entryId, entryDate, title, text, mood, labels, photos, forProfileId });
  latest.current = { entryId, entryDate, title, text, mood, labels, photos, forProfileId };
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
      const tags = journalTagsFor(v.labels.split(","), v.photos);
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
      setText(""); setTitle(""); setMood(null); setLabels(""); setPhotos([]); setEntryDate(today); titled.current = false; setState("empty");
    } catch (err) {
      toast({ title: "Couldn't delete the entry", description: aiErrorText(err), variant: "destructive" });
    }
  };

  const addPhoto = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast({ title: "That file is not a photo", variant: "destructive" }); return; }
    if (photos.length >= JOURNAL_MAX_PHOTOS) { toast({ title: `An entry holds up to ${JOURNAL_MAX_PHOTOS} photos`, variant: "destructive" }); return; }
    if (file.size > 10 * 1024 * 1024) { toast({ title: "Photo too large", description: "Photos can be up to 10 MB.", variant: "destructive" }); return; }
    setAdding(true);
    try {
      const data: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Couldn't read that photo."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const r = await apiRequest("POST", "/api/upload/save-only", { fileName: file.name || `journal-${entryDate}.jpg`, mimeType: file.type, fileData: data });
      const j = await r.json();
      if (!j?.documentId) throw new Error("The photo was not saved.");
      void invalidateDomain("documents");
      setPhotos((p) => [...new Set([...p, String(j.documentId)])]);
      touch();
    } catch (err) {
      toast({ title: "Couldn't add that photo", description: aiErrorText(err), variant: "destructive" });
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

  const rail = (
    <div className="flex flex-col h-full min-h-0" style={accent}>
      <div className="p-3 shrink-0">
        <button type="button" onClick={() => void open(null)} className="w-full h-10 rounded-full text-sm font-semibold flex items-center justify-center gap-1.5 text-white"
          style={{ background: `hsl(${ACCENT})` }} data-testid="button-journal-new">
          <Plus className="h-4 w-4" /> New entry
        </button>
        <div className="mt-3 rounded-2xl border border-border/60 bg-card px-3 py-2.5" data-testid="journal-week">
          <p className="micro-label text-muted-foreground mb-2">This week</p>
          <div className="flex justify-between">
            {week.map((d) => {
              const cfg = d.entry ? MOOD_CONFIG[d.entry.mood] || MOOD_CONFIG.neutral : null;
              const Icon = cfg?.icon;
              return (
                <button key={d.day} type="button" disabled={!d.entry} onClick={() => d.entry && void open(d.entry)} title={d.entry ? `${longDay(d.day)} · ${cfg!.label}` : `${longDay(d.day)} · nothing written`}
                  className="flex flex-col items-center gap-1 disabled:opacity-60">
                  <span className={`h-8 w-8 rounded-full flex items-center justify-center ${cfg ? cfg.bg : "bg-muted"}`}>
                    {Icon ? <Icon className="h-4 w-4" style={{ color: cfg!.color }} /> : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />}
                  </span>
                  <span className={`text-[10px] ${d.day === today ? "font-bold text-foreground" : "text-muted-foreground"}`}>{d.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3" data-testid="journal-timeline">
        {entriesQuery.isLoading ? (
          <p className="p-2 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your journal…</p>
        ) : entriesQuery.isError && entries.length === 0 ? (
          <div className="p-2 text-xs" data-testid="journal-timeline-error">
            <p className="text-destructive">Couldn't load your journal.</p>
            <button type="button" className="underline mt-1" onClick={() => entriesQuery.refetch()}>Retry</button>
          </div>
        ) : months.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">Your entries will line up here, day by day.</p>
        ) : months.map((m) => (
          <div key={m.month} className="mb-3">
            <p className="micro-label text-muted-foreground px-1 mb-1.5">{m.month}</p>
            <div className="relative pl-4 border-l border-border/70 ml-2 space-y-1.5">
              {m.rows.map((e) => {
                const cfg = MOOD_CONFIG[e.mood] || MOOD_CONFIG.neutral;
                const d = parseLocalDate(String(e.date).slice(0, 10)) ?? new Date();
                const who = ownerOf(e);
                const nPhotos = journalPhotoIds(e.tags).length;
                return (
                  <button key={e.id} type="button" onClick={() => void open(e)}
                    className={`relative w-full text-left rounded-xl px-3 py-2 border transition-colors ${e.id === entryId ? "bg-[hsl(var(--accent-hsl)/0.12)] border-[hsl(var(--accent-hsl)/0.6)]" : "border-transparent hover:bg-muted/60"}`}
                    data-testid={`journal-row-${e.id}`}>
                    <span className="absolute -left-[21px] top-3.5 h-2.5 w-2.5 rounded-full ring-2 ring-background" style={{ background: cfg.color }} />
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-bold tabular-nums">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span>
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
      title={<span className="text-base font-semibold truncate block">{longDay(entryDate)}</span>}
      actions={
        <>
          <button type="button" onClick={() => setRailOpen((v) => !v)} className="md:hidden h-9 px-2.5 rounded-md border border-border text-xs" data-testid="button-journal-rail">
            {railOpen ? "Write" : `Entries (${entries.length})`}
          </button>
          {entryId && (
            <button type="button" onClick={() => confirm("delete", () => void remove())}
              className={`h-9 px-2.5 rounded-md border text-xs flex items-center gap-1 ${isArmed("delete") ? "border-destructive text-destructive" : "border-border text-muted-foreground"}`}
              data-testid="button-journal-delete">
              <Trash2 className="h-3.5 w-3.5" /> {isArmed("delete") ? "Tap again to delete" : <span className="hidden sm:inline">Delete</span>}
            </button>
          )}
        </>
      }
      onClose={async () => { await saveNow(true); leaveWorkspace(); }}
    >
      <div className="flex-1 min-h-0 flex" style={accent}>
        <aside className={`${railOpen ? "flex" : "hidden"} md:flex flex-col w-full md:w-80 border-r border-border bg-muted/30 min-h-0`}>{rail}</aside>
        <div className={`${railOpen ? "hidden" : "flex"} md:flex flex-1 min-w-0 flex-col`}>
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ background: `linear-gradient(180deg, hsl(${ACCENT} / 0.07) 0%, transparent 240px)` }}>
            <div className="max-w-2xl mx-auto px-5 py-8" data-testid="journal-page">
              {/* The day. */}
              <div className="flex items-end justify-between gap-3 flex-wrap">
                <div>
                  <p className="micro-label" style={{ color: `hsl(${ACCENT})` }}>{entryId ? "Journal entry" : "New entry"}</p>
                  <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-0.5">{longDay(entryDate)}</h1>
                </div>
                <div className="flex items-center gap-2">
                  {!entryId && writers.length > 1 && (
                    <select value={forProfileId} onChange={(e) => setForProfileId(e.target.value)} aria-label="Whose journal this entry is for"
                      className="h-8 rounded-full border border-border bg-background px-2 text-xs" data-testid="select-journal-for">
                      {writers.map((p) => <option key={p.id} value={p.type === "self" ? "" : p.id}>{p.type === "self" ? "My journal" : `${p.name}'s journal`}</option>)}
                    </select>
                  )}
                  <input type="date" value={entryDate} max={today} disabled={!!entryId}
                    onChange={(e) => { if (e.target.value && e.target.value <= today) setEntryDate(e.target.value); }}
                    title={entryId ? "The day cannot move once the entry is saved" : "The day this entry is about"}
                    aria-label="Entry date" className="h-8 rounded-full border border-border bg-background px-3 text-xs disabled:opacity-60" data-testid="input-journal-date" />
                </div>
              </div>

              {/* How you feel. */}
              <div className="mt-5" data-testid="journal-moods">
                <div className="flex gap-1.5 flex-wrap">
                  {MOODS.map((m) => {
                    const cfg = MOOD_CONFIG[m];
                    const Icon = cfg.icon;
                    const active = shownMood === m;
                    return (
                      <button key={m} type="button" aria-pressed={mood === m}
                        onClick={() => { setMood(mood === m ? null : m); touch(); }}
                        className={`h-9 px-3 rounded-full border text-xs flex items-center gap-1.5 transition-colors ${active ? "border-transparent text-white" : "border-border text-muted-foreground hover:text-foreground"}`}
                        style={active ? { background: cfg.color, opacity: mood === m ? 1 : 0.7 } : undefined}
                        data-testid={`button-mood-${m}`}>
                        <Icon className="h-3.5 w-3.5" /> {cfg.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5" data-testid="journal-mood-source">
                  {mood ? <>You picked {MOOD_CONFIG[mood].label}. Tap it again to have it detected from your writing.</>
                    : detected ? <>Detected from your writing: {MOOD_CONFIG[detected].label}. Tap a mood to choose your own.</>
                    : <>Optional. If you don't pick a mood, it is detected from what you write.</>}
                </p>
              </div>

              {/* The page. */}
              <div className="mt-5 rounded-3xl border border-border/70 bg-card shadow-sm px-5 md:px-8 py-6">
                <input value={title} onChange={(e) => { setTitle(e.target.value); touch(); }} placeholder="Title (optional — written for you if left blank)"
                  aria-label="Entry title" maxLength={120} className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/50" data-testid="input-journal-title" />
                <div className="flex gap-1.5 overflow-x-auto py-3" data-testid="journal-prompts">
                  {JOURNAL_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button"
                      onClick={() => { setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n\n${prompt}\n` : `${prompt}\n`)); touch(); textRef.current?.focus(); }}
                      className="shrink-0 h-7 px-2.5 rounded-full text-xs border border-[hsl(var(--accent-hsl)/0.35)] text-[hsl(var(--accent-hsl))] hover:bg-[hsl(var(--accent-hsl)/0.1)]">
                      {prompt}
                    </button>
                  ))}
                </div>
                <textarea ref={textRef} value={text} onChange={(e) => { setText(e.target.value); touch(); }}
                  placeholder="Whatever is on your mind…" aria-label="Journal entry"
                  className="block w-full min-h-[38vh] bg-transparent text-base leading-8 outline-none resize-none placeholder:text-muted-foreground/40" data-testid="input-journal-free-text" />

                {/* Photos. */}
                <div className="mt-4 pt-4 border-t border-border/60" data-testid="journal-photos">
                  <div className="flex gap-2 flex-wrap items-center">
                    {photos.map((id) => (
                      <Photo key={id} id={id} armed={isArmed(`photo:${id}`)}
                        onRemove={() => confirm(`photo:${id}`, () => { setPhotos((p) => p.filter((x) => x !== id)); touch(); })} />
                    ))}
                    <button type="button" disabled={adding || !text.trim()} onClick={() => { const el = photoInput.current; if (el) { el.value = ""; el.click(); } }}
                      title={text.trim() ? "Add a photo to this entry" : "Write something first — a photo belongs to an entry"}
                      className="h-24 w-24 rounded-xl border border-dashed border-border flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                      data-testid="button-journal-add-photo">
                      {adding ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />} Add photo
                    </button>
                    <input ref={photoInput} type="file" accept={PHOTO_ACCEPT} className="hidden" onChange={(e) => void addPhoto(e.target.files?.[0])} data-testid="input-journal-photo" />
                  </div>
                </div>
                <input value={labels} onChange={(e) => { setLabels(e.target.value); touch(); }} placeholder="Tags, comma separated (optional)" aria-label="Tags"
                  className="mt-4 w-full bg-transparent border-b border-border/60 text-sm py-1.5 outline-none placeholder:text-muted-foreground/40" data-testid="input-journal-tags" />
              </div>

              <div className="mt-4 flex justify-end">
                <button type="button" disabled={!text.trim()} onClick={async () => { await saveNow(true); toast({ title: "Entry saved" }); await open(null); }}
                  className="h-10 px-5 rounded-full text-sm font-semibold text-white disabled:opacity-50" style={{ background: `hsl(${ACCENT})` }} data-testid="button-journal-done">
                  Done — start a new entry
                </button>
              </div>
            </div>
          </div>
          {reflection && (
            <div className="border-t border-border bg-card px-4 py-3 shrink-0 max-h-[35vh] overflow-y-auto" data-testid="journal-ai-answer">
              <p className="text-xs font-semibold mb-1.5">From your journal · {reflection.entriesRead} {reflection.entriesRead === 1 ? "entry" : "entries"} read · your entries are not changed</p>
              <p className="text-sm whitespace-pre-wrap">{reflection.answer}</p>
              <button type="button" className="mt-2 h-8 px-3 rounded-md border border-border text-xs" onClick={() => setReflection(null)}>Close</button>
            </div>
          )}
          <WorkspaceAiBar
            placeholder="Ask AI about your journal — a summary, themes, how your mood has been…"
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
