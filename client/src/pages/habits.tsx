import { formatApiError } from "@/lib/formatError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter, getFilterLabel } from "@/lib/profileFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import EditableTitle from "@/components/EditableTitle";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ToastAction } from "@/components/ui/toast";
import { Flame, Plus, Check, Trophy, Droplets, Brain, BookOpen, Smartphone, Zap, ArrowLeft, Trash2, AlertCircle } from "lucide-react";
import { Link } from "wouter";
import type { Habit } from "@shared/schema";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";

const ICON_MAP: Record<string, any> = { Droplets, Brain, BookOpen, Smartphone, Zap, Flame };

function HabitCard({ habit }: { habit: Habit }) {
  const { toast } = useToast();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayCheckins = habit.checkins.filter(c => c.date === today).length;
  const targetPerDay = (habit as any).targetPerDay || 1;
  const completedToday = todayCheckins >= targetPerDay;
  const Icon = ICON_MAP[habit.icon || ""] || Flame;
  const accentColor = habit.color || "#4F98A3";

  const checkinMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      const newCount = todayCheckins + 1;
      if (newCount >= targetPerDay) {
        toast({ title: `✨ ${habit.name} complete!`, description: targetPerDay > 1 ? `All ${targetPerDay} done for today.` : "Keep the streak going!" });
      } else {
        toast({ title: `${habit.name} — ${newCount} / ${targetPerDay}`, description: `${targetPerDay - newCount} more to go today` });
      }
    },
    onError: (err: Error) => toast({ title: `Failed to log ${habit.name}`, description: formatApiError(err), variant: "destructive" }),
  });

  const restoreMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/habits/${habit.id}/restore`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); toast({ title: `"${habit.name}" restored` }); },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/habits/${habit.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: `"${habit.name}" deleted`, action: <ToastAction altText="Undo" onClick={() => restoreMutation.mutate()}>Undo</ToastAction> });
    },
  });

  // 14-day grid
  const last14: { date: string; done: boolean; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dd = new Date(Date.now() - i * 86400000);
    const ds = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
    const count = habit.checkins.filter(c => c.date === ds).length;
    last14.push({ date: ds, done: count >= targetPerDay, count });
  }
  const completedDays = last14.filter(d => d.done).length;

  return (
    <div
      className={`relative rounded-xl border overflow-hidden transition-all ${
        completedToday ? "border-[--accent]/30 bg-[--accent]/5" : "border-border bg-card"
      }`}
      style={{ "--accent": accentColor } as any}
      data-testid={`card-habit-${habit.id}`}
    >
      {/* Accent top bar */}
      <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, ${accentColor}, ${accentColor}40)` }} />

      <div className="px-4 pt-3 pb-3">
        {/* Header row */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: accentColor + "22" }}>
              <Icon className="h-4 w-4" style={{ color: accentColor }} />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm leading-tight">
                <EditableTitle
                  value={habit.name}
                  onSave={async (n) => {
                    await apiRequest("PATCH", `/api/habits/${habit.id}`, { name: n });
                    queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
                    toast({ title: `Renamed to “${n}”` });
                  }}
                />
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {habit.currentStreak > 0 ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-orange-500">
                    <Flame className="h-3 w-3" />{habit.currentStreak}d
                  </span>
                ) : null}
                {habit.longestStreak > 0 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Trophy className="h-3 w-3" />Best {habit.longestStreak}d
                  </span>
                )}
                <span className="text-xs text-muted-foreground capitalize">{habit.frequency}{targetPerDay > 1 ? ` · ${targetPerDay}×` : ""}</span>
              </div>
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>Delete “{habit.name}”?</AlertDialogTitle><AlertDialogDescription>This habit and all its history will be removed.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => deleteMutation.mutate()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{deleteMutation.isPending ? "Deleting…" : "Delete"}</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* TODAY'S PROGRESS — segmented tap bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              {completedToday ? (
                <span className="font-semibold" style={{ color: accentColor }}>Done for today ✓</span>
              ) : todayCheckins > 0 ? (
                <span>{todayCheckins} / {targetPerDay} — {targetPerDay - todayCheckins} more to go</span>
              ) : (
                <span>Tap to check in</span>
              )}
            </span>
            {!completedToday && (
              <button
                onClick={() => checkinMutation.mutate()}
                disabled={checkinMutation.isPending}
                data-testid={`button-checkin-${habit.id}`}
                className="text-xs px-2.5 py-1 rounded-full font-medium transition-all active:scale-95 disabled:opacity-50"
                style={{ backgroundColor: accentColor + "22", color: accentColor, border: `1px solid ${accentColor}44` }}
              >
                {checkinMutation.isPending ? "…" : `+ Check In`}
              </button>
            )}
          </div>
          {/* Segmented bar — N segments for N required check-ins */}
          <div className="flex gap-1">
            {Array.from({ length: targetPerDay }).map((_, idx) => {
              const filled = idx < todayCheckins;
              return (
                <button
                  key={idx}
                  onClick={() => !filled && !checkinMutation.isPending && checkinMutation.mutate()}
                  disabled={filled || checkinMutation.isPending}
                  data-testid={`button-seg-${habit.id}-${idx}`}
                  className="flex-1 h-8 rounded-lg transition-all duration-200 active:scale-y-95 flex items-center justify-center relative overflow-hidden"
                  style={{
                    backgroundColor: filled ? accentColor : accentColor + "1a",
                    border: `1px solid ${filled ? accentColor : accentColor + "33"}`,
                  }}
                >
                  {filled && <Check className="h-4 w-4 text-white" strokeWidth={2.5} />}
                  {!filled && checkinMutation.isPending && idx === todayCheckins && (
                    <div className="h-3.5 w-3.5 rounded-full border-2 animate-spin" style={{ borderColor: accentColor + "80", borderTopColor: accentColor }} />
                  )}
                  {!filled && !checkinMutation.isPending && (
                    <span className="text-xs" style={{ color: accentColor + "99" }}>{idx + 1}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 14-day activity strip */}
        <div className="mt-5">
          <div className="flex gap-1 items-end h-4">
            {last14.map((day, i) => {
              const pct = targetPerDay > 0 ? Math.min(day.count / targetPerDay, 1) : 0;
              return (
                <div
                  key={i}
                  title={`${day.date}: ${day.done ? "done" : day.count > 0 ? `${day.count}/${targetPerDay}` : "—"}`}
                  className="flex-1 rounded-sm transition-all"
                  style={{
                    height: day.done ? "100%" : pct > 0 ? `${Math.round(pct * 60) + 40}%` : "25%",
                    backgroundColor: day.done ? accentColor : pct > 0 ? accentColor + "88" : "var(--muted)",
                    opacity: i === 13 ? 1 : 0.7 + (i / 13) * 0.3,
                  }}
                />
              );
            })}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-muted-foreground/50">14d ago</span>
            <span className="text-xs text-muted-foreground/70 font-medium">{completedDays}/14 days</span>
            <span className="text-xs text-muted-foreground/50">today</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HabitsPage() {
  useEffect(() => { document.title = "Habits — Portol"; }, []);
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const { mode: filterMode, selectedIds: filterIds } = getProfileFilter();
  const filterLabel = getFilterLabel();
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allHabits = [], isLoading, error, refetch } = useQuery<Habit[]>({
    queryKey: ["/api/habits", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/habits${profileParam}`).then(r => r.json()),
  });

  // Client-side profile filter
  const habits = filterMode === "selected" && filterIds.length > 0
    ? allHabits.filter(h => (h.linkedProfiles || []).some(id => filterIds.includes(id)))
    : allHabits;

  const handleCreate = () => {
    if (!newName.trim()) { toast({ title: "Name required", description: "Enter a habit name", variant: "destructive" }); return; }
    const duplicate = habits.find(h => h.name.toLowerCase() === newName.trim().toLowerCase());
    if (duplicate) {
      if (!confirm(`A habit named "${duplicate.name}" already exists. Create another?`)) return;
    }
    createMutation.mutate(newName.trim());
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/habits", { name, frequency: "daily" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] }); const saved = newName.trim(); setNewName(""); setShowCreate(false); toast({ title: `"${saved}" habit created`, description: "Check in daily to build your streak" }); },
    onError: (err: Error) => toast({ title: "Failed to create habit", description: formatApiError(err), variant: "destructive" }),
  });

  // Summary stats
  const todayD = new Date();
  const today = `${todayD.getFullYear()}-${String(todayD.getMonth() + 1).padStart(2, '0')}-${String(todayD.getDate()).padStart(2, '0')}`;
  const completedToday = habits.filter(h => {
    const tpd = (h as any).targetPerDay || 1;
    return h.checkins.filter(c => c.date === today).length >= tpd;
  }).length;
  const totalActive = habits.length;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back to Dashboard" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-lg font-semibold">Habits{filterMode === "selected" ? ` — ${filterLabel}` : ""}</h1>
          </div>
          <p className="text-xs text-muted-foreground">{completedToday}/{totalActive} completed today</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} data-testid="button-create-habit">
          <Plus className="h-3.5 w-3.5 mr-1" /> New Habit
        </Button>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: totalActive > 0 ? `${(completedToday / totalActive) * 100}%` : "0%",
            background: "linear-gradient(90deg, #01696F, #4F98A3)",
          }}
        />
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="p-3">
          <div className="flex gap-2">
            <Input
              placeholder="New habit name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleCreate()}
              data-testid="input-habit-name"
            />
            <Button
              size="sm"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={handleCreate}
              data-testid="button-save-habit"
            >
              Add
            </Button>
          </div>
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
      ) : habits.length === 0 ? (
        <div className="text-center py-12">
          <Flame className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">No habits yet</h3>
          <p className="text-xs text-muted-foreground mb-4">Start building positive routines by creating your first habit.</p>
          <Button size="sm" onClick={() => setShowCreate(true)} data-testid="button-create-habit-empty">
            <Plus className="h-3.5 w-3.5 mr-1" /> Create Your First Habit
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {habits.map(habit => (
            <HabitCard key={habit.id} habit={habit} />
          ))}
        </div>
      )}
    </div>
  );
}
