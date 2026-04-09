import { formatApiError } from "@/lib/formatError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter, getFilterLabel } from "@/lib/profileFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { BookHeart, Smile, Frown, Meh, Sparkles, Star, Zap, Plus, X, ArrowLeft, Trash2, AlertCircle } from "lucide-react";
import { Link } from "wouter";
import type { JournalEntry, MoodLevel } from "@shared/schema";
import { useState, useEffect } from "react";
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Journal entry deleted" });
    },
    onError: (err: Error) => toast({ title: "Failed to delete entry", description: formatApiError(err), variant: "destructive" }),
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
              <Badge variant="outline" className="text-xs h-5">
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

        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-border">
            {entry.tags.map((t, i) => (
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
  const [mood, setMood] = useState<MoodLevel | null>(null);
  const [content, setContent] = useState("");
  const [energy, setEnergy] = useState(3);
  const { mode: filterMode, selectedIds: filterIds } = getProfileFilter();
  const filterLabel = getFilterLabel();
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allEntries = [], isLoading, error, refetch } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/journal${profileParam}`).then(r => r.json()),
  });

  // Client-side profile filter (journal entries have linkedProfiles)
  const entries = filterMode === "selected" && filterIds.length > 0
    ? allEntries.filter(e => (e as any).linkedProfiles?.length > 0 ? (e as any).linkedProfiles.some((id: string) => filterIds.includes(id)) : false)
    : allEntries;

  const handleSaveJournal = () => {
    if (!mood) { toast({ title: "Select a mood", description: "Choose how you're feeling", variant: "destructive" }); return; }
    if (!content.trim()) { toast({ title: "Write something", description: "Journal entry cannot be empty", variant: "destructive" }); return; }
    createMutation.mutate({ mood, content, energy });
  };

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/journal", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      setMood(null); setContent(""); setEnergy(3); setShowCreate(false);
      toast({ title: "Journal entry saved", description: `Mood: ${mood}` });
    },
    onError: (err: Error) => toast({ title: "Failed to create journal entry", description: formatApiError(err), variant: "destructive" }),
  });

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
{filterMode === "selected" && filterLabel && (
            <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full">{filterLabel}</span>
          )}
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
            <div key={i} className="flex flex-col items-center gap-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${cfg ? cfg.bg : "bg-muted"}`}>
                <MIcon className="h-4 w-4" style={{ color: cfg?.color || "#797876" }} />
              </div>
              <span className="text-xs-tight text-muted-foreground">{dayLabel}</span>
            </div>
          );
        })}
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
                  <span className="text-xs">{cfg.label}</span>
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
        <div className="p-4 space-y-3">
          <div className="h-8 w-48 rounded skeleton-shimmer" />
          <div className="h-20 rounded skeleton-shimmer" />
          <div className="h-20 rounded skeleton-shimmer" />
        </div>
      ) : error ? (
        <div className="p-4 text-center">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-destructive">Failed to load data</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {entries.map(entry => (
            <JournalCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
