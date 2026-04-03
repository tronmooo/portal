import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { BookHeart, Smile, Frown, Meh, Sparkles, Star, Zap, Plus, X, ArrowLeft, Trash2, Search, Filter } from "lucide-react";
import { Link } from "wouter";
import type { JournalEntry, MoodLevel } from "@shared/schema";
import { useState, useMemo } from "react";
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

function JournalCard({ entry }: { entry: JournalEntry }) {
  const { toast } = useToast();
  const mood = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
  const MoodIcon = mood.icon;
  const dateObj = new Date(entry.createdAt);

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/journal/${entry.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Entry deleted" });
    },
    onError: () => toast({ title: "Failed to delete entry", variant: "destructive" }),
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
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {entry.energy && (
              <Badge variant="outline" className="text-[10px] h-5">
                <Zap className="h-2.5 w-2.5 mr-0.5" />{ENERGY_LABELS[entry.energy]}
              </Badge>
            )}
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
            <p className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1"><Star className="h-2.5 w-2.5" /> Highlights</p>
            <div className="flex flex-wrap gap-1">
              {entry.highlights.map((h) => (
                <Badge key={h} variant="secondary" className="text-[10px]">{h}</Badge>
              ))}
            </div>
          </div>
        )}

        {entry.gratitude && entry.gratitude.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1"><BookHeart className="h-2.5 w-2.5" /> Gratitude</p>
            <div className="flex flex-wrap gap-1">
              {entry.gratitude.map((g) => (
                <Badge key={g} variant="outline" className="text-[10px]">{g}</Badge>
              ))}
            </div>
          </div>
        )}

        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-border">
            {entry.tags.map((t) => (
              <span key={t} className="text-[10px] text-muted-foreground">#{t}</span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function JournalPage() {
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [mood, setMood] = useState<MoodLevel | null>(null);
  const [content, setContent] = useState("");
  const [energy, setEnergy] = useState(3);

  const { data: entries = [], isLoading } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal"],
    queryFn: () => apiRequest("GET", "/api/journal").then(r => r.json()),
  });

  const handleSaveJournal = () => {
    if (!mood) { toast({ title: "Select a mood", description: "Choose how you're feeling", variant: "destructive" }); return; }
    if (!content.trim()) { toast({ title: "Write something", description: "Journal entry cannot be empty", variant: "destructive" }); return; }
    createMutation.mutate({ mood, content, energy });
  };

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/journal", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      setMood(null); setContent(""); setEnergy(3); setShowCreate(false);
    },
    onError: () => toast({ title: "Failed to create journal entry", variant: "destructive" }),
  });

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [moodFilter, setMoodFilter] = useState<MoodLevel | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Collect all unique tags
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    entries.forEach(e => e.tags?.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [entries]);

  // Filtered entries
  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (moodFilter !== "all" && e.mood !== moodFilter) return false;
      if (tagFilter && !(e.tags || []).includes(tagFilter)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchContent = e.content?.toLowerCase().includes(q);
        const matchTags = (e.tags || []).some(t => t.toLowerCase().includes(q));
        const matchHighlights = (e.highlights || []).some(h => h.toLowerCase().includes(q));
        const matchGratitude = (e.gratitude || []).some(g => g.toLowerCase().includes(q));
        if (!matchContent && !matchTags && !matchHighlights && !matchGratitude) return false;
      }
      return true;
    });
  }, [entries, moodFilter, tagFilter, searchQuery]);

  const hasActiveFilters = moodFilter !== "all" || tagFilter !== null || searchQuery.trim().length > 0;

  // 7-day mood strip
  const last7: { date: string; mood?: MoodLevel }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dateStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const entry = entries.find(e => e.date === dateStr);
    last7.push({ date: dateStr, mood: entry?.mood });
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-lg font-semibold">Journal</h1>
          </div>
          <p className="text-xs text-muted-foreground">{entries.length} entries</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} data-testid="button-new-journal">
          {showCreate ? <><X className="h-3.5 w-3.5 mr-1" /> Cancel</> : <><Plus className="h-3.5 w-3.5 mr-1" /> New Entry</>}
        </Button>
      </div>

      {/* 7-day mood strip */}
      <div className="flex gap-2 justify-center">
        {last7.map((day, i) => {
          const cfg = day.mood ? MOOD_CONFIG[day.mood] : null;
          const MIcon = cfg?.icon || Meh;
          const dayLabel = new Date(day.date).toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2);
          return (
            <div key={day.date} className="flex flex-col items-center gap-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${cfg ? cfg.bg : "bg-muted"}`}>
                <MIcon className="h-4 w-4" style={{ color: cfg?.color || "#797876" }} />
              </div>
              <span className="text-[9px] text-muted-foreground">{dayLabel}</span>
            </div>
          );
        })}
      </div>

      {/* Search & Filters */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search entries..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-sm"
              data-testid="input-journal-search"
            />
          </div>
          <Button
            size="sm"
            variant={showFilters ? "secondary" : "outline"}
            className="h-8 px-2.5"
            onClick={() => setShowFilters(v => !v)}
            data-testid="button-toggle-filters"
          >
            <Filter className="h-3.5 w-3.5 mr-1" />
            Filters
            {hasActiveFilters && <Badge variant="secondary" className="ml-1 h-4 w-4 p-0 text-[9px] rounded-full justify-center">!</Badge>}
          </Button>
          {hasActiveFilters && (
            <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground"
              onClick={() => { setMoodFilter("all"); setTagFilter(null); setSearchQuery(""); }}>
              Clear
            </Button>
          )}
        </div>
        {showFilters && (
          <div className="space-y-2 p-3 rounded-lg border border-border/50 bg-muted/30">
            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Filter by mood</p>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setMoodFilter("all")}
                  className={`text-[10px] px-2 py-1 rounded-full transition-colors ${moodFilter === "all" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"}`}
                >
                  All
                </button>
                {(Object.entries(MOOD_CONFIG) as [MoodLevel, typeof MOOD_CONFIG.amazing][]).map(([key, cfg]) => (
                  <button
                    key={key}
                    onClick={() => setMoodFilter(moodFilter === key ? "all" : key)}
                    className={`text-[10px] px-2 py-1 rounded-full flex items-center gap-1 transition-colors ${moodFilter === key ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"} ${cfg.bg}`}
                    data-testid={`filter-mood-${key}`}
                  >
                    <span style={{ color: cfg.color }}>{cfg.label}</span>
                  </button>
                ))}
              </div>
            </div>
            {allTags.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Filter by tag</p>
                <div className="flex flex-wrap gap-1">
                  {allTags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                      className={`text-[10px] px-2 py-1 rounded-full transition-colors ${tagFilter === tag ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80 text-muted-foreground"}`}
                      data-testid={`filter-tag-${tag}`}
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="p-4 space-y-3">
          <p className="text-xs font-medium">How are you feeling?</p>
          <div className="flex gap-2 justify-center">
            {(Object.entries(MOOD_CONFIG) as [MoodLevel, typeof MOOD_CONFIG.amazing][]).map(([key, cfg]) => {
              const MIcon = cfg.icon;
              return (
                <button
                  key={key}
                  onClick={() => setMood(key)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${mood === key ? "ring-2 ring-primary scale-105" : "opacity-60 hover:opacity-100"}`}
                  data-testid={`button-mood-${key}`}
                >
                  <div className={`p-2 rounded-full ${cfg.bg}`}>
                    <MIcon className="h-5 w-5" style={{ color: cfg.color }} />
                  </div>
                  <span className="text-[10px]">{cfg.label}</span>
                </button>
              );
            })}
          </div>

          <div>
            <p className="text-xs font-medium mb-1">Energy level</p>
            <div className="flex gap-1 items-center">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => setEnergy(n)} className={`p-1 ${energy >= n ? "text-yellow-500" : "text-muted-foreground/30"}`}>
                  <Zap className="h-4 w-4" fill={energy >= n ? "currentColor" : "none"} />
                </button>
              ))}
              <span className="text-xs text-muted-foreground ml-2">{ENERGY_LABELS[energy]}</span>
            </div>
          </div>

          <Textarea
            placeholder="What's on your mind today? Write as much as you want..."
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={12}
            className="min-h-[250px] text-base leading-relaxed resize-y"
            data-testid="input-journal-content"
          />

          <Button
            size="sm"
            disabled={createMutation.isPending}
            onClick={handleSaveJournal}
            className="w-full"
            data-testid="button-save-journal"
          >
            Save Entry
          </Button>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />)}
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="text-center py-12">
          <BookHeart className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters ? "No entries match your filters" : "No journal entries yet"}
          </p>
          {hasActiveFilters && (
            <Button size="sm" variant="outline" className="mt-2 text-xs"
              onClick={() => { setMoodFilter("all"); setTagFilter(null); setSearchQuery(""); }}>
              Clear Filters
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {hasActiveFilters && (
            <p className="text-[10px] text-muted-foreground">
              Showing {filteredEntries.length} of {entries.length} entries
            </p>
          )}
          {filteredEntries.map(entry => (
            <JournalCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
