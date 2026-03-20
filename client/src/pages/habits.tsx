import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Flame, Plus, Check, Trophy, Droplets, Brain, BookOpen, Smartphone, Zap, TrendingUp, Target } from "lucide-react";
import type { Habit } from "@shared/schema";
import { useState, useMemo } from "react";

const ICON_MAP: Record<string, any> = { Droplets, Brain, BookOpen, Smartphone, Zap, Flame };

function HabitCard({ habit }: { habit: Habit }) {
  const today = new Date().toISOString().slice(0, 10);
  const checkedToday = habit.checkins.some(c => c.date === today);
  const Icon = ICON_MAP[habit.icon || ""] || Flame;

  const checkinMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); },
  });

  // Build last 14 days grid
  const last14: { date: string; done: boolean }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dateStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    last14.push({ date: dateStr, done: habit.checkins.some(c => c.date === dateStr) });
  }

  return (
    <Card className="relative overflow-hidden" data-testid={`card-habit-${habit.id}`}>
      <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: habit.color || "#4F98A3" }} />
      <CardHeader className="pb-2 pl-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4" style={{ color: habit.color || "#4F98A3" }} />
            <CardTitle className="text-sm font-medium">{habit.name}</CardTitle>
          </div>
          <Button
            size="sm"
            variant={checkedToday ? "secondary" : "default"}
            disabled={checkedToday || checkinMutation.isPending}
            onClick={() => checkinMutation.mutate()}
            className="h-7 text-xs"
            data-testid={`button-checkin-${habit.id}`}
          >
            {checkedToday ? <><Check className="h-3 w-3 mr-1" /> Done</> : "Check In"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pl-5 pb-3">
        {/* Streak badges */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-1">
            <Flame className="h-3.5 w-3.5 text-orange-500" />
            <span className="text-xs font-semibold">{habit.currentStreak}d streak</span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <Trophy className="h-3 w-3" />
            <span className="text-xs">Best: {habit.longestStreak}d</span>
          </div>
          <Badge variant="outline" className="text-[10px] h-5">{habit.frequency}</Badge>
        </div>

        {/* 14-day grid */}
        <div className="flex gap-1">
          {last14.map((day, i) => (
            <div
              key={i}
              className="w-5 h-5 rounded-sm flex items-center justify-center text-[8px]"
              style={{
                backgroundColor: day.done ? (habit.color || "#4F98A3") : "var(--color-muted)",
                opacity: day.done ? 1 : 0.3,
              }}
              title={`${day.date}${day.done ? " ✓" : ""}`}
            >
              {day.done && <Check className="h-2.5 w-2.5 text-white" />}
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
          <span>14 days ago</span>
          <span>Today</span>
        </div>
      </CardContent>
    </Card>
  );
}

function HeatmapGrid({ habits }: { habits: Habit[] }) {
  const heatmap = useMemo(() => {
    const days: { date: string; count: number; total: number }[] = [];
    for (let i = 89; i >= 0; i--) {
      const dateStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const count = habits.filter(h => h.checkins.some(c => c.date === dateStr)).length;
      days.push({ date: dateStr, count, total: habits.length });
    }
    return days;
  }, [habits]);

  if (habits.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          90-Day Overview
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="flex flex-wrap gap-[3px]">
          {heatmap.map((day, i) => {
            const ratio = day.total > 0 ? day.count / day.total : 0;
            const opacity = ratio === 0 ? 0.08 : 0.2 + ratio * 0.8;
            return (
              <div
                key={i}
                className="w-[10px] h-[10px] rounded-[2px]"
                style={{
                  backgroundColor: ratio > 0 ? "#01696F" : "currentColor",
                  opacity,
                }}
                title={`${day.date}: ${day.count}/${day.total} habits`}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1.5">
          <span>90 days ago</span>
          <span>Today</span>
        </div>
      </CardContent>
    </Card>
  );
}

function HabitStats({ habits }: { habits: Habit[] }) {
  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const last30 = new Set<string>();
    for (let i = 0; i < 30; i++) {
      last30.add(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }

    let totalCheckins30d = 0;
    let possibleCheckins30d = 0;
    let longestStreak = 0;
    let activeStreaks = 0;

    for (const habit of habits) {
      const checkinDates = new Set(habit.checkins.map(c => c.date));
      for (const d of last30) {
        possibleCheckins30d++;
        if (checkinDates.has(d)) totalCheckins30d++;
      }
      longestStreak = Math.max(longestStreak, habit.longestStreak || 0);
      if ((habit.currentStreak || 0) > 0) activeStreaks++;
    }

    const consistency = possibleCheckins30d > 0
      ? Math.round((totalCheckins30d / possibleCheckins30d) * 100)
      : 0;

    return { consistency, longestStreak, activeStreaks, totalCheckins30d };
  }, [habits]);

  if (habits.length === 0) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {[
        { label: "30d Consistency", value: `${stats.consistency}%`, icon: Target },
        { label: "Active Streaks", value: stats.activeStreaks, icon: Flame },
        { label: "Best Streak", value: `${stats.longestStreak}d`, icon: Trophy },
        { label: "Check-ins (30d)", value: stats.totalCheckins30d, icon: Check },
      ].map(({ label, value, icon: Icon }) => (
        <Card key={label} className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Icon className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wide">{label}</span>
          </div>
          <p className="text-lg font-bold">{value}</p>
        </Card>
      ))}
    </div>
  );
}

export default function HabitsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: habits = [], isLoading } = useQuery<Habit[]>({
    queryKey: ["/api/habits"],
    queryFn: () => apiRequest("GET", "/api/habits").then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/habits", { name, frequency: "daily" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); setNewName(""); setShowCreate(false); },
  });

  // Summary stats
  const today = new Date().toISOString().slice(0, 10);
  const completedToday = habits.filter(h => h.checkins.some(c => c.date === today)).length;
  const totalActive = habits.length;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Habits</h1>
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
              onKeyDown={e => e.key === "Enter" && newName.trim() && createMutation.mutate(newName.trim())}
              data-testid="input-habit-name"
            />
            <Button
              size="sm"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => newName.trim() && createMutation.mutate(newName.trim())}
              data-testid="button-save-habit"
            >
              Add
            </Button>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />)}
        </div>
      ) : (
        <>
          <HabitStats habits={habits} />
          <HeatmapGrid habits={habits} />
          <div className="grid gap-3">
            {habits.map(habit => (
              <HabitCard key={habit.id} habit={habit} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
