import { formatApiError } from "@/lib/formatError";
import { EmptyState } from "@/components/EmptyState";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookHeart, Smile, Frown, Meh, Sparkles, Star, Zap, Plus, X, ArrowLeft, Trash2, AlertCircle, MessageCircle, Pencil } from "lucide-react";
import { Link } from "wouter";
import type { JournalEntry, MoodLevel, Profile } from "@shared/schema";
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
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [mood, setMood] = useState<MoodLevel | null>(null);
  const [energy, setEnergy] = useState(3);
  const [grateful1, setGrateful1] = useState("");
  const [grateful2, setGrateful2] = useState("");
  const [grateful3, setGrateful3] = useState("");
  const [makeAmazing, setMakeAmazing] = useState("");
  const [affirmation, setAffirmation] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const selfProfile = profiles.find(p => p.type === "self");
  // Default to self profile once loaded
  useEffect(() => {
    if (selfProfile && !selectedProfileId) setSelectedProfileId(selfProfile.id);
  }, [selfProfile]);

  const { mode: filterMode, selectedIds: filterIds } = getProfileFilter();
  const filterLabel = getFilterLabel();
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allEntries = [], isLoading, error, refetch } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/journal${profileParam}`).then(r => r.json()),
  });

  // Client-side profile filter (journal entries have linkedProfiles)
  // Entries with empty linkedProfiles show for ALL profiles (backward compat)
  const entries = filterMode === "selected" && filterIds.length > 0
    ? allEntries.filter(e => {
        const lp = (e as any).linkedProfiles || [];
        return lp.length === 0 || lp.some((id: string) => filterIds.includes(id));
      })
    : allEntries;

  const resetForm = () => {
    setMood(null); setEnergy(3);
    setGrateful1(""); setGrateful2(""); setGrateful3("");
    setMakeAmazing(""); setAffirmation("");
    setSelectedProfileId(selfProfile?.id || "");
    setEditingEntry(null);
  };

  const handleEditEntry = (entry: JournalEntry) => {
    // Parse content back into form fields
    setEditingEntry(entry);
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
    if (!mood) { toast({ title: "Select a mood", description: "Choose how you're feeling", variant: "destructive" }); return; }
    const hasContent = grateful1.trim() || grateful2.trim() || grateful3.trim() || makeAmazing.trim() || affirmation.trim();
    if (!hasContent) { toast({ title: "Write something", description: "Fill in at least one section", variant: "destructive" }); return; }
    const parts: string[] = [];
    const gratitudeLines = [grateful1, grateful2, grateful3].filter(g => g.trim());
    if (gratitudeLines.length > 0) parts.push(`I AM GRATEFUL FOR:\n${gratitudeLines.map(g => `• ${g}`).join('\n')}`);
    if (makeAmazing.trim()) parts.push(`HOW I CAN MAKE TODAY AMAZING:\n${makeAmazing}`);
    if (affirmation.trim()) parts.push(`DAILY AFFIRMATION:\n${affirmation}`);
    const content = parts.join('\n\n');
    if (editingEntry) {
      editMutation.mutate({ mood, content, energy });
    } else {
      createMutation.mutate({
        mood, content, energy,
        ...(selectedProfileId ? { linkedProfiles: [selectedProfileId] } : {}),
      });
    }
  };

  const editMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/journal/${editingEntry!.id}`, data),
    onSuccess: () => {
      resetForm();
      setShowCreate(false);
      toast({ title: "Journal entry updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update journal entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
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
          <div className="flex items-center gap-3 mb-2">
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
        <Button size="sm" onClick={() => { if (showCreate) { resetForm(); } setShowCreate(!showCreate); }} data-testid="button-new-journal">
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

      {/* Create form — Sweet Setup 5-Minute AM template */}
      {showCreate && (
        <div className="space-y-3">
          {/* Date header */}
          <div className="text-center py-1">
            <p className="text-[11px] font-bold tracking-[0.2em] text-muted-foreground uppercase">{editingEntry ? "Edit Journal Entry" : "5 Minute Morning Journal"}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>

          {/* Mood selector */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-4">
              <p className="text-[10px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">How Are You Feeling?</p>
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
                      <span className="text-[10px] font-medium">{cfg.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Card>

          {/* Gratitude */}
          <Card className="overflow-hidden">
            <div className="px-4 pt-4 pb-5">
              <p className="text-[10px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-4">I Am Grateful For...</p>
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
              <p className="text-[10px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-4">How Can I Make Today Amazing?</p>
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
              <p className="text-[10px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-4">Daily Affirmation</p>
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
              <p className="text-[10px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">Energy Level</p>
              <div className="flex gap-1 items-center">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} onClick={() => setEnergy(n)} className={`p-1 transition-colors ${energy >= n ? "text-yellow-500" : "text-muted-foreground/25 hover:text-muted-foreground/50"}`}>
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
              <p className="text-[10px] font-bold tracking-[0.18em] text-blue-500 uppercase mb-3">Profile</p>
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
        </div>
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
      ) : entries.length === 0 ? (
        <EmptyState icon={MessageCircle} title="No journal entries yet" description="Start your morning journal to track your mood and gratitude." />
      ) : (
        <div className="grid gap-4">
          {entries.map(entry => (
            <JournalCard key={entry.id} entry={entry} onEdit={handleEditEntry} />
          ))}
        </div>
      )}
    </div>
  );
}
