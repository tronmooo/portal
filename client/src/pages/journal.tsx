import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { BookHeart, Smile, Frown, Meh, Sparkles, Star, Zap, Plus, X, TrendingUp, BarChart2 } from "lucide-react";
import type { JournalEntry, MoodLevel } from "@shared/schema";
import { useState, useMemo } from "react";

const MOOD_CONFIG: Record<MoodLevel, { icon: any; label: string; color: string; bg: string }> = {
  amazing: { icon: Sparkles, label: "Amazing", color: "#6DAA45", bg: "bg-green-500/10" },
  good: { icon: Smile, label: "Good", color: "#4F98A3", bg: "bg-teal-500/10" },
  neutral: { icon: Meh, label: "Neutral", color: "#797876", bg: "bg-gray-500/10" },
  bad: { icon: Frown, label: "Bad", color: "#BB653B", bg: "bg-orange-500/10" },
  awful: { icon: Frown, label: "Awful", color: "#A13544", bg: "bg-red-500/10" },
};

const ENERGY_LABELS = ["", "Exhausted", "Low", "Normal", "High", "Energized"];

function JournalCard({ entry }: { entry: JournalEntry }) {
  const mood = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
  const MoodIcon = mood.icon;
  const dateObj = new Date(entry.createdAt);

  return (
    <Card data-testid={`card-journal-${entry.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg ${mood.bg}`}>
              <MoodIcon className="h-4 w-4" style={{ color: mood.color }} />
            </div>
            <div>
              <span className="text-sm font-medium" style={{ color: mood.color }}>{mood.label}</span>
              <p className="text-[10px] text-muted-foreground">
                {dateObj.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {entry.energy && (
              <Badge variant="outline" className="text-[10px] h-5">
                <Zap className="h-2.5 w-2.5 mr-0.5" />{ENERGY_LABELS[entry.energy]}
              </Badge>
            )}
          </div>
        </div>

        {entry.content && (
          <p className="text-sm text-foreground/80 mb-2 whitespace-pre-wrap">{entry.content}</p>
        )}

        {entry.highlights && entry.highlights.length > 0 && (
          <div className="mb-2">
            <p className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1"><Star className="h-2.5 w-2.5" /> Highlights</p>
            <div className="flex flex-wrap gap-1">
              {entry.highlights.map((h, i) => (
                <Badge key={i} variant="secondary" className="text-[10px]">{h}</Badge>
              ))}
            </div>
          </div>
        )}

        {entry.gratitude && entry.gratitude.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1"><BookHeart className="h-2.5 w-2.5" /> Gratitude</p>
            <div className="flex flex-wrap gap-1">
              {entry.gratitude.map((g, i) => (
                <Badge key={i} variant="outline" className="text-[10px]">{g}</Badge>
              ))}
            </div>
          </div>
        )}

        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-border">
            {entry.tags.map((t, i) => (
              <span key={i} className="text-[10px] text-muted-foreground">#{t}</span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const MOOD_SCORE: Record<MoodLevel, number> = { amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 };

function MoodAnalytics({ entries }: { entries: JournalEntry[] }) {
  const analytics = useMemo(() => {
    if (entries.length === 0) return null;

    // Mood distribution
    const dist: Record<MoodLevel, number> = { amazing: 0, good: 0, neutral: 0, bad: 0, awful: 0 };
    let totalScore = 0;
    let totalEnergy = 0;
    let energyCount = 0;

    for (const e of entries) {
      dist[e.mood] = (dist[e.mood] || 0) + 1;
      totalScore += MOOD_SCORE[e.mood] || 3;
      if (e.energy) { totalEnergy += e.energy; energyCount++; }
    }

    const avgMood = totalScore / entries.length;
    const avgEnergy = energyCount > 0 ? totalEnergy / energyCount : 0;
    const maxMood = (Object.entries(dist) as [MoodLevel, number][]).sort((a, b) => b[1] - a[1])[0];

    // 30-day mood timeline
    const timeline: { date: string; score: number; mood?: MoodLevel }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dateStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const entry = entries.find(e => e.date === dateStr);
      timeline.push({
        date: dateStr,
        score: entry ? MOOD_SCORE[entry.mood] : 0,
        mood: entry?.mood,
      });
    }

    return { dist, avgMood, avgEnergy, maxMood, timeline, total: entries.length };
  }, [entries]);

  if (!analytics || analytics.total < 2) return null;

  const maxCount = Math.max(...Object.values(analytics.dist), 1);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {/* Mood Distribution */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            Mood Distribution
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3 space-y-2">
          {(Object.entries(MOOD_CONFIG) as [MoodLevel, typeof MOOD_CONFIG.amazing][]).map(([key, cfg]) => {
            const count = analytics.dist[key] || 0;
            const pct = analytics.total > 0 ? (count / analytics.total) * 100 : 0;
            return (
              <div key={key} className="flex items-center gap-2">
                <cfg.icon className="h-3.5 w-3.5 shrink-0" style={{ color: cfg.color }} />
                <span className="text-xs w-14 shrink-0">{cfg.label}</span>
                <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: cfg.color }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground w-6 text-right">{count}</span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Stats + 30-day timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            30-Day Mood Timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          <div className="flex items-end gap-[2px] h-16 mb-2">
            {analytics.timeline.map((day, i) => {
              const height = day.score > 0 ? `${(day.score / 5) * 100}%` : "4px";
              const cfg = day.mood ? MOOD_CONFIG[day.mood] : null;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-t-sm min-h-[4px] transition-all"
                  style={{
                    height,
                    backgroundColor: cfg?.color || "var(--color-muted)",
                    opacity: day.score > 0 ? 1 : 0.2,
                  }}
                  title={`${day.date}: ${day.mood || "no entry"}`}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>30d ago</span>
            <span>Today</span>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t">
            <div className="text-center">
              <p className="text-lg font-bold">{analytics.avgMood.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">Avg Mood</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold">{analytics.avgEnergy.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">Avg Energy</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold">{analytics.total}</p>
              <p className="text-[10px] text-muted-foreground">Entries</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function JournalPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [mood, setMood] = useState<MoodLevel | null>(null);
  const [content, setContent] = useState("");
  const [energy, setEnergy] = useState(3);

  const { data: entries = [], isLoading } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal"],
    queryFn: () => apiRequest("GET", "/api/journal").then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/journal", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      setMood(null); setContent(""); setEnergy(3); setShowCreate(false);
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
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Journal</h1>
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
              <span className="text-[9px] text-muted-foreground">{dayLabel}</span>
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
            placeholder="What's on your mind today?"
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={3}
            data-testid="input-journal-content"
          />

          <Button
            size="sm"
            disabled={!mood || createMutation.isPending}
            onClick={() => mood && createMutation.mutate({ mood, content, energy })}
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
      ) : (
        <>
          <MoodAnalytics entries={entries} />
          <div className="grid gap-3">
            {entries.map(entry => (
              <JournalCard key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
