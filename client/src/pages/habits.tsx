import { formatApiError } from "@/lib/formatError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getDashboardProfileFilter } from "@/lib/profileFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import EditableTitle from "@/components/EditableTitle";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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

  const checkinMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today });
      const updated = await apiRequest("GET", `/api/habits/${habit.id}`).then(r => r.json());
      return updated as typeof habit;
    },
    onSuccess: (updatedHabit) => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      const newCount = todayCheckins + 1;
      if (newCount >= targetPerDay) {
        const streak = updatedHabit?.currentStreak ?? habit.currentStreak;
        toast({ title: `${habit.name} — Done for today`, description: `Streak: ${streak} day${streak !== 1 ? "s" : ""}` });
      } else {
        toast({ title: `${habit.name} — ${newCount}/${targetPerDay}`, description: `${targetPerDay - newCount} more to go` });
      }
    },
    onError: (err: Error) => toast({ title: `Failed to check in ${habit.name}`, description: formatApiError(err), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/habits/${habit.id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); toast({ title: `"${habit.name}" deleted` }); },
    onError: (err: Error) => toast({ title: `Failed to delete "${habit.name}"`, description: formatApiError(err), variant: "destructive" }),
  });

  // Build last 14 days grid (multi-daily aware)
  const last14: { date: string; done: boolean; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dd = new Date(Date.now() - i * 86400000);
    const dateStr = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
    const count = habit.checkins.filter(c => c.date === dateStr).length;
    last14.push({ date: dateStr, done: count >= targetPerDay, count });
  }

  return (
    <Card className="relative overflow-hidden" data-testid={`card-habit-${habit.id}`}>
      <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: habit.color || "#4F98A3" }} />
      <CardHeader className="pb-2 pl-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4" style={{ color: habit.color || "#4F98A3" }} />
            <CardTitle className="text-sm font-medium">
              <EditableTitle
                value={habit.name}
                onSave={async (newName) => {
                  await apiRequest("PATCH", `/api/habits/${habit.id}`, { name: newName });
                  queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
                  toast({ title: `Renamed to "${newName}"` });
                }}
              />
            </CardTitle>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={completedToday ? "secondary" : "default"}
              disabled={completedToday || checkinMutation.isPending}
              onClick={() => checkinMutation.mutate()}
              className="h-7 text-xs"
              data-testid={`button-checkin-${habit.id}`}
            >
              {completedToday
                ? <><Check className="h-3 w-3 mr-1" /> Done</>
                : targetPerDay > 1
                  ? `${todayCheckins}/${targetPerDay}`
                  : "Check In"}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${habit.name}`}
                  data-testid={`button-delete-habit-${habit.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete "{habit.name}"?</AlertDialogTitle>
                  <AlertDialogDescription>This will permanently delete this habit and all its check-in history. This cannot be undone.</AlertDialogDescription>
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
      </CardHeader>
      <CardContent className="pl-5 pb-3">
        {/* Streak badges + progress */}
        <div className="flex items-center gap-3 mb-3">
          {habit.currentStreak > 0 ? (
            <div className="flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-orange-500" />
              <span className="text-xs font-semibold">{habit.currentStreak}d streak</span>
            </div>
          ) : todayCheckins > 0 && !completedToday ? (
            <div className="flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{todayCheckins}/{targetPerDay} today</span>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-muted-foreground/50" />
              <span className="text-xs text-muted-foreground">No streak yet</span>
            </div>
          )}
          {habit.longestStreak > 0 && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Trophy className="h-3 w-3" />
              <span className="text-xs">Best: {habit.longestStreak}d</span>
            </div>
          )}
          <Badge variant="outline" className="text-[10px] h-5">{habit.frequency}{targetPerDay > 1 ? ` ${targetPerDay}x` : ""}</Badge>
        </div>

        {/* 14-day grid */}
        <div className="flex gap-1">
          {last14.map((day, i) => {
            const partial = targetPerDay > 1 && day.count > 0 && !day.done;
            return (
              <div
                key={i}
                className="w-5 h-5 rounded-sm flex items-center justify-center text-[8px]"
                style={{
                  backgroundColor: day.done ? (habit.color || "#4F98A3") : partial ? (habit.color || "#4F98A3") : "var(--color-muted)",
                  opacity: day.done ? 1 : partial ? 0.5 : 0.3,
                }}
                title={`${day.date}${day.done ? " ✓" : day.count > 0 ? ` ${day.count}/${targetPerDay}` : ""}`}
              >
                {day.done ? <Check className="h-2.5 w-2.5 text-white" /> : partial ? <span className="text-white font-bold">{day.count}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
          <span>14 days ago</span>
          <span>Today</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function HabitsPage() {
  useEffect(() => { document.title = "Habits — Portol"; }, []);
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const { id: profileId, name: profileName } = getDashboardProfileFilter();
  const profileParam = profileId ? `?profileId=${profileId}` : "";

  const { data: habits = [], isLoading, error, refetch } = useQuery<Habit[]>({
    queryKey: ["/api/habits", profileId || "all"],
    queryFn: () => apiRequest("GET", `/api/habits${profileParam}`).then(r => r.json()),
  });

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
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); const saved = newName.trim(); setNewName(""); setShowCreate(false); toast({ title: `"${saved}" habit created`, description: "Check in daily to build your streak" }); },
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
            <h1 className="text-lg font-semibold">Habits{profileId ? ` — ${profileName}` : ""}</h1>
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
