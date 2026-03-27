import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
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
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

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

// ─── Quick Actions ─────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: "Go to Dashboard", icon: LayoutDashboard, path: "/dashboard", shortcut: "D" },
  { label: "Go to Chat",      icon: MessageSquare,   path: "/",         shortcut: "C" },
  { label: "Go to Trackers",  icon: BarChart2,       path: "/trackers", shortcut: "T" },
  { label: "Go to Profiles",  icon: Users,           path: "/profiles", shortcut: "P" },
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
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  // Debounced search with stale-result protection
  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort();
      if (!value.trim()) {
        setResults(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      debounceRef.current = setTimeout(async () => {
        const thisRequestId = ++requestIdRef.current;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const res = await apiRequest("GET", `/api/search?q=${encodeURIComponent(value.trim())}`);
          // Discard if a newer request was fired
          if (thisRequestId !== requestIdRef.current) return;
          const raw: any[] = await res.json();
          // API returns flat array with _type field — group into SearchResults
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
            else if (t === "memory") (grouped as any).memories ??= [];
          }
          setResults(grouped);
        } catch (err: any) {
          // Don't clear results on abort
          if (err?.name !== "AbortError" && thisRequestId === requestIdRef.current) {
            setResults(null);
          }
        } finally {
          if (thisRequestId === requestIdRef.current) {
            setLoading(false);
          }
        }
      }, 300);
    },
    []
  );

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(null);
      setLoading(false);
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
      navigate(path);
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
  const eventSubtitle = (e: CalendarEvent) =>
    e.startDate ? new Date(e.startDate).toLocaleDateString() : e.category ?? "Event";
  const documentSubtitle = (d: Document) =>
    [d.type, d.status].filter(Boolean).join(" · ") || "Document";
  const habitSubtitle = (h: Habit) =>
    h.currentStreak != null ? `${h.currentStreak} day streak` : h.frequency ?? "Habit";
  const journalSubtitle = (j: JournalEntry) =>
    j.date ? new Date(j.date).toLocaleDateString() : j.mood ?? "Journal Entry";
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
      />
      <CommandList className="max-h-[420px]">
        {/* Loading indicator */}
        <AnimatePresence>
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="py-3 px-4 text-xs text-muted-foreground flex items-center gap-2"
              data-testid="status-search-loading"
            >
              <span className="inline-block h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Searching…
            </motion.div>
          )}
        </AnimatePresence>

        {/* Empty state — when query present, not loading, no results */}
        {!loading && query.trim() && !hasResults && (
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
                {results.profiles.map((p) => (
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
                {results.trackers.map((t) => (
                  <CommandItem
                    key={`tracker-${t.id}`}
                    value={`tracker-${t.id}-${t.name}`}
                    onSelect={() => handleSelect("/trackers", query)}
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
                {results.tasks.map((t) => (
                  <CommandItem
                    key={`task-${t.id}`}
                    value={`task-${t.id}-${t.title}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                {results.expenses.map((e) => (
                  <CommandItem
                    key={`expense-${e.id}`}
                    value={`expense-${e.id}-${e.description}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                {results.events.map((e) => (
                  <CommandItem
                    key={`event-${e.id}`}
                    value={`event-${e.id}-${e.title}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                {results.documents.map((d) => (
                  <CommandItem
                    key={`doc-${d.id}`}
                    value={`doc-${d.id}-${d.name}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                {results.habits.map((h) => (
                  <CommandItem
                    key={`habit-${h.id}`}
                    value={`habit-${h.id}-${h.name}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                {results.journal.map((j) => (
                  <CommandItem
                    key={`journal-${j.id}`}
                    value={`journal-${j.id}-${j.content ?? j.mood ?? j.date ?? j.id}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
              <CommandGroup heading="Obligations">
                {results.obligations.map((o) => (
                  <CommandItem
                    key={`obligation-${o.id}`}
                    value={`obligation-${o.id}-${o.name}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                {results.artifacts.map((a) => (
                  <CommandItem
                    key={`artifact-${a.id}`}
                    value={`artifact-${a.id}-${a.title}`}
                    onSelect={() => handleSelect("/dashboard", query)}
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
                  <kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
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
      <kbd className="hidden sm:inline-flex pointer-events-none h-4 select-none items-center gap-1 rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground">
        ⌘K
      </kbd>
    </button>
  );
}
