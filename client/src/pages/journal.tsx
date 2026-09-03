import { formatLocalDate } from "@/lib/dates";
import { formatApiError } from "@/lib/formatError";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useQuery, useMutation } from "@tanstack/react-query";
import { invalidateDomain } from "@/lib/cache-bus";
import { queryClient, apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday, addDays as tzAddDays } from "@shared/timezone";
import { parseLocalDate } from "@/lib/format";
import { getFilterLabel } from "@/lib/profileFilter";
import { useProfileScope, useActiveCreateProfileId } from "@/hooks/useProfileScope";
import { passesProfileFilter } from "@shared/profile-filter";
import { useProfileFilterCtx } from "@/hooks/useProfileFilterCtx";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookHeart, BookOpen, Smile, Frown, Meh, Sparkles, Star, Zap, Plus, X, Trash2, AlertCircle, MessageCircle, Pencil, Search, PenLine } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";

// Journal is purple everywhere else in the app (the Info tab's Journal card,
// the Executive tab's entry row).
const JOURNAL_ACCENT = "262 70% 62%";
import { Link } from "wouter";
import type { JournalEntry, MoodLevel, Profile } from "@shared/schema";
import { detectMoodFromText } from "@shared/mood-detect";
import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";

const MOOD_CONFIG: Record<MoodLevel, { icon: any; label: string; color: string; bg: string }> = {
  amazing:   { icon: Sparkles, label: "Amazing",   color: "#6DAA45", bg: "bg-green-500/10" },
  great:     { icon: Smile,    label: "Great",     color: "#5BAA6A", bg: "bg-emerald-500/10" },
  good:      { icon: Smile,    label: "Good",      color: "#4F98A3", bg: "bg-teal-500/10" },
  okay:      { icon: Meh,      label: "Okay",      color: "#8A8A7A", bg: "bg-gray-400/10" },
  neutral:   { icon: Meh,      label: "Neutral",   color: "#797876", bg: "bg-gray-500/10" },
  bad:       { icon: Frown,    label: "Bad",       color: "#BB653B", bg: "bg-orange-500/10" },
  awful:     { icon: Frown,    label: "Awful",     color: "#A13544", bg: "bg-red-500/10" },
  terrible:  { icon: Frown,    label: "Terrible",  color: "#8B1A2B", bg: "bg-red-600/10" },
};

const ENERGY_LABELS = ["", "Exhausted", "Low", "Normal", "High", "Energized"];

function JournalCard({ entry, onEdit }: { entry: JournalEntry; onEdit: (e: JournalEntry) => void }) {
  const { toast } = useToast();
  const mood = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
  const MoodIcon = mood.icon;
  const dateObj = new Date(entry.createdAt);

  const deleteMutation = useMutation<any,Error,void>({
    mutationFn: () => apiRequest("DELETE", `/api/journal/${entry.id}`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/journal"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/journal"] });
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/journal"] }, (old) =>
        (old || []).filter((e: any) => e.id !== entry.id)
      );
      return { prev };
    },
    onSuccess: () => {
      toast({ title: "Journal entry deleted" });
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to delete entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // One bus call instead of three direct invalidations: the "journal"
      // domain already expands to stats and the dashboard aggregates, and the
      // bus drops this call when the response's write manifest just did the
      // same work (otherwise every save refetched the journal list twice).
      invalidateDomain("journal");
    },
  });

  return (
    <Card data-testid={`card-journal-${entry.id}`} className="overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${mood.bg}`}>
              <MoodIcon className="h-5 w-5" style={{ color: mood.color }} />
            </div>
            <div>
              <span className="text-base font-semibold" style={{ color: mood.color }}>{mood.label}</span>
              <p className="text-xs text-muted-foreground">
                {dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                {" · "}{dateObj.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {entry.energy && (
              <Badge variant="outline" className="text-xs h-5">
                <Zap className="h-2.5 w-2.5 mr-0.5" />{ENERGY_LABELS[entry.energy]}
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
              aria-label="Edit journal entry"
              onClick={() => onEdit(entry)}
              data-testid={`button-edit-journal-${entry.id}`}
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  aria-label="Delete journal entry"
                  data-testid={`button-delete-journal-${entry.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this journal entry?</AlertDialogTitle>
                  <AlertDialogDescription>This will permanently remove this entry. This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? "Deleting..." : "Delete"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {entry.content && (
          <p className="text-base leading-relaxed text-foreground/90 mb-3 whitespace-pre-wrap">{entry.content}</p>
        )}

        {entry.highlights && entry.highlights.length > 0 && (
          <div className="mb-2">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Star className="h-2.5 w-2.5" /> Highlights</p>
            <div className="flex flex-wrap gap-1">
              {entry.highlights.map((h, i) => (
                <Badge key={i} variant="secondary" className="text-xs">{h}</Badge>
              ))}
            </div>
          </div>
        )}

        {entry.gratitude && entry.gratitude.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><BookHeart className="h-2.5 w-2.5" /> Gratitude</p>
            <div className="flex flex-wrap gap-1">
              {entry.gratitude.map((g, i) => (
                <Badge key={i} variant="outline" className="text-xs">{g}</Badge>
              ))}
            </div>
          </div>
        )}

        {(entry.tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-border">
            {(entry.tags ?? []).map((t, i) => (
              <span key={i} className="text-xs text-muted-foreground">#{t}</span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function JournalPage() {
  useEffect(() => { document.title = "Journal — Portol"; }, []);
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  // QA Bug 7 + user report 2026-07-16 ("Write entry doesn't let me write"):
  // ?new=1 opens the FREE-WRITE composer (a plain text box), not the
  // mood-gated guided template, and the check re-fires on hash changes so a
  // second tap on "Write entry" works even when the page is already mounted.
  useEffect(() => {
    const check = () => {
      const hash = window.location.hash || "";
      const q = hash.includes("?") ? hash.split("?")[1] : "";
      if (q && new URLSearchParams(q).get("new") === "1") {
        setEntryMode("free");
        setShowCreate(true);
        const cleaned = hash.split("?")[0];
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
      }
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [moodFilter, setMoodFilter] = useState<MoodLevel | "all">("all");
  const [mood, setMood] = useState<MoodLevel | null>(null);
  const [energy, setEnergy] = useState(3);
  const [grateful1, setGrateful1] = useState("");
  const [grateful2, setGrateful2] = useState("");
  const [grateful3, setGrateful3] = useState("");
  const [makeAmazing, setMakeAmazing] = useState("");
  const [affirmation, setAffirmation] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  // ── Free-form mode (user request): write as much or as little as you want.
  // Autosaves as a draft entry (POST once, then PATCH), shows a "Saved" stamp,
  // supports tags, and old free-form entries reopen here for editing.
  const [entryMode, setEntryMode] = useState<"guided" | "free">("guided");
  const [freeText, setFreeText] = useState("");
  const [freeTags, setFreeTags] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const freeSavingRef = useRef(false);

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Default a new entry's profile to the ACTIVE scope (the profile the user is
  // working in), not unconditionally "me".
  const activeCreateProfileId = useActiveCreateProfileId(profiles);
  useEffect(() => {
    if (activeCreateProfileId && !selectedProfileId) setSelectedProfileId(activeCreateProfileId);
  }, [activeCreateProfileId]);

  // Reactive read of the active profile scope (single source of truth) so this
  // page re-renders the instant the selection changes anywhere in the app.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  // Co-ownership widens a person's scope to the assets they co-own (shared/profile-filter).
  const scopeCtx = useProfileFilterCtx(filterIds, profiles);
  const filterLabel = getFilterLabel();
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allEntries = [], isLoading, error, refetch } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/journal${profileParam}`).then(r => r.json()),
  });

  // Client-side profile filter (journal entries have linkedProfiles)
  // Uses unified passesProfileFilter: orphan entries (empty linkedProfiles)
  // only show when the active selection includes a self profile — otherwise
  // they leak into brand-new profiles (e.g. EMPTYPROBE_QA showed a phantom "1" badge).
  const entries = filterMode === "selected" && filterIds.length > 0
    ? allEntries.filter(e =>
        passesProfileFilter((e as any).linkedProfiles, scopeCtx)
      )
    : allEntries;

  const resetForm = () => {
    setMood(null); setEnergy(3);
    setGrateful1(""); setGrateful2(""); setGrateful3("");
    setMakeAmazing(""); setAffirmation("");
    setSelectedProfileId(activeCreateProfileId || "");
    setEditingEntry(null);
    setFreeText(""); setFreeTags(""); setDraftId(null); setLastSavedAt(null);
  };

  // Free-write save: POST once, then PATCH the same entry. `finalize` closes
  // the form. Used by both the debounced autosave and the Save button.
  const saveFreeEntry = async (finalize = false) => {
    if (!freeText.trim() || freeSavingRef.current) {
      if (finalize && !freeText.trim()) toast({ title: "Write something first", variant: "destructive" });
      // The Save button used to do nothing while the debounced autosave was
      // in flight; say so instead of looking dead.
      else if (finalize) toast({ title: "Still saving…", description: "Try again in a moment." });
      return;
    }
    freeSavingRef.current = true;
    try {
      const tags = freeTags.split(",").map((s) => s.trim()).filter(Boolean);
      if (draftId) {
        await apiRequest("PATCH", `/api/journal/${draftId}`, { content: freeText, tags, mood: mood || detectMoodFromText(freeText) });
      } else {
        const r = await apiRequest("POST", "/api/journal", {
          content: freeText,
          // Mood auto-detection (user request): no manual pick needed — the
          // shared detector stamps the mood from what was written.
          mood: mood || detectMoodFromText(freeText),
          tags,
          ...(selectedProfileId ? { linkedProfiles: [selectedProfileId] } : {}),
        });
        const j = await r.json();
        if (j?.id) setDraftId(j.id);
      }
      setLastSavedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      invalidateDomain("journal");
      if (finalize) {
        toast({ title: draftId ? "Entry updated" : "Entry saved" });
        resetForm();
        setShowCreate(false);
      }
    } catch (err: any) {
      if (finalize) toast({ title: "Couldn't save entry", description: formatApiError(err), variant: "destructive" });
    } finally {
      freeSavingRef.current = false;
    }
  };

  // Debounced autosave: 2s after the user stops typing in free-write mode.
  useEffect(() => {
    if (entryMode !== "free" || !showCreate || !freeText.trim()) return;
    const t = setTimeout(() => { void saveFreeEntry(false); }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeText, freeTags, entryMode, showCreate]);

  const STRUCTURED_MARKERS = ["I AM GRATEFUL FOR:", "HOW I CAN MAKE TODAY AMAZING:", "DAILY AFFIRMATION:"];

  const handleEditEntry = (entry: JournalEntry) => {
    const raw = entry.content || "";
    // Free-form entries (no template markers) reopen in the free-write editor
    // so long text is edited where it was written.
    if (raw.trim() && !STRUCTURED_MARKERS.some((m) => raw.includes(m))) {
      setEditingEntry(entry);
      setEntryMode("free");
      setFreeText(raw);
      setFreeTags(((entry as any).tags || []).join(", "));
      setDraftId(entry.id);
      setMood(entry.mood);
      setShowCreate(true);
      return;
    }
    // Parse content back into form fields
    setEditingEntry(entry);
    setEntryMode("guided");
    setMood(entry.mood);
    setEnergy(entry.energy || 3);
    const content = entry.content || "";
    // Try to parse structured content
    const gratMatch = content.match(/I AM GRATEFUL FOR:\n([\s\S]*?)(?=\n\n|$)/);
    const amazingMatch = content.match(/HOW I CAN MAKE TODAY AMAZING:\n([\s\S]*?)(?=\n\n|$)/);
    const affirmMatch = content.match(/DAILY AFFIRMATION:\n([\s\S]*?)(?=\n\n|$)/);
    if (gratMatch) {
      const lines = gratMatch[1].split('\n').map(l => l.replace(/^[•\-]\s*/, '').trim()).filter(Boolean);
      setGrateful1(lines[0] || ""); setGrateful2(lines[1] || ""); setGrateful3(lines[2] || "");
    } else {
      setGrateful1(""); setGrateful2(""); setGrateful3("");
    }
    setMakeAmazing(amazingMatch ? amazingMatch[1].trim() : "");
    setAffirmation(affirmMatch ? affirmMatch[1].trim() : "");
    // If content doesn't match structured format, put it all in makeAmazing
    if (!gratMatch && !amazingMatch && !affirmMatch && content.trim()) {
      setMakeAmazing(content);
    }
    setShowCreate(true);
  };

  const handleSaveJournal = () => {
    const hasContent = grateful1.trim() || grateful2.trim() || grateful3.trim() || makeAmazing.trim() || affirmation.trim();
    if (!hasContent) { toast({ title: "Write something", description: "Fill in at least one section", variant: "destructive" }); return; }
    // Mood never blocks a save — when not picked, detect it from the text.
    const effectiveMood = mood || detectMoodFromText([grateful1, grateful2, grateful3, makeAmazing, affirmation].join(" "));
    const parts: string[] = [];
    const gratitudeLines = [grateful1, grateful2, grateful3].filter(g => g.trim());
    if (gratitudeLines.length > 0) parts.push(`I AM GRATEFUL FOR:\n${gratitudeLines.map(g => `• ${g}`).join('\n')}`);
    if (makeAmazing.trim()) parts.push(`HOW I CAN MAKE TODAY AMAZING:\n${makeAmazing}`);
    if (affirmation.trim()) parts.push(`DAILY AFFIRMATION:\n${affirmation}`);
    const content = parts.join('\n\n');
    if (editingEntry) {
      editMutation.mutate({ mood: effectiveMood, content, energy });
    } else {
      createMutation.mutate({
        mood: effectiveMood, content, energy,
        ...(selectedProfileId ? { linkedProfiles: [selectedProfileId] } : {}),
      });
    }
  };

  const editMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/journal/${editingEntry!.id}`, data),
    onMutate: async (data: any) => {
      // Optimistic update: patch the entry in any cached journal list immediately
      await queryClient.cancelQueries({ queryKey: ["/api/journal"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/journal"] });
      const targetId = editingEntry?.id;
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/journal"] }, (old) =>
        (old || []).map((e: any) => (e.id === targetId ? { ...e, ...data } : e))
      );
      return { prev };
    },
    onSuccess: () => {
      resetForm();
      setShowCreate(false);
      toast({ title: "Journal entry updated" });
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to update journal entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // One bus call instead of three direct invalidations: the "journal"
      // domain already expands to stats and the dashboard aggregates, and the
      // bus drops this call when the response's write manifest just did the
      // same work (otherwise every save refetched the journal list twice).
      invalidateDomain("journal");
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/journal", data),
    onMutate: async (data: any) => {
      await queryClient.cancelQueries({ queryKey: ["/api/journal"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/journal"] });
      const tempEntry = {
        id: 'temp-' + Date.now(),
        content: data.content,
        mood: data.mood,
        energy: data.energy,
        date: new Date().toLocaleDateString('en-CA'),
        createdAt: new Date().toISOString(),
        tags: [],
        highlights: [],
        gratitude: [],
      };
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/journal"] }, (old) =>
        [tempEntry, ...(old || [])]
      );
      return { prev };
    },
    onSuccess: () => {
      resetForm();
      setShowCreate(false);
      toast({ title: "Journal entry saved", description: `Mood: ${mood}` });
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to create journal entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // One bus call instead of three direct invalidations: the "journal"
      // domain already expands to stats and the dashboard aggregates, and the
      // bus drops this call when the response's write manifest just did the
      // same work (otherwise every save refetched the journal list twice).
      invalidateDomain("journal");
    },
  });

  // 7-day mood strip
  const last7: { date: string; mood?: MoodLevel }[] = [];
  // Entry dates are written in the browser's zone (en-CA), so walk back from
  // the same "today" — the UTC slice left today's dot dark after ~5 PM Pacific.
  const todayLocal = getUserToday(BROWSER_TIMEZONE);
  for (let i = 6; i >= 0; i--) {
    const dateStr = tzAddDays(todayLocal, -i);
    const entry = entries.find(e => e.date === dateStr);
    last7.push({ date: dateStr, mood: entry?.mood });
  }

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Journal"
        subtitle={filterMode === "selected" && filterLabel
          ? `${entries.length} entries · ${filterLabel}`
          : `${entries.length} entries`}
        icon={BookOpen}
        accent={JOURNAL_ACCENT}
        backHref="/dashboard"
        actions={
          <Button size="sm" onClick={() => { if (showCreate) { resetForm(); } setShowCreate(!showCreate); }} data-testid="button-new-journal">
            {showCreate ? <><X className="h-3.5 w-3.5 mr-1" /> Cancel</> : <><Plus className="h-3.5 w-3.5 mr-1" /> New Entry</>}
          </Button>
        }
      />

      {/* 7-day mood strip */}
      <div className="flex gap-2 justify-center">
        {last7.map((day, i) => {
          const cfg = day.mood ? MOOD_CONFIG[day.mood] : null;
          const MIcon = cfg?.icon || Meh;
          const dayLabel = (parseLocalDate(day.date) ?? new Date()).toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2);
          return (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${cfg ? cfg.bg : "bg-muted"}`}>
                <MIcon className="h-4 w-4" style={{ color: cfg?.color || "#797876" }} />
              </div>
              <span className="text-xs-tight text-muted-foreground">{dayLabel}</span>
            </div>
          );
        })}
      </div>

      {/* Create form — guided 5-minute template OR free-form editor */}
      {showCreate && (
        <div className="space-y-3">
          {/* Date header */}
          <div className="text-center py-1">
            <p className="text-[11px] font-bold tracking-[0.2em] text-muted-foreground uppercase">
              {editingEntry ? "Edit Journal Entry" : entryMode === "free" ? "Journal — Free Write" : "5 Minute Morning Journal"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              {" · "}{new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </p>
          </div>

          {/* Mode toggle (hidden while editing — the entry keeps its own format) */}
          {!editingEntry && (
            <div className="flex rounded-xl bg-muted/50 p-1 max-w-xs mx-auto">
              {([["guided", "Guided"], ["free", "Free write"]] as const).map(([key, label]) => (
                <button key={key} onClick={() => setEntryMode(key)}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors ${entryMode === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  data-testid={`btn-journal-mode-${key}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {entryMode === "free" ? (
            <>
              {/* Free-form editor: no limits, autosaves 2s after you stop typing */}
              <Card className="overflow-hidden">
                <div className="px-4 pt-4 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase flex items-center gap-1.5"><PenLine className="h-3 w-3" /> Write freely</p>
                    <span className="text-[11px] text-muted-foreground" data-testid="journal-autosave-stamp">
                      {freeSavingRef.current ? "Saving…" : lastSavedAt ? `Saved ${lastSavedAt}` : "Autosaves as you write"}
                    </span>
                  </div>
                  <textarea
                    value={freeText}
                    autoFocus
                    onChange={(e) => setFreeText(e.target.value)}
                    placeholder="Whatever is on your mind — no length limits."
                    rows={12}
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/35 resize-y text-foreground leading-relaxed min-h-[220px]"
                    data-testid="input-journal-free-text"
                  />
                  {/* Live mood detection: shows what will be stamped, tap to override. */}
                  {freeText.trim() && (() => {
                    const detected = mood || detectMoodFromText(freeText);
                    const cfg = MOOD_CONFIG[detected] || MOOD_CONFIG.neutral;
                    const DIcon = cfg.icon;
                    return (
                      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="journal-detected-mood">
                        <DIcon className="h-3.5 w-3.5" style={{ color: cfg.color }} />
                        <span>{mood ? "Mood" : "Detected mood"}: <span className="font-medium" style={{ color: cfg.color }}>{cfg.label}</span></span>
                        <div className="flex gap-1 ml-1">
                          {(Object.keys(MOOD_CONFIG) as MoodLevel[]).map((m) => (
                            <button key={m} onClick={() => setMood(m)} title={MOOD_CONFIG[m].label}
                              className={`w-3.5 h-3.5 rounded-full border ${m === detected ? "ring-1 ring-offset-1 ring-offset-background" : "opacity-40 hover:opacity-100"}`}
                              style={{ background: MOOD_CONFIG[m].color, borderColor: MOOD_CONFIG[m].color }} />
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </Card>
              <Card className="overflow-hidden">
                <div className="px-4 pt-4 pb-4">
                  <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-2">Tags <span className="text-muted-foreground font-normal normal-case tracking-normal">(comma separated, optional)</span></p>
                  <input
                    type="text"
                    value={freeTags}
                    onChange={(e) => setFreeTags(e.target.value)}
                    placeholder="e.g. work, family, ideas"
                    className="w-full bg-transparent border-b border-border/60 text-sm py-1.5 outline-none focus:border-blue-500 transition-colors placeholder:text-muted-foreground/35 text-foreground"
                    data-testid="input-journal-free-tags"
                  />
                </div>
              </Card>
              {/* Profile + save */}
              <Card className="overflow-hidden">
                <div className="px-4 pt-4 pb-4">
                  <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">Profile</p>
                  <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                    <SelectTrigger className="w-full h-9 text-sm" data-testid="select-journal-free-profile">
                      <SelectValue placeholder="Select profile" />
                    </SelectTrigger>
                    <SelectContent>
                      {profiles.filter(p => ["self", "person", "pet"].includes(p.type)).map(p => (
                        <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </Card>
              <Button
                onClick={() => void saveFreeEntry(true)}
                disabled={!freeText.trim()}
                className="w-full h-11 text-sm font-semibold"
                data-testid="button-save-journal-free"
              >
                {editingEntry ? "Update Entry" : "Save Entry"}
              </Button>
            </>
          ) : (
            <>
          {/* Mood selector */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-4">
              <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">How Are You Feeling?</p>
              <div className="flex gap-1.5 flex-wrap justify-center">
                {(Object.entries(MOOD_CONFIG) as [MoodLevel, typeof MOOD_CONFIG.amazing][]).map(([key, cfg]) => {
                  const MIcon = cfg.icon;
                  return (
                    <button
                      key={key}
                      onClick={() => setMood(key)}
                      className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${
                        mood === key
                          ? "ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/30 scale-105"
                          : "opacity-50 hover:opacity-90 hover:bg-muted/50"
                      }`}
                      data-testid={`button-mood-${key}`}
                    >
                      <div className={`p-2 rounded-full ${cfg.bg}`}>
                        <MIcon className="h-4 w-4" style={{ color: cfg.color }} />
                      </div>
                      <span className="text-[11px] font-medium">{cfg.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Card>

          {/* Gratitude */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-5">
              <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-4">I Am Grateful For...</p>
              <div className="space-y-4">
                {[
                  { value: grateful1, onChange: setGrateful1, num: 1 },
                  { value: grateful2, onChange: setGrateful2, num: 2 },
                  { value: grateful3, onChange: setGrateful3, num: 3 },
                ].map(({ value, onChange, num }) => (
                  <div key={num} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground font-bold w-4 shrink-0 select-none">{num}.</span>
                    <input
                      type="text"
                      value={value}
                      onChange={e => onChange(e.target.value)}
                      placeholder={num === 1 ? "Someone or something that made you smile..." : num === 2 ? "A small win or moment of joy..." : "Something easy to overlook but valuable..."}
                      className="w-full bg-transparent border-b border-border/60 text-sm py-1.5 outline-none focus:border-blue-500 transition-colors placeholder:text-muted-foreground/35 text-foreground"
                      data-testid={`input-grateful-${num}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* How to make today amazing */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-5">
              <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-4">How Can I Make Today Amazing?</p>
              <textarea
                value={makeAmazing}
                onChange={e => setMakeAmazing(e.target.value)}
                placeholder="One thing that would make today great..."
                rows={3}
                className="w-full bg-transparent border-b border-border/60 text-sm py-1.5 outline-none focus:border-blue-500 transition-colors placeholder:text-muted-foreground/35 resize-none text-foreground leading-relaxed"
                data-testid="input-make-amazing"
              />
            </div>
          </Card>

          {/* Daily affirmation */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-5">
              <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-4">Daily Affirmation</p>
              <input
                type="text"
                value={affirmation}
                onChange={e => setAffirmation(e.target.value)}
                placeholder="I am capable, confident, and worthy of..."
                className="w-full bg-transparent border-b border-border/60 text-sm py-1.5 outline-none focus:border-blue-500 transition-colors placeholder:text-muted-foreground/35 text-foreground"
                data-testid="input-affirmation"
              />
            </div>
          </Card>

          {/* Energy level */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-4">
              <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">Energy Level</p>
              <div className="flex gap-1 items-center">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} type="button" onClick={() => setEnergy(n)} aria-label={`Set energy level to ${n} (${ENERGY_LABELS[n]})`} aria-pressed={energy >= n} className={`p-1 transition-colors ${energy >= n ? "text-yellow-500" : "text-muted-foreground/25 hover:text-muted-foreground/50"}`}>
                    <Zap className="h-5 w-5" fill={energy >= n ? "currentColor" : "none"} />
                  </button>
                ))}
                <span className="text-sm text-muted-foreground ml-2 font-medium">{ENERGY_LABELS[energy]}</span>
              </div>
            </div>
          </Card>

          {/* Profile selector */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-4">
              <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">Profile</p>
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger className="w-full h-9 text-sm" data-testid="select-journal-profile">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.filter(p => ["self", "person", "pet"].includes(p.type)).map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.type === "self" ? "Me" : p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Card>

          {/* Save */}
          <Button
            disabled={createMutation.isPending || editMutation.isPending}
            onClick={handleSaveJournal}
            className="w-full h-11 text-sm font-semibold"
            data-testid="button-save-journal"
          >
            {(createMutation.isPending || editMutation.isPending) ? "Saving..." : editingEntry ? "Update Entry" : "Save Morning Entry"}
          </Button>
            </>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="p-4 space-y-3">
          <Skeleton className="h-8 w-48 rounded-full" />
          <BubbleSkeletonGrid count={4} rows={2} height={140} className="grid-cols-1 sm:grid-cols-2" />
        </div>
      ) : error ? (
        <div className="p-4 text-center">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-destructive">Failed to load data</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState icon={MessageCircle} label="No journal entries yet" hint="Start your morning journal to track your mood and gratitude." />
      ) : (
        <div className="grid gap-4">
          {/* Search across content + tags */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search entries…"
              className="w-full bg-muted/40 border border-border rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground/50"
              data-testid="input-journal-search"
            />
          </div>
          {/* Mood filter chips (user request 2026-07-16: "filter and all that") */}
          <div className="flex gap-1.5 overflow-x-auto pb-1" data-testid="journal-mood-filter">
            <button onClick={() => setMoodFilter("all")}
              className={`px-2.5 py-1 rounded-full text-[11px] border shrink-0 ${moodFilter === "all" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted/40"}`}>
              All moods
            </button>
            {(Object.entries(MOOD_CONFIG) as [MoodLevel, typeof MOOD_CONFIG.amazing][]).map(([key, cfg]) => (
              <button key={key} onClick={() => setMoodFilter(moodFilter === key ? "all" : key)}
                className={`px-2.5 py-1 rounded-full text-[11px] border shrink-0 flex items-center gap-1 ${moodFilter === key ? "border-transparent text-white" : "border-border text-muted-foreground hover:bg-muted/40"}`}
                style={moodFilter === key ? { background: cfg.color } : undefined}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.color }} />{cfg.label}
              </button>
            ))}
          </div>
          {(() => {
            const q = searchQuery.trim().toLowerCase();
            let visible = q
              ? entries.filter((e: any) =>
                  (e.content || "").toLowerCase().includes(q) ||
                  (e.tags || []).some((t: string) => t.toLowerCase().includes(q)))
              : entries;
            if (moodFilter !== "all") visible = visible.filter((e: any) => e.mood === moodFilter);
            if (visible.length === 0) return <p className="text-sm text-muted-foreground text-center py-6">No entries match{q ? ` "${searchQuery}"` : ""}{moodFilter !== "all" ? ` · ${MOOD_CONFIG[moodFilter].label} mood` : ""}.</p>;
            // Group by calendar day so the list reads like a real journal.
            const groups: Array<{ day: string; items: any[] }> = [];
            for (const e of visible) {
              // createdAt is a timestamp; the `date` fallback is a bare YYYY-MM-DD,
              // which `new Date()` would file under the previous local day.
              const day = formatLocalDate(e.createdAt || e.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }, "en-US");
              const g = groups[groups.length - 1];
              if (g && g.day === day) g.items.push(e);
              else groups.push({ day, items: [e] });
            }
            return groups.map((g) => (
              <div key={g.day} className="space-y-3">
                <p className="micro-label text-muted-foreground pt-1">{g.day}</p>
                {g.items.map((entry) => (
                  <JournalCard key={entry.id} entry={entry} onEdit={handleEditEntry} />
                ))}
              </div>
            ));
          })()}
        </div>
      )}
    </PageContainer>
  );
}
