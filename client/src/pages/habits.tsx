import { formatApiError } from "@/lib/formatError";
import { stopProp } from "@/lib/event-utils";
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
  // Auto-assign vivid colors from palette if no distinctive color set
  const VIVID_PALETTE = ['#E8545A','#E67E3B','#E8A838','#4BAE63','#2E9EBF','#7B68EE','#C2558B','#5B8FDB','#48C7A0','#D4628A'];
  const accentColor = (habit.color && habit.color !== '#4F98A3') ? habit.color : VIVID_PALETTE[habit.id.charCodeAt(0) % VIVID_PALETTE.length];


  // Today's checkins sorted by timestamp (oldest first) so dot indices match checkin order
  const todayCheckinEntries = habit.checkins
    .filter(c => c.date === today)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  const checkinMutation = useMutation<any, Error, void>({
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === habit.id
          ? { ...h, checkins: [...(h.checkins || []), { date: today, id: 'temp-' + Date.now() }], currentStreak: (h.currentStreak || 0) + 1 }
          : h
        )
      );
      return { prev };
    },
    onSuccess: () => {
      const newCount = todayCheckins + 1;
      if (newCount >= targetPerDay) {
        toast({ title: `✨ ${habit.name} complete!`, description: targetPerDay > 1 ? `All ${targetPerDay} done for today.` : "Keep the streak going!" });
      } else {
        toast({ title: `${habit.name} — ${newCount} / ${targetPerDay}`, description: `${targetPerDay - newCount} more to go today` });
      }
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to log ${habit.name}`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  // Undo a check-in by deleting the checkin entry
  const uncheckinMutation = useMutation<any, Error, string>({
    mutationFn: (checkinId: string) =>
      apiRequest("DELETE", `/api/habits/${habit.id}/checkin/${checkinId}`),
    onMutate: async (checkinId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === habit.id
          ? { ...h, checkins: (h.checkins || []).filter((c: any) => c.id !== checkinId), currentStreak: Math.max(0, (h.currentStreak || 0) - 1) }
          : h
        )
      );
      return { prev };
    },
    onSuccess: () => {
      toast({ title: `${habit.name} check-in undone` });
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to undo ${habit.name}`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  // Rename habit
  const renameMutation = useMutation<any, Error, string>({
    mutationFn: (newName: string) =>
      apiRequest("PATCH", `/api/habits/${habit.id}`, { name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Habit renamed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to rename", description: formatApiError(err), variant: "destructive" });
    },
  });

  const restoreMutation = useMutation<any,Error,void>({
    mutationFn: () => apiRequest("PATCH", `/api/habits/${habit.id}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: `"${habit.name}" restored` });
    },
    onError: (err: Error) => {
      toast({ title: `Failed to restore "${habit.name}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation<any,Error,void>({
    mutationFn: () => apiRequest("DELETE", `/api/habits/${habit.id}`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).filter((h: any) => h.id !== habit.id)
      );
      return { prev };
    },
    onSuccess: () => {
      toast({ title: `"${habit.name}" deleted`, action: <ToastAction altText="Undo" onClick={() => restoreMutation.mutate()}>Undo</ToastAction> });
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to delete "${habit.name}"`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
  });

  // 14-day grid with day-of-week labels
  const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const last14: { date: string; done: boolean; count: number; dayLabel: string; isToday: boolean; isSunday: boolean }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dd = new Date(Date.now() - i * 86400000);
    const ds = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
    const count = habit.checkins.filter(c => c.date === ds).length;
    last14.push({ date: ds, done: count >= targetPerDay, count, dayLabel: DAY_LABELS[dd.getDay()], isToday: i === 0, isSunday: dd.getDay() === 0 });
  }
  const completedDays = last14.filter(d => d.done).length;

  return (
    // SOLID COLOR card — full accentColor background, white text, Habituator style
    <div
      className="relative rounded-2xl overflow-hidden transition-all active:scale-[0.99]"
      style={{
        background: completedToday
          ? `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)`
          : `linear-gradient(135deg, ${accentColor}ee, ${accentColor}bb)`,
        boxShadow: `0 4px 16px ${accentColor}40`,
      }}
      data-testid={`card-habit-${habit.id}`}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">

        {/* Icon in semi-transparent white circle */}
        <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 bg-white/20">
          {completedToday
            ? <Check className="h-5 w-5 text-white" strokeWidth={3} />
            : <Icon className="h-5 w-5 text-white" />}
        </div>

        {/* Name + dots */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <EditableTitle
              value={habit.name}
              onSave={(newName) => renameMutation.mutateAsync(newName)}
              className="font-bold text-sm leading-tight truncate text-white"
              inputClassName="text-white border-white/40"
            />
            {habit.currentStreak > 0 && (
              <span className="text-[11px] font-bold text-white/90 shrink-0">
                🔥{habit.currentStreak}
              </span>
            )}
          </div>

          {/* Progress dots — white circles, tap to fill or tap filled to undo */}
          <div className="flex items-center gap-2 mt-2">
            {Array.from({ length: Math.min(targetPerDay, 10) }).map((_, idx) => {
              const filled = idx < todayCheckins;
              const isBusy = checkinMutation.isPending || uncheckinMutation.isPending;
              return (
                <button
                  key={idx}
                  onClick={stopProp(() => {
                    if (isBusy) return;
                    if (filled) {
                      // Undo: remove the checkin corresponding to this dot
                      const checkinToRemove = todayCheckinEntries[idx];
                      if (checkinToRemove && checkinToRemove.id && !checkinToRemove.id.startsWith('temp-')) {
                        uncheckinMutation.mutate(checkinToRemove.id);
                      }
                    } else if (idx === todayCheckins) {
                      // Fill: only the next empty dot is fillable
                      checkinMutation.mutate();
                    }
                  })}
                  data-testid={`button-seg-${habit.id}-${idx}`}
                  className="relative active:scale-90 touch-manipulation transition-all duration-200"
                  style={{ width: 26, height: 26, minWidth: 26, cursor: (filled || idx === todayCheckins) ? 'pointer' : 'default' }}
                  title={filled ? 'Tap to undo' : (idx === todayCheckins ? 'Tap to check in' : '')}
                >
                  <div
                    className="w-full h-full rounded-full border-2 flex items-center justify-center transition-all duration-150"
                    style={{
                      backgroundColor: filled ? 'rgba(255,255,255,0.9)' : 'transparent',
                      borderColor: filled ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                    }}
                  >
                    {filled && (
                      <Check className="h-3.5 w-3.5" style={{ color: accentColor }} strokeWidth={3} />
                    )}
                    {!filled && checkinMutation.isPending && idx === todayCheckins && (
                      <div className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    )}
                  </div>
                </button>
              );
            })}
            <span className="text-[11px] font-semibold text-white/80 ml-1">
              {completedToday ? '✓ Done' : todayCheckins > 0 ? `${todayCheckins}/${targetPerDay}` : habit.frequency}
            </span>
          </div>

          {/* 7-day dots */}
          <div className="flex items-center gap-1.5 mt-1.5">
            {last14.slice(7).map((day, i) => (
              <div
                key={i}
                className="rounded-full"
                style={{
                  width: 6, height: 6,
                  backgroundColor: day.done ? 'rgba(255,255,255,0.9)' : day.count > 0 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)',
                }}
              />
            ))}
            <span className="text-[9px] text-white/50 ml-0.5">
              {last14.slice(7).filter(d => d.done).length}/7
            </span>
          </div>
        </div>

        {/* Delete */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button onClick={stopProp()} className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors shrink-0">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{habit.name}"?</AlertDialogTitle>
              <AlertDialogDescription>All check-in history will be permanently removed.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate()} className="bg-destructive text-destructive-foreground">
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
          <div className="flex items-center gap-3 mb-2">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back to Dashboard" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
{filterMode === "selected" && filterLabel && (
            <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full">{filterLabel}</span>
          )}
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
          {habits.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(habit => (
            <HabitCard key={habit.id} habit={habit} />
          ))}
        </div>
      )}
    </div>
  );
}
