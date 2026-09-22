import { parseLocalDate, formatFullDate, formatMoney } from "@/lib/format";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { routeForSearchRow } from "@shared/entity-routes";
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
import { onCacheBust } from "@/lib/cache-bus";
import { itemMatches, rankResults, matchNote } from "@/lib/search-index";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Every /api/search row carries its canonical destination (Rule 23). */
interface Routed {
  href?: string;
  _type?: string;
}
interface Profile extends Routed {
  id: number;
  name: string;
  type?: string;
}
interface Tracker extends Routed {
  id: number;
  name: string;
  category?: string;
}
interface Task extends Routed {
  id: number;
  title: string;
  priority?: string;
  completed?: boolean;
}
interface Expense extends Routed {
  id: number;
  description: string;
  amount?: number | string;
  category?: string;
  date?: string;
  profileId?: string;
  linkedProfiles?: string[];
}
interface CalendarEvent extends Routed {
  id: number;
  title: string;
  startDate?: string;
  /** The API's event rows carry `date`; `startDate` is the calendar-adapter spelling. */
  date?: string;
  category?: string;
  /** True for a date derived from a profile's fields (no event row of its own). */
  virtual?: boolean;
}
interface Document extends Routed {
  id: number;
  name: string;
  type?: string;
  status?: string;
}
interface Habit extends Routed {
  id: number;
  name: string;
  frequency?: string;
  currentStreak?: number;
}
interface JournalEntry extends Routed {
  id: number;
  content?: string;
  mood?: string;
  date?: string;
  tags?: string[];
}
interface Obligation extends Routed {
  id: number;
  name: string;
  category?: string;
  amount?: number | string;
}
interface Artifact extends Routed {
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

export const QUICK_ACTIONS = [
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
  // Owner names for result rows come from the cached profile list — the
  // palette reads the ONE profiles slot rather than fetching its own.
  const queryClient = useQueryClient();
  const ownerName = (row: { profileId?: string; linkedProfiles?: string[] }): string => {
    const profiles = (queryClient.getQueryData<any[]>(["/api/profiles"]) || []);
    const id = row.profileId || (Array.isArray(row.linkedProfiles) ? row.linkedProfiles[0] : undefined);
    if (!id) return "";
    return profiles.find((p) => p?.id === id)?.name || "";
  };

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
  // Rule 17: this map is a cache of API data that lives outside React Query,
  // so no invalidateQueries() reaches it. Any domain bust (a write here, a
  // chat action, another tab) drops the whole map — the next keystroke asks
  // the server again instead of serving a renamed or deleted record for up
  // to SEARCH_CACHE_TTL_MS.
  useEffect(() => onCacheBust(() => { cacheRef.current = new Map(); }), []);

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
        setResults(groupRaw(rankResults(exact.raw, norm)));
        setLoading(false);
        return;
      }

      // 2) Prefix narrowing → instant first paint from a cached broader query,
      //    then revalidate against the server below.
      const prefixRaw = findFreshPrefixSuperset(sig, norm);
      if (prefixRaw) {
        setResults(groupRaw(rankResults(prefixRaw.filter((it) => itemMatches(it, norm)), norm)));
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
            // QA 2026-09-18 BUG-24: "birthday" found "Mom's Birthday" but not
            // "Dana's Birthday" because Dana's event sat outside the selected
            // scope, while the Profiles group beside it ignores scope. Ask the
            // server to KEEP out-of-scope rows, flagged `_outOfScope`, so every
            // record is findable by name; the renderer labels them and ranks
            // them below in-scope rows (see lib/search-index rankResults).
            params.set("includeOutOfScope", "1");
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
          setResults(groupRaw(rankResults(raw, norm)));
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

  // Reset on close AND on open: a keystroke that slipped in between — one
  // that landed in the input while the dialog was animating shut — must not
  // be the start of the next search; it used to survive into the next ⌘K,
  // which then opened pre-filled with "na" (F-49 / QA 2026-09-18 BUG-24).
  // The palette always starts empty.
  useEffect(() => {
    setQuery("");
    setResults(null);
    setLoading(false);
    setSearchError(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
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

  // ── Where a result lands ───────────────────────────────────────────────────
  // Every row lands on its RECORD (Rules 23/24): the server stamps each
  // /api/search row with its canonical `href` (shared/entity-routes), so a
  // loan opens /profiles/<id>, a task its card, an expense its row (F-52),
  // and a profile-derived birthday the profile that carries it. The resolver
  // is the fallback for a row from before the stamp.
  const target = (row: Routed & { id: unknown }, type: string): string => {
    const own = String(row.href || "").replace(/^#/, "");
    return own || routeForSearchRow({ ...row, _type: row._type || type }) || "/dashboard";
  };

  // ── Helpers for subtitle text ──────────────────────────────────────────────
  const profileSubtitle = (p: Profile) => p.type ? `Type: ${p.type}` : "Profile";
  const trackerSubtitle = (t: Tracker) => t.category ?? "Tracker";
  const taskSubtitle = (t: Task) =>
    t.priority ? `Priority: ${t.priority}${t.completed ? " · Done" : ""}` : t.completed ? "Completed" : "Task";
  // Three "Groceries" rows at $30 / $60 / $30 are only tellable apart by their
  // date, and — when the palette is showing everyone's records — by whose
  // they are (F-52). The amount goes through the shared money formatter.
  const expenseSubtitle = (e: Expense) => {
    const parts: string[] = [];
    if (e.amount != null) parts.push(formatMoney(Number(e.amount)));
    if (e.date) parts.push(formatFullDate(e.date));
    if (e.category) parts.push(e.category);
    if (filterSignature() === "all") {
      const who = ownerName(e);
      if (who) parts.push(who);
    }
    return parts.join(" · ") || "Expense";
  };
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
    o.amount != null ? `${formatMoney(Number(o.amount))}${o.category ? ` · ${o.category}` : ""}` : o.category ?? "Obligation";
  const artifactSubtitle = (a: Artifact) => a.type ?? "Artifact";
  // BUG-24: a row that matched on a secondary field, was link-related to a
  // match, or sits outside the current scope says so, so a result never
  // appears with no visible reason ("na" → Haircut, matched on category).
  const withNote = (row: any, subtitle: string) => {
    const note = matchNote(row);
    return note ? `${subtitle} · ${note}` : subtitle;
  };
  // Groups render in rank order (lib/search-index) — a name hit before a
  // category hit — rather than alphabetically.
  // Server rows may carry a `_score` (BUG-24 ranking); typed rows like
  // Obligation/Artifact don't declare it, so read it structurally.
  const byRank = <T,>(rows: T[]): T[] =>
    rows.slice().sort((a, b) => (Number((b as any)?._score) || 0) - (Number((a as any)?._score) || 0));

  // ── Determine if any results exist ────────────────────────────────────────
  const hasResults =
    results &&
    Object.values(results).some((arr) => Array.isArray(arr) && arr.length > 0);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      aria-label="Global search"
      // The server already matched (and the cache narrows with itemMatches);
      // cmdk's own fuzzy pass over "type-<uuid>-title" values must not get a
      // second vote on which rows survive (F-48).
      shouldFilter={false}
    >
      {/* Typing in the box only ever types. The old single-letter jumps
          (I → Insights, F → Finance, D → Dashboard, A → Artifacts…) fired on
          the first character of every search, so "insurance" navigated away
          on its "i" and "dana" went to the Dashboard on "d", then to
          Artifacts on "a", and never saw a result (F-49 / QA 2026-09-18
          BUG-24). A search box types; the letter shortcuts now live in
          KeyboardShortcuts.tsx, where they fire only with the palette closed
          and focus on the page itself (body/main). The quick actions below
          are still one arrow-key away when the box is empty. */}
      <CommandInput
        placeholder="Search everything… (Esc to close)"
        value={query}
        onValueChange={handleQueryChange}
        autoFocus
        data-testid="input-command-search"
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
                {byRank(results.profiles).map((p) => (
                  <CommandItem
                    key={`profile-${p.id}`}
                    value={`profile-${p.id}-${p.name}`}
                    onSelect={() => handleSelect(target(p, "profile"), query)}
                    data-testid={`item-search-profile-${p.id}`}
                  >
                    <Users className="shrink-0 text-violet-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{p.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(p, profileSubtitle(p))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.trackers && results.trackers.length > 0 && (
              <CommandGroup heading="Trackers">
                {byRank(results.trackers).map((t) => (
                  <CommandItem
                    key={`tracker-${t.id}`}
                    value={`tracker-${t.id}-${t.name}`}
                    onSelect={() => handleSelect(target(t, "tracker"), query)}
                    data-testid={`item-search-tracker-${t.id}`}
                  >
                    <Activity className="shrink-0 text-emerald-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{t.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(t, trackerSubtitle(t))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.tasks && results.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {byRank(results.tasks).map((t) => (
                  <CommandItem
                    key={`task-${t.id}`}
                    value={`task-${t.id}-${t.title}`}
                    onSelect={() => handleSelect(target(t, "task"), query)}
                    data-testid={`item-search-task-${t.id}`}
                  >
                    <ListTodo className="shrink-0 text-blue-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{t.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(t, taskSubtitle(t))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.expenses && results.expenses.length > 0 && (
              <CommandGroup heading="Expenses">
                {byRank(results.expenses).map((e) => (
                  <CommandItem
                    key={`expense-${e.id}`}
                    value={`expense-${e.id}-${e.description}`}
                    onSelect={() => handleSelect(target(e, "expense"), query)}
                    data-testid={`item-search-expense-${e.id}`}
                  >
                    <DollarSign className="shrink-0 text-amber-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{e.description}</span>
                      <span className="truncate text-xs text-muted-foreground" data-testid={`item-search-expense-${e.id}-meta`}>
                        {withNote(e, expenseSubtitle(e))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.events && results.events.length > 0 && (
              <CommandGroup heading="Events">
                {byRank(results.events).map((e) => (
                  <CommandItem
                    key={`event-${e.id}`}
                    value={`event-${e.id}-${e.title}`}
                    onSelect={() => handleSelect(target(e, "event"), query)}
                    data-testid={`item-search-event-${e.id}`}
                  >
                    <Calendar className="shrink-0 text-sky-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{e.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(e, eventSubtitle(e))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.documents && results.documents.length > 0 && (
              <CommandGroup heading="Documents">
                {byRank(results.documents).map((d) => (
                  <CommandItem
                    key={`doc-${d.id}`}
                    value={`doc-${d.id}-${d.name}`}
                    onSelect={() => handleSelect(target(d, "document"), query)}
                    data-testid={`item-search-document-${d.id}`}
                  >
                    <FileText className="shrink-0 text-slate-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{d.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(d, documentSubtitle(d))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.habits && results.habits.length > 0 && (
              <CommandGroup heading="Habits">
                {byRank(results.habits).map((h) => (
                  <CommandItem
                    key={`habit-${h.id}`}
                    value={`habit-${h.id}-${h.name}`}
                    onSelect={() => handleSelect(target(h, "habit"), query)}
                    data-testid={`item-search-habit-${h.id}`}
                  >
                    <Flame className="shrink-0 text-orange-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{h.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(h, habitSubtitle(h))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.journal && results.journal.length > 0 && (
              <CommandGroup heading="Journal">
                {byRank(results.journal).map((j) => (
                  <CommandItem
                    key={`journal-${j.id}`}
                    value={`journal-${j.id}-${j.content ?? j.mood ?? j.date ?? j.id}`}
                    onSelect={() => handleSelect(target(j, "journal"), query)}
                    data-testid={`item-search-journal-${j.id}`}
                  >
                    <BookHeart className="shrink-0 text-rose-400" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm line-clamp-1">
                        {j.content ? j.content.slice(0, 60) + (j.content.length > 60 ? "…" : "") : "Journal Entry"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(j, journalSubtitle(j))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.obligations && results.obligations.length > 0 && (
              <CommandGroup heading="Bills">
                {byRank(results.obligations).map((o) => (
                  <CommandItem
                    key={`obligation-${o.id}`}
                    value={`obligation-${o.id}-${o.name}`}
                    onSelect={() => handleSelect(target(o, "obligation"), query)}
                    data-testid={`item-search-obligation-${o.id}`}
                  >
                    <CreditCard className="shrink-0 text-indigo-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{o.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(o, obligationSubtitle(o))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.artifacts && results.artifacts.length > 0 && (
              <CommandGroup heading="Artifacts">
                {byRank(results.artifacts).map((a) => (
                  <CommandItem
                    key={`artifact-${a.id}`}
                    value={`artifact-${a.id}-${a.title}`}
                    onSelect={() => handleSelect(target(a, "artifact"), query)}
                    data-testid={`item-search-artifact-${a.id}`}
                  >
                    <Package className="shrink-0 text-teal-500" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-sm">{a.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {withNote(a, artifactSubtitle(a))}
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
