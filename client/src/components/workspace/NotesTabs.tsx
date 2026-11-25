// The Notes app's tabs beside its editor (owner request 2026-11-25):
// All Notes, Favorites, Categories and AI Insights. Presentation over the one
// notes list the page already loads (`/api/notes`); every change is a single
// write to the stored row — a favourite is the note's `pinned` flag, a
// category is applied by the server to the note's stored tags (Rule 6).
//
// A filter here is a view: it names what it hides and is never stored
// (Rule 4). Delete takes two taps (Rule 8). The AI proposes; the user applies
// (W5).
import { useCallback, useMemo, useState } from "react";
import { CheckSquare, FolderOpen, Lightbulb, Link2, ListTodo, Loader2, Repeat, Search, Sparkles, Star, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { noteCategory } from "@shared/note-markdown";
import { openChecklistItems, type CategorySuggestion, type NoteInsightItem, type NoteInsights } from "@shared/workspace-intel";
import { aiErrorText } from "./WorkspaceShell";
import { AiAccessLine, AiAccessPanel, SectionTitle, TabPage } from "./WorkspaceApp";

export interface NoteRow { id: string; title: string; content: string; tags?: string[]; pinned?: boolean; updatedAt?: string; createdAt?: string; linkedProfiles?: string[] }

export function categoryHue(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export const categoryDot = (name: string) => ({ background: `hsl(${categoryHue(name)} 70% 50%)` });
export const noteSnippet = (md: string, max = 90) => String(md || "").replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`~\-[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export function noteAgo(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const byNewest = (a: NoteRow, b: NoteRow) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));

interface ListState { loading: boolean; failed: boolean; retry: () => void }

/** Re-read the notes after a write: the workspace's own list, and every other screen that shows notes. */
export function useRefreshNotes(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["/api/notes"] });
    void invalidateDomain("artifacts");
  }, [qc]);
}

/** The star on a note. One write: the note's own `pinned` flag. */
export function FavoriteButton({ note, onChanged, className = "" }: { note: Pick<NoteRow, "id" | "pinned">; onChanged?: () => void; className?: string }) {
  const { toast } = useToast();
  const refresh = useRefreshNotes();
  const [busy, setBusy] = useState(false);
  const on = !!note.pinned;
  return (
    <button
      type="button"
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? "Remove from favorites" : "Add to favorites"}
      title={on ? "Remove from favorites" : "Add to favorites"}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try { await apiRequest("PATCH", `/api/artifacts/${note.id}`, { pinned: !on }); refresh(); onChanged?.(); }
        catch (err) { toast({ title: "Couldn't change that favorite", description: aiErrorText(err), variant: "destructive" }); }
        finally { setBusy(false); }
      }}
      className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 hover:bg-muted ${on ? "text-amber-500" : "text-muted-foreground"} ${className}`}
      data-testid={`button-note-favorite-${note.id}`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" fill={on ? "currentColor" : "none"} />}
    </button>
  );
}

/**
 * All Notes / Favorites: browse, search, open, star and delete.
 * `favoritesOnly` is the Favorites tab — a view of the same list.
 */
export function NotesBrowser({
  notes, list, favoritesOnly = false, categoryFilter, onCategoryFilter, onOpen, onChanged, onDeleted, openId,
}: {
  notes: NoteRow[];
  list: ListState;
  favoritesOnly?: boolean;
  categoryFilter: string | null;
  onCategoryFilter: (name: string | null) => void;
  onOpen: (note: NoteRow) => void;
  onChanged?: () => void;
  onDeleted: (id: string) => void;
  openId: string | null;
}) {
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const [search, setSearch] = useState("");
  const refresh = useRefreshNotes();
  const base = useMemo(() => (favoritesOnly ? notes.filter((n) => n.pinned) : notes), [notes, favoritesOnly]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of base) { const c = noteCategory(n.tags); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [base]);
  const filter = favoritesOnly ? null : categoryFilter;
  const inCategory = filter ? base.filter((n) => noteCategory(n.tags) === filter) : base;
  const q = search.trim().toLowerCase();
  const shown = [...(q ? inCategory.filter((n) => `${n.title} ${n.content} ${(n.tags || []).join(" ")}`.toLowerCase().includes(q)) : inCategory)].sort(byNewest);
  const hidden = base.length - inCategory.length;

  const remove = async (id: string) => {
    try {
      await apiRequest("DELETE", `/api/notes/${id}`);
      refresh();
      toast({ title: "Note deleted" });
      onDeleted(id);
    } catch (err) {
      toast({ title: "Couldn't delete the note", description: aiErrorText(err), variant: "destructive" });
    }
  };

  return (
    <TabPage testId={favoritesOnly ? "notes-favorites" : "notes-all"} wide>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={favoritesOnly ? "Search favorites" : "Search every note"} aria-label={favoritesOnly ? "Search favorites" : "Search every note"}
          className="ws-title w-full h-10 rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary/60" data-testid={favoritesOnly ? "input-favorites-search" : "input-all-notes-search"} />
      </div>
      {!favoritesOnly && categories.length > 0 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none]" data-swipe-ignore data-testid="all-notes-categories">
          <button type="button" onClick={() => onCategoryFilter(null)} aria-pressed={!filter} className="shrink-0 h-7 px-2.5 rounded-full border border-border text-xs aria-pressed:bg-foreground aria-pressed:text-background">All · {base.length}</button>
          {categories.map(([name, count]) => (
            <button key={name} type="button" onClick={() => onCategoryFilter(filter === name ? null : name)} aria-pressed={filter === name}
              className="shrink-0 h-7 px-2.5 rounded-full border border-border text-xs flex items-center gap-1.5 aria-pressed:bg-foreground aria-pressed:text-background">
              <span className="h-2 w-2 rounded-full" style={categoryDot(name)} /> {name} · {count}
            </button>
          ))}
        </div>
      )}
      {filter && hidden > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="all-notes-filter-notice">
          Showing {filter} only — {hidden} other {hidden === 1 ? "note is" : "notes are"} hidden.{" "}
          <button type="button" className="underline" onClick={() => onCategoryFilter(null)}>Show all</button>
        </p>
      )}
      <div className="mt-3">
        {list.loading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</p>
        ) : list.failed && notes.length === 0 ? (
          <div className="text-xs" role="alert" data-testid="all-notes-error"><p className="text-destructive">Couldn't load your notes.</p><button type="button" className="underline mt-1" onClick={list.retry}>Retry</button></div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="all-notes-empty">
            {q ? `No ${favoritesOnly ? "favorite" : "note"} matches “${search.trim()}”${filter ? ` in ${filter}` : ""}.`
              : filter ? `No notes in ${filter}.`
              : favoritesOnly ? (notes.length > 0 ? "No favorites yet. Tap the star on a note to keep it here." : "No notes yet, so nothing to favorite.")
              : "No notes yet. Open the Editor tab and start typing to write the first."}
          </p>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground mb-1.5" data-testid="all-notes-count">{shown.length} {shown.length === 1 ? "note" : "notes"}{q || filter ? ` of ${base.length}` : ""}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {shown.map((n) => {
                const cat = noteCategory(n.tags);
                return (
                  <li key={n.id} className={`rounded-xl border ${n.id === openId ? "border-primary" : "border-border/70"} bg-card flex items-stretch min-w-0`} data-testid={`all-note-${n.id}`}>
                    <button type="button" onClick={() => onOpen(n)} className="flex-1 min-w-0 text-left px-3 py-2.5" title="Open in the editor">
                      <span className="text-sm font-semibold truncate block">{n.title || "Untitled"}</span>
                      <span className="text-xs text-muted-foreground line-clamp-2 block mt-0.5">{noteSnippet(n.content, 160) || "Empty note"}</span>
                      <span className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
                        {cat && <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={categoryDot(cat)} />{cat}</span>}
                        <span className="ml-auto">{noteAgo(n.updatedAt || n.createdAt)}</span>
                      </span>
                    </button>
                    <div className="flex flex-col items-center justify-between py-1 pr-1">
                      <FavoriteButton note={n} onChanged={onChanged} />
                      <button type="button" onClick={() => confirm(`del:${n.id}`, () => void remove(n.id))}
                        aria-label={isArmed(`del:${n.id}`) ? "Tap again to delete this note" : "Delete this note"}
                        className={`h-8 rounded-full flex items-center justify-center gap-1 text-[11px] ${isArmed(`del:${n.id}`) ? "px-2 bg-destructive text-destructive-foreground" : "w-8 text-muted-foreground hover:bg-muted"}`}
                        data-testid={`button-all-note-delete-${n.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />{isArmed(`del:${n.id}`) ? "Sure?" : ""}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </TabPage>
  );
}

/** Categories: every folder with its count, notes not filed yet, and the AI's suggestions for them. */
export function NotesCategories({
  notes, list, onBrowse, onOpen, onChanged,
}: {
  notes: NoteRow[];
  list: ListState;
  onBrowse: (category: string) => void;
  onOpen: (note: NoteRow) => void;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});
  const refresh = useRefreshNotes();
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) { const c = noteCategory(n.tags); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [notes]);
  const loose = useMemo(() => notes.filter((n) => !noteCategory(n.tags)).sort(byNewest), [notes]);

  /** File one note: the server applies the category to the note's stored tags. */
  const file = async (id: string, category: string): Promise<boolean> => {
    const name = category.trim();
    if (!name) return false;
    setApplying(id);
    try {
      await apiRequest("PATCH", `/api/notes/${id}`, { category: name });
      setSuggestions((s) => (s ? s.filter((x) => x.id !== id) : s));
      refresh();
      onChanged?.();
      return true;
    } catch (err) {
      toast({ title: "Couldn't file that note", description: aiErrorText(err), variant: "destructive" });
      return false;
    } finally { setApplying(null); }
  };
  const suggest = async () => {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/workspace/notes/categorize", {});
      const j = await r.json();
      if (!Array.isArray(j?.suggestions)) throw new Error("The AI returned nothing usable.");
      setSuggestions(j.suggestions);
      if (j.suggestions.length === 0) toast({ title: "No suggestions", description: "The AI did not find a clear category for the notes that have none." });
    } catch (err) {
      toast({ title: "AI couldn't sort the notes", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(false); }
  };
  const applyAll = async () => { for (const s of suggestions || []) if (!(await file(s.id, s.category))) break; };

  if (list.loading) return <TabPage testId="notes-categories"><p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</p></TabPage>;
  if (list.failed && notes.length === 0) return <TabPage testId="notes-categories"><div className="text-xs" role="alert"><p className="text-destructive">Couldn't load your notes.</p><button type="button" className="underline mt-1" onClick={list.retry}>Retry</button></div></TabPage>;
  const suggestedFor = new Map((suggestions || []).map((s) => [s.id, s.category]));
  return (
    <TabPage testId="notes-categories">
      <SectionTitle icon={FolderOpen}>Categories</SectionTitle>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet. Give a note a category in the Editor, or file the notes below.</p>
      ) : (
        <ul className="grid gap-2 grid-cols-2 sm:grid-cols-3">
          {categories.map(([name, count]) => (
            <li key={name}>
              <button type="button" onClick={() => onBrowse(name)} className="w-full text-left bubble px-3 py-2.5 hover:bg-muted/60" data-testid={`category-card-${name}`} title={`Show the notes in ${name}`}>
                <span className="flex items-center gap-1.5 text-sm font-semibold truncate"><span className="h-2.5 w-2.5 rounded-full shrink-0" style={categoryDot(name)} />{name}</span>
                <span className="text-xs text-muted-foreground">{count} {count === 1 ? "note" : "notes"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5">
        <SectionTitle icon={Sparkles} aside={loose.length > 0 ? (
          <button type="button" disabled={busy} onClick={() => void suggest()} className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold flex items-center gap-1 disabled:opacity-50" data-testid="button-categorize-ai">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Suggest with AI
          </button>
        ) : null}>
          Not filed yet · {loose.length}
        </SectionTitle>
        {loose.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="categories-all-filed">{notes.length === 0 ? "No notes yet." : "Every note has a category."}</p>
        ) : (
          <>
            {suggestions && suggestions.length > 0 && (
              <div className="mb-2 flex items-center gap-2 text-xs" data-testid="categorize-proposal">
                <span className="flex-1">The AI suggests a category for {suggestions.length} {suggestions.length === 1 ? "note" : "notes"}. Nothing is filed until you apply it.</span>
                <button type="button" onClick={() => void applyAll()} disabled={!!applying} className="h-7 px-2.5 rounded-full border border-border font-semibold shrink-0" data-testid="button-categorize-apply-all">Apply all</button>
                <button type="button" onClick={() => setSuggestions(null)} className="h-7 px-2.5 rounded-full text-muted-foreground shrink-0">Discard</button>
              </div>
            )}
            <datalist id="notes-category-names">{categories.map(([name]) => <option key={name} value={name} />)}</datalist>
            <ul className="space-y-1.5">
              {loose.map((n) => {
                const suggested = suggestedFor.get(n.id);
                const typed = manual[n.id] ?? "";
                return (
                  <li key={n.id} className="bubble px-3 py-2 flex items-center gap-2 flex-wrap" data-testid={`uncategorized-${n.id}`}>
                    <button type="button" onClick={() => onOpen(n)} className="flex-1 min-w-[8rem] text-left" title="Open in the editor">
                      <span className="text-sm font-medium truncate block">{n.title || "Untitled"}</span>
                      <span className="text-xs text-muted-foreground truncate block">{noteSnippet(n.content) || "Empty note"}</span>
                    </button>
                    {suggested && (
                      <button type="button" disabled={applying === n.id} onClick={() => void file(n.id, suggested)}
                        className="h-7 px-2.5 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center gap-1.5 shrink-0" data-testid={`button-apply-category-${n.id}`}>
                        <span className="h-2 w-2 rounded-full" style={categoryDot(suggested)} /> File under {suggested}
                      </button>
                    )}
                    <form className="flex items-center gap-1 shrink-0" onSubmit={(e) => { e.preventDefault(); void file(n.id, typed).then((ok) => { if (ok) setManual((m) => ({ ...m, [n.id]: "" })); }); }}>
                      <input list="notes-category-names" value={typed} onChange={(e) => setManual((m) => ({ ...m, [n.id]: e.target.value }))} placeholder="Category" aria-label={`Category for ${n.title || "this note"}`} maxLength={40}
                        className="ws-field h-7 w-28 rounded-full border border-border bg-background px-2.5 text-xs outline-none" data-testid={`input-category-${n.id}`} />
                      <button type="submit" disabled={!typed.trim() || applying === n.id} className="h-7 px-2.5 rounded-full border border-border text-xs disabled:opacity-40">File</button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </TabPage>
  );
}

const INSIGHT_SECTIONS: Array<{ key: keyof NoteInsights; label: string; icon: typeof Sparkles; empty: string }> = [
  { key: "recurring", label: "Recurring ideas", icon: Repeat, empty: "No idea shows up in more than one note." },
  { key: "related", label: "Related notes", icon: Link2, empty: "No notes clearly belong together." },
  { key: "unfinished", label: "Unfinished plans", icon: ListTodo, empty: "No plan looks left open." },
  { key: "connections", label: "Connections", icon: Lightbulb, empty: "No further connections found." },
];

/**
 * AI Insights. The open check-list items are COUNTED from the notes (no model
 * involved); the rest is asked for on a tap and shown with the notes each
 * item stands on — a reference to a note that does not exist never reaches
 * the screen (shared/workspace-intel.ts).
 */
export function NotesInsightsTab({ notes, list, onOpen }: { notes: NoteRow[]; list: ListState; onOpen: (id: string) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ insights: NoteInsights; notesRead: number; notesTotal: number; at: number } | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const open = useMemo(() => notes
    .map((n) => ({ note: n, items: openChecklistItems(n.content) }))
    .filter((x) => x.items.length > 0)
    .sort((a, b) => byNewest(a.note, b.note)), [notes]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/workspace/notes/insights", {});
      const j = await r.json();
      if (!j?.insights) throw new Error("The AI returned nothing usable.");
      setResult({ insights: j.insights, notesRead: Number(j.notesRead) || 0, notesTotal: Number(j.notesTotal) || 0, at: Date.now() });
    } catch (err) {
      toast({ title: "AI couldn't read your notes", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(false); }
  };
  const item = (it: NoteInsightItem, i: number) => (
    <li key={i} className="bubble px-3 py-2">
      <p className="text-sm">{it.text}</p>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {it.notes.map((n) => (
          <button key={n.id} type="button" onClick={() => onOpen(n.id)} className="h-6 px-2 rounded-full bg-muted text-[11px] max-w-[14rem] truncate hover:bg-muted/70" title="Open this note" data-testid={`insight-note-${n.id}`}>{n.title}</button>
        ))}
      </div>
    </li>
  );

  return (
    <TabPage testId="notes-insights">
      <SectionTitle icon={CheckSquare}>Open check-list items · {open.reduce((n, x) => n + x.items.length, 0)}</SectionTitle>
      {list.loading ? <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</p>
        : list.failed && notes.length === 0 ? <div className="text-xs" role="alert"><p className="text-destructive">Couldn't load your notes.</p><button type="button" className="underline mt-1" onClick={list.retry}>Retry</button></div>
        : open.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="insights-no-open-items">No unchecked items in any note.</p>
        : (
          <ul className="space-y-1.5" data-testid="insights-open-items">
            {open.slice(0, 12).map(({ note, items }) => (
              <li key={note.id} className="bubble px-3 py-2">
                <button type="button" onClick={() => onOpen(note.id)} className="text-sm font-medium hover:underline text-left">{note.title || "Untitled"} · {items.length} open</button>
                <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4">
                  {items.slice(0, 4).map((t, i) => <li key={i} className="truncate">{t}</li>)}
                  {items.length > 4 && <li className="list-none">and {items.length - 4} more</li>}
                </ul>
              </li>
            ))}
            {open.length > 12 && <li className="text-xs text-muted-foreground">and {open.length - 12} more notes with open items</li>}
          </ul>
        )}

      <div className="mt-5">
        <SectionTitle icon={Sparkles} aside={
          <button type="button" disabled={busy || notes.length < 2} onClick={() => void run()} title={notes.length < 2 ? "Insights compare notes: write at least two" : undefined}
            className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold flex items-center gap-1 disabled:opacity-50" data-testid="button-notes-insights">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {result ? "Look again" : "Find insights"}
          </button>
        }>Across your notes</SectionTitle>
        <AiAccessLine app="notes" onChange={() => setAccessOpen((v) => !v)} />
        {accessOpen && <div className="mt-2"><AiAccessPanel app="notes" onClose={() => setAccessOpen(false)} /></div>}
        {!result ? (
          <p className="text-sm text-muted-foreground mt-2">{busy ? "Reading your notes…" : "The AI reads your notes and points out recurring ideas, notes that belong together, plans left open and connections between them. It changes nothing."}</p>
        ) : (
          <div className="mt-2 space-y-4" data-testid="notes-insights-result">
            <p className="text-[11px] text-muted-foreground">Read {result.notesRead} of {result.notesTotal} notes{result.notesRead < result.notesTotal ? " (the newest; the rest did not fit)" : ""}. An AI's reading — check it against the notes it names.</p>
            {INSIGHT_SECTIONS.map(({ key, label, icon: Icon, empty }) => (
              <section key={key} data-testid={`notes-insights-${key}`}>
                <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-1.5"><Icon className="h-3.5 w-3.5 text-primary" />{label}</h3>
                {result.insights[key].length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : <ul className="space-y-1.5">{result.insights[key].map(item)}</ul>}
              </section>
            ))}
          </div>
        )}
      </div>
    </TabPage>
  );
}
