import { parseLocalDate } from "@/lib/format";
import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Users,
  Activity,
  ListTodo,
  DollarSign,
  Calendar,
  FileText,
  Flame,
  BookHeart,
  CreditCard,
  Package,
  LayoutDashboard,
  MessageSquare,
  BarChart2,
  Clock,
  Search,
  FilePlus2,
  Table as TableIcon,
  Plus,
  BookOpen,
  Wallet,
  Settings as SettingsIcon,
  Bell,
  Sparkles,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { getProfileFilter } from "@/lib/profileFilter";
import { itemMatches } from "@/lib/search-index";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Profile {
  id: number;
  name: string;
  type?: string;
}
interface Tracker {
  id: number;
  name: string;
  category?: string;
}
interface Task {
  id: number;
  title: string;
  priority?: string;
  completed?: boolean;
}
interface Expense {
  id: number;
  description: string;
  amount?: number | string;
  category?: string;
}
interface CalendarEvent {
  id: number;
  title: string;
  startDate?: string;
  /** The API's event rows carry `date`; `startDate` is the calendar-adapter spelling. */
  date?: string;
  category?: string;
}
interface Document {
  id: number;
  name: string;
  type?: string;
  status?: string;
}
interface Habit {
  id: number;
  name: string;
  frequency?: string;
  currentStreak?: number;
}
interface JournalEntry {
  id: number;
  content?: string;
  mood?: string;
  date?: string;
  tags?: string[];
}
interface Obligation {
  id: number;
  name: string;
  category?: string;
  amount?: number | string;
}
interface Artifact {
  id: number;
  title: string;
  type?: string;
}

interface SearchResults {
  profiles?: Profile[];
  trackers?: Tracker[];
  tasks?: Task[];
  expenses?: Expense[];
  events?: CalendarEvent[];
  documents?: Document[];
  habits?: Habit[];
  journal?: JournalEntry[];
  obligations?: Obligation[];
  artifacts?: Artifact[];
}

// ─── Client-side search cache & instant narrowing ─────────────────────────────
// PERF-AUDIT (2026-07-03): every ⌘K query hit /api/search with a ~1s round-trip,
// even when re-typing "rent" or extending a previous query. The server returns
// the FULL match set for a term (only link-enrichment is capped), so a longer
// query's matches are always a strict subset of a shorter one's. We exploit that:
//   • cache authoritative server results per normalized query (60s TTL), so
//     repeat / recent-search queries resolve instantly with no round-trip;
//   • when the current query extends a cached broader query, narrow that cached
//     superset locally for an instant first paint, then revalidate against the
//     server in the background (stale-while-revalidate for search).

const SEARCH_CACHE_TTL_MS = 60_000; // reuse the same term's results for 60s
const SEARCH_CACHE_MAX = 50;        // cap distinct cached queries

// Cached results are only valid for the profile filter they were fetched under
// (the server scopes /api/search by profileIds), so the filter is part of the
// cache key. Mirrors exactly what handleQueryChange sends to the server.
function filterSignature(): string {
  const f = getProfileFilter();
  return f.mode === "selected" && f.selectedIds.length > 0
    ? "s:" + [...f.selectedIds].sort().join(",")
    : "all";
}
type SearchCacheEntry = { raw: any[]; ts: number };
// Nested cache: filter signature -> (normalized query -> results). Nesting
// avoids any query/sig delimiter ambiguity and isolates each filter's entries.
type SearchCache = Map<string, Map<string, SearchCacheEntry>>;

// Group the flat `_type`-tagged array the API returns into SearchResults.
function groupRaw(raw: any[]): SearchResults {
  const grouped: SearchResults = {};
  for (const item of raw) {
    const t = item._type as string;
    if (t === "profile") (grouped.profiles ??= []).push(item);
    else if (t === "tracker") (grouped.trackers ??= []).push(item);
    else if (t === "task") (grouped.tasks ??= []).push(item);
    else if (t === "expense") (grouped.expenses ??= []).push(item);
    else if (t === "event") (grouped.events ??= []).push(item);
    else if (t === "document") (grouped.documents ??= []).push(item);
    else if (t === "habit") (grouped.habits ??= []).push(item);
    else if (t === "journal") (grouped.journal ??= []).push(item);
    else if (t === "obligation") (grouped.obligations ??= []).push(item);
    else if (t === "artifact") (grouped.artifacts ??= []).push(item);
    // memory rows are intentionally not surfaced in the palette
  }
  return grouped;
}

// ─── Quick Actions ─────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: "Go to Dashboard", icon: LayoutDashboard, path: "/dashboard", shortcut: "D" },
  { label: "Go to Chat",      icon: MessageSquare,   path: "/chat",     shortcut: "C" },
  { label: "Go to Trackers",  icon: BarChart2,       path: "/trackers", shortcut: "T" },
  { label: "Go to Profiles",  icon: Users,           path: "/profiles", shortcut: "P" },
  { label: "Go to Finance",   icon: Wallet,          path: "/finance",  shortcut: "F" },
  { label: "Go to Tasks",     icon: ListTodo,        path: "/tasks",    shortcut: "K" },
  { label: "Go to Habits",    icon: Flame,           path: "/habits",   shortcut: "H" },
  { label: "Go to Journal",   icon: BookOpen,        path: "/dashboard/journal", shortcut: "J" },
  { label: "Go to Calendar",  icon: Calendar,        path: "/calendar", shortcut: "L" },
  { label: "Go to Artifacts", icon: FileText,        path: "/artifacts", shortcut: "A" },
  { label: "Go to Bills",     icon: Bell,            path: "/bills", shortcut: "O" },
  { label: "Go to Settings",  icon: SettingsIcon,    path: "/settings", shortcut: "S" },
  { label: "Insights",        icon: Sparkles,        path: "/insights", shortcut: "I" },
];

// Actions that create a new artifact/entity. Shown as their own group above
// Quick Actions for fast access.
const CREATE_ACTIONS = [
  { label: "New document",    icon: FilePlus2,  path: "/editor/new/doc",   color: "text-blue-500" },
  { label: "New spreadsheet", icon: TableIcon,  path: "/editor/new/sheet", color: "text-green-600" },
  { label: "New journal entry", icon: BookOpen, path: "/dashboard/journal?new=1", color: "text-purple-500" },
  { label: "Log an expense",  icon: Wallet,     path: "/finance?new=expense", color: "text-emerald-500" },
  { label: "New task",        icon: ListTodo,   path: "/tasks?new=1",      color: "text-orange-500" },
  { label: "New habit",       icon: Flame,      path: "/habits?new=1",     color: "text-red-500" },
  // Tracker creation is chat-only — shortcut removed 2026-05-21.
  { label: "Scan receipt",    icon: Sparkles,   path: "/insights",        color: "text-pink-500" },
  { label: "Generate weekly review", icon: Sparkles, path: "/insights",   color: "text-indigo-500" },
];

// ─── Shared CommandSearch context (open state lives here) ─────────────────────

interface CommandSearchContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}

import { createContext, useContext } from "react";

export const CommandSearchContext = createContext<CommandSearchContextValue>({
  open: false,
  setOpen: () => {},
});

export function useCommandSearch() {
  return useContext(CommandSearchContext);
}

// ─── Provider (wraps the app, manages open state) ─────────────────────────────

export function CommandSearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <CommandSearchContext.Provider value={{ open, setOpen }}>
      {children}
    </CommandSearchContext.Provider>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function CommandSearch() {
  const { open, setOpen } = useCommandSearch();
  const [, navigate] = useLocation();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  // Authoritative server results, cached per filter signature then query.
  const cacheRef = useRef<SearchCache>(new Map());

  // Find the longest fresh cached query (within the CURRENT filter) that the
  // current, longer query extends, so we can narrow its result set locally
  // instead of waiting on the server.
  const findFreshPrefixSuperset = useCallback((sig: string, norm: string): any[] | null => {
    const perFilter = cacheRef.current.get(sig);
    if (!perFilter) return null;
    let best: { raw: any[]; len: number } | null = null;
    const now = Date.now();
    for (const [key, val] of perFilter) {
      if (key.length >= norm.length) continue;        // must be strictly shorter
      if (!norm.startsWith(key)) continue;            // …and a prefix of the query
      if (now - val.ts > SEARCH_CACHE_TTL_MS) continue;
      if (!best || key.length > best.len) best = { raw: val.raw, len: key.length };
    }
    return best?.raw ?? null;
  }, []);

  // Debounced search with a client cache + instant local narrowing.
  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const trimmed = value.trim();
      if (!trimmed) {
        setResults(null);
        setLoading(false);
        setSearchError(false);
        return;
      }
      setSearchError(false);
      const norm = trimmed.toLowerCase();
      const sig = filterSignature();

      // 1) Fresh exact cache hit → instant, no server round-trip at all.
      const exact = cacheRef.current.get(sig)?.get(norm);
      if (exact && Date.now() - exact.ts <= SEARCH_CACHE_TTL_MS) {
        requestIdRef.current++; // invalidate any pending stale response
        setResults(groupRaw(exact.raw));
        setLoading(false);
        return;
      }

      // 2) Prefix narrowing → instant first paint from a cached broader query,
      //    then revalidate against the server below.
      const prefixRaw = findFreshPrefixSuperset(sig, norm);
      if (prefixRaw) {
        setResults(groupRaw(prefixRaw.filter((it) => itemMatches(it, norm))));
        setLoading(false); // we already have results to show — no spinner
      } else {
        setLoading(true);
      }

      // 3) Revalidate against the server (source of truth). Debounced + guarded
      //    against stale responses via requestIdRef.
      debounceRef.current = setTimeout(async () => {
        const thisRequestId = ++requestIdRef.current;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          // Scope search results to the active profile filter (single source of
          // truth). The server filters when given profileIds; without this the
          // ⌘K search leaked every profile's records regardless of the filter.
          const filter = getProfileFilter();
          const params = new URLSearchParams({ q: trimmed });
          if (filter.mode === "selected" && filter.selectedIds.length > 0) {
            params.set("profileIds", filter.selectedIds.join(","));
          }
          const res = await apiRequest("GET", `/api/search?${params.toString()}`);
          // Discard if a newer request was fired
          if (thisRequestId !== requestIdRef.current) return;
          const raw: any[] = await res.json();
          // Cache the authoritative result under the filter it was fetched for,
          // evicting the oldest query in that filter's bucket if over capacity.
          let perFilter = cacheRef.current.get(sig);
          if (!perFilter) { perFilter = new Map(); cacheRef.current.set(sig, perFilter); }
          perFilter.set(norm, { raw, ts: Date.now() });
          if (perFilter.size > SEARCH_CACHE_MAX) {
            const oldestKey = perFilter.keys().next().value;
            if (oldestKey !== undefined) perFilter.delete(oldestKey);
          }
          setResults(groupRaw(raw));
        } catch (err: any) {
          // Don't clear results on abort, or when we already showed a locally
          // narrowed set (keep the instant results rather than flashing empty).
          // A real failure (timeout / 500) surfaces an explicit error state so
          // the user sees "search failed — retry" instead of a silent spinner
          // that reads as a hang, or an empty list that reads as "no data".
          if (err?.name !== "AbortError" && thisRequestId === requestIdRef.current && !prefixRaw) {
            setResults(null);
            setSearchError(true);
          }
        } finally {
          if (thisRequestId === requestIdRef.current) {
            setLoading(false);
          }
        }
      }, 300);
    },
    [findFreshPrefixSuperset]
  );

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(null);
      setLoading(false);
      setSearchError(false);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    }
  }, [open]);

  const handleSelect = useCallback(
    (path: string, searchTerm?: string) => {
      setOpen(false);
      if (searchTerm) {
        setRecentSearches((prev) => {
          const filtered = prev.filter((s) => s !== searchTerm);
          return [searchTerm, ...filtered].slice(0, 5);
        });
      }
      // A query-carrying target ("/trackers?tracker=<id>") must go through
      // hashNavigate: wouter's hash navigate hoists the query OUT of the hash
      // ("?tracker=x#/trackers"), which is not the URL we want people to copy.
      // Same rule the hub tab chips follow (see HubShell.tsx).
      if (path.includes("?")) hashNavigate(path);
      else navigate(path);
    },
    [navigate, setOpen]
  );

  // ── Helpers for subtitle text ──────────────────────────────────────────────
  const profileSubtitle = (p: Profile) => p.type ? `Type: ${p.type}` : "Profile";
  const trackerSubtitle = (t: Tracker) => t.category ?? "Tracker";
  const taskSubtitle = (t: Task) =>
    t.priority ? `Priority: ${t.priority}${t.completed ? " · Done" : ""}` : t.completed ? "Completed" : "Task";
  const expenseSubtitle = (e: Expense) =>
    e.amount != null ? `$${e.amount}${e.category ? ` · ${e.category}` : ""}` : e.category ?? "Expense";
  const eventSubtitle = (e: CalendarEvent) => {
    const when = e.startDate || e.date;
    return when ? (parseLocalDate(when)?.toLocaleDateString() ?? when) : e.category ?? "Event";
  };
  const documentSubtitle = (d: Document) =>
    [d.type, d.status].filter(Boolean).join(" · ") || "Document";
  const habitSubtitle = (h: Habit) =>
    h.currentStreak != null ? `${h.currentStreak} day streak` : h.frequency ?? "Habit";
  const journalSubtitle = (j: JournalEntry) =>
    j.date ? (parseLocalDate(j.date)?.toLocaleDateString() ?? j.date) : j.mood ?? "Journal Entry";
  const obligationSubtitle = (o: Obligation) =>
    o.amount != null ? `$${o.amount}${o.category ? ` · ${o.category}` : ""}` : o.category ?? "Obligation";
  const artifactSubtitle = (a: Artifact) => a.type ?? "Artifact";

  // ── Determine if any results exist ────────────────────────────────────────
  const hasResults =
    results &&
    Object.values(results).some((arr) => Array.isArray(arr) && arr.length > 0);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      aria-label="Global search"
    >
      <CommandInput
        placeholder="Search everything… (Esc to close)"
        value={query}
        onValueChange={handleQueryChange}
        data-testid="input-command-search"
        onKeyDown={(e) => {
          // QA Bug 10: when the search box is empty, single-letter shortcuts
          // (D / C / T / P / F / K / H / J / L / A / O / S / I) should jump to
          // the matching destination instead of being typed as a query.
          if (query.length === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
            const key = e.key.toUpperCase();
            const hit = QUICK_ACTIONS.find((a) => a.shortcut === key);
            if (hit) {
              e.preventDefault();
              e.stopPropagation();
              handleSelect(hit.path);
            }
          }
        }}
      />
      <CommandList className="max-h-[420px]">
        {/* QA Bug 6: render the spinner only while loading AND we don't yet
            have results. Previously the AnimatePresence exit animation kept
            it visible alongside "No results found". Also dropped from
            AnimatePresence wrapper so cmdk doesn't treat the motion.div as a
            command item and suppress CommandEmpty. */}
        {loading && !hasResults && (
          <div
            className="py-3 px-4 text-xs text-muted-foreground flex items-center gap-2"
            data-testid="status-search-loading"
          >
            <span className="inline-block h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            Searching…
          </div>
        )}

        {/* Error state — the request timed out or the server failed. Distinct
            from "No results" so a broken search never masquerades as empty data. */}
        {!loading && query.trim() && searchError && (
          <div className="flex flex-col items-center gap-2 py-4 px-4 text-center" data-testid="status-search-error">
            <Search className="h-8 w-8 text-muted-foreground/40" />
            <p className="font-medium text-sm">Search timed out</p>
            <p className="text-xs text-muted-foreground">Something went wrong — this didn’t load. Try again.</p>
            <button
              type="button"
              onClick={() => handleQueryChange(query)}
              className="mt-1 text-xs font-medium text-primary hover:underline"
              data-testid="button-search-retry"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state — when query present, not loading, no results, no error */}
        {!loading && query.trim() && !hasResults && !searchError && (
          <CommandEmpty data-testid="text-search-empty">
            <div className="flex flex-col items-center gap-1 py-2">
              <Search className="h-8 w-8 text-muted-foreground/40" />
              <p className="font-medium text-sm">No results found</p>
              <p className="text-xs text-muted-foreground">
                Try a different search term or check your spelling
              </p>
            </div>
          </CommandEmpty>
        )}

        {/* Search results */}
        {!loading && hasResults && results && (
          <>
            {results.profiles && results.profiles.length > 0 && (
              <CommandGroup heading="Profiles">
                {results.profiles.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((p) => (
                  <CommandItem
                    key={`profile-${p.id}`}
                    value={`profile-${p.id}-${p.name}`}
                    onSelect={() => handleSelect(`/profiles/${p.id}`, query)}
                    data-testid={`item-search-profile-${p.id}`}
                  >
                    <Users className="shrink-0 text-violet-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{p.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {profileSubtitle(p)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.trackers && results.trackers.length > 0 && (
              <CommandGroup heading="Trackers">
                {results.trackers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((t) => (
                  <CommandItem
                    key={`tracker-${t.id}`}
                    value={`tracker-${t.id}-${t.name}`}
                    onSelect={() => handleSelect(`/trackers?tracker=${t.id}`, query)}
                    data-testid={`item-search-tracker-${t.id}`}
                  >
                    <Activity className="shrink-0 text-emerald-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{t.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {trackerSubtitle(t)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.tasks && results.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {results.tasks.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).map((t) => (
                  <CommandItem
                    key={`task-${t.id}`}
                    value={`task-${t.id}-${t.title}`}
                    onSelect={() => handleSelect("/dashboard/tasks", query)}
                    data-testid={`item-search-task-${t.id}`}
                  >
                    <ListTodo className="shrink-0 text-blue-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{t.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {taskSubtitle(t)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.expenses && results.expenses.length > 0 && (
              <CommandGroup heading="Expenses">
                {results.expenses.slice().sort((a, b) => (a.description || '').localeCompare(b.description || '')).map((e) => (
                  <CommandItem
                    key={`expense-${e.id}`}
                    value={`expense-${e.id}-${e.description}`}
                    onSelect={() => handleSelect("/dashboard/finance", query)}
                    data-testid={`item-search-expense-${e.id}`}
                  >
                    <DollarSign className="shrink-0 text-amber-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{e.description}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {expenseSubtitle(e)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.events && results.events.length > 0 && (
              <CommandGroup heading="Events">
                {results.events.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).map((e) => (
                  <CommandItem
                    key={`event-${e.id}`}
                    value={`event-${e.id}-${e.title}`}
                    onSelect={() => handleSelect("/calendar", query)}
                    data-testid={`item-search-event-${e.id}`}
                  >
                    <Calendar className="shrink-0 text-sky-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{e.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {eventSubtitle(e)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.documents && results.documents.length > 0 && (
              <CommandGroup heading="Documents">
                {results.documents.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((d) => (
                  <CommandItem
                    key={`doc-${d.id}`}
                    value={`doc-${d.id}-${d.name}`}
                    onSelect={() => handleSelect(`/documents/${d.id}`, query)}
                    data-testid={`item-search-document-${d.id}`}
                  >
                    <FileText className="shrink-0 text-slate-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{d.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {documentSubtitle(d)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.habits && results.habits.length > 0 && (
              <CommandGroup heading="Habits">
                {results.habits.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((h) => (
                  <CommandItem
                    key={`habit-${h.id}`}
                    value={`habit-${h.id}-${h.name}`}
                    onSelect={() => handleSelect("/dashboard/habits", query)}
                    data-testid={`item-search-habit-${h.id}`}
                  >
                    <Flame className="shrink-0 text-orange-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{h.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {habitSubtitle(h)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.journal && results.journal.length > 0 && (
              <CommandGroup heading="Journal">
                {results.journal.slice().sort((a, b) => ((a.content || a.mood || '') as string).localeCompare((b.content || b.mood || '') as string)).map((j) => (
                  <CommandItem
                    key={`journal-${j.id}`}
                    value={`journal-${j.id}-${j.content ?? j.mood ?? j.date ?? j.id}`}
                    onSelect={() => handleSelect("/dashboard/journal", query)}
                    data-testid={`item-search-journal-${j.id}`}
                  >
                    <BookHeart className="shrink-0 text-rose-400" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm line-clamp-1">
                        {j.content ? j.content.slice(0, 60) + (j.content.length > 60 ? "…" : "") : "Journal Entry"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {journalSubtitle(j)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.obligations && results.obligations.length > 0 && (
              <CommandGroup heading="Bills">
                {results.obligations.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((o) => (
                  <CommandItem
                    key={`obligation-${o.id}`}
                    value={`obligation-${o.id}-${o.name}`}
                    onSelect={() => handleSelect("/dashboard/obligations", query)}
                    data-testid={`item-search-obligation-${o.id}`}
                  >
                    <CreditCard className="shrink-0 text-indigo-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{o.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {obligationSubtitle(o)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.artifacts && results.artifacts.length > 0 && (
              <CommandGroup heading="Artifacts">
                {results.artifacts.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).map((a) => (
                  <CommandItem
                    key={`artifact-${a.id}`}
                    value={`artifact-${a.id}-${a.title}`}
                    onSelect={() => handleSelect("/artifacts", query)}
                    data-testid={`item-search-artifact-${a.id}`}
                  >
                    <Package className="shrink-0 text-teal-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{a.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {artifactSubtitle(a)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {/* No-query state: recent searches + quick actions */}
        {!query.trim() && (
          <>
            {recentSearches.length > 0 && (
              <>
                <CommandGroup heading="Recent Searches">
                  {recentSearches.map((s, i) => (
                    <CommandItem
                      key={`recent-${i}`}
                      value={`recent-${i}-${s}`}
                      onSelect={() => handleQueryChange(s)}
                      data-testid={`item-recent-search-${i}`}
                    >
                      <Clock className="shrink-0 text-muted-foreground" />
                      <span className="text-sm">{s}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            <CommandGroup heading="Create">
              {CREATE_ACTIONS.map((action) => (
                <CommandItem
                  key={action.path}
                  value={`create-${action.label}`}
                  onSelect={() => handleSelect(action.path)}
                  data-testid={`item-create-${action.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <action.icon className={`shrink-0 ${action.color}`} />
                  <span className="text-sm">{action.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />

            <CommandGroup heading="Quick Actions">
              {QUICK_ACTIONS.map((action) => (
                <CommandItem
                  key={action.path}
                  value={`quick-${action.label}`}
                  onSelect={() => handleSelect(action.path)}
                  data-testid={`item-quick-action-${action.shortcut.toLowerCase()}`}
                >
                  <action.icon className="shrink-0 text-muted-foreground" />
                  <span className="text-sm">{action.label}</span>
                  <kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground opacity-100">
                    {action.shortcut}
                  </kbd>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

// ─── Header Search Button ──────────────────────────────────────────────────────

export function CommandSearchTrigger() {
  const { setOpen } = useCommandSearch();

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-background/60 hover:bg-accent hover:text-accent-foreground px-2 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="button-command-search-trigger"
      aria-label="Open search (⌘K)"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline text-xs">Search</span>
      <kbd className="hidden sm:inline-flex pointer-events-none h-4 select-none items-center gap-1 rounded border bg-muted px-1 font-mono text-xs font-medium text-muted-foreground">
        ⌘K
      </kbd>
    </button>
  );
}
