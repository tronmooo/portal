import { formatApiError } from "@/lib/formatError";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { stopProp } from "@/lib/event-utils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { getFilterLabel } from "@/lib/profileFilter";
import { useProfileScope, useActiveCreateProfileId } from "@/hooks/useProfileScope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import EditableTitle from "@/components/EditableTitle";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { showUndoToast } from "@/lib/undo-delete";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Flame, Plus, Minus, Check, Trophy, Droplets, Brain, BookOpen, Smartphone, Zap, Trash2, AlertCircle, RotateCcw, Clock } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";

// Habits are green across the app — the Executive tab's habits section, the
// wellness tab's card, and now this page.
const HABITS_ACCENT = "155 65% 45%";
import { Link } from "wouter";
import type { Habit, Profile } from "@shared/schema";
import { HABIT_TARGET_PRESETS, HABIT_MAX_TARGET_PER_DAY } from "@shared/schema";
import { habitDayProgress, habitCompletionsOn } from "@shared/habit-schedule";
import { getUserToday, addDays, parseLocalDate } from "@shared/timezone";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";

const ICON_MAP: Record<string, any> = { Droplets, Brain, BookOpen, Smartphone, Zap, Flame };

/** "2026-08-09T15:04:00Z" → "3:04 PM" in the viewer's clock. */
function formatCompletionTime(timestamp?: string): string {
  if (!timestamp) return "—";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function HabitCard({ habit }: { habit: Habit }) {
  const { toast } = useToast();
  // "Today" in the user's timezone. The server has no stored timezone
  // preference — it derives the user's tz from the X-Timezone header the
  // client sends (BROWSER_TIMEZONE, see queryClient.ts). Using the same tz
  // here keeps the client's "today" in lockstep with the server's
  // getUserToday(timezone) used by the canonical streak calculation.
  const today = getUserToday(BROWSER_TIMEZONE);
  // One shared definition of "how am I doing today" (shared/habit-schedule) so
  // this card, the dashboard and the server agree. A habit with a target above
  // 1 is NOT complete after its first completion.
  const progress = habitDayProgress(habit, today);
  const todayCheckins = progress.count;
  const targetPerDay = progress.target;
  const completedToday = progress.done;
  const isMulti = targetPerDay > 1;
  const [showTimes, setShowTimes] = useState(false);
  const [showCustomTarget, setShowCustomTarget] = useState(false);
  const [customTarget, setCustomTarget] = useState(String(targetPerDay));
  const Icon = ICON_MAP[habit.icon || ""] || Flame;
  // Auto-assign vivid colors from palette if no distinctive color set
  const VIVID_PALETTE = ['#E8545A','#E67E3B','#E8A838','#4BAE63','#2E9EBF','#7B68EE','#C2558B','#5B8FDB','#48C7A0','#D4628A'];
  const accentColor = (habit.color && habit.color !== '#4F98A3') ? habit.color : VIVID_PALETTE[habit.id.charCodeAt(0) % VIVID_PALETTE.length];


  // Today's completions, oldest first — each is its own occurrence, so the
  // dot indices, the "undo one" target and the times list all read from here.
  const todayCheckinEntries = habitCompletionsOn(habit, today);

  // Record ONE more completion. There is no ceiling: tapping + on a 3/3 habit
  // records a 4th occurrence and the card reads "4 / 3". Exceeding the goal is
  // data, not an error.
  const checkinMutation = useMutation<any, Error, void>({
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today, count: 1, source: "manual" }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      // BUG-HAB-001: Only bump the displayed streak when this checkin
      // actually crosses into completion for today. Previously we always
      // added +1 optimistically, then server replied with the unchanged
      // value and the streak "reverted" on the next render.
      const willCompleteToday = todayCheckins + 1 >= targetPerDay;
      const wasCompleteAlready = todayCheckins >= targetPerDay;
      const streakBump = willCompleteToday && !wasCompleteAlready ? 1 : 0;
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === habit.id
          ? { ...h, checkins: [...(h.checkins || []), { date: today, id: 'temp-' + Date.now(), timestamp: new Date().toISOString() }], currentStreak: (h.currentStreak || 0) + streakBump }
          : h
        )
      );
      // Confirm instantly — the ring/count already flipped optimistically and
      // the message is computed from local state, not the server reply.
      // Toasting in onSuccess bound it to the roundtrip (8s+ on a cold
      // serverless write): "the notification comes 30 seconds later".
      const newCount = todayCheckins + 1;
      if (newCount > targetPerDay) {
        toast({ title: `${habit.name} — ${newCount} / ${targetPerDay}`, description: `Past your goal by ${newCount - targetPerDay}. Recorded.` });
      } else if (newCount === targetPerDay) {
        toast({ title: `✨ ${habit.name} complete!`, description: targetPerDay > 1 ? `All ${targetPerDay} done for today.` : "Keep the streak going!" });
      } else {
        toast({ title: `${habit.name} — ${newCount} / ${targetPerDay}`, description: `${targetPerDay - newCount} more to go today` });
      }
      return { prev };
    },
    onSuccess: (serverHabit: any) => {
      // BUG-HAB-001: Reconcile with server-truth so the displayed streak
      // doesn't pop down a second later when invalidate refetches.
      if (serverHabit && typeof serverHabit === "object" && serverHabit.id) {
        queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
          (old || []).map((h: any) => h.id === habit.id ? { ...h, ...serverHabit } : h)
        );
      }
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to log ${habit.name}`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // Cache bus: "habits" ripples to dashboard KPIs, stats, activity,
      // insights. Timeline isn't in the habits domain — keep explicit
      // (habit checkin dots render on the calendar).
      invalidateDomain("habits");
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    },
  });

  // Undo the MOST RECENT completion of the day — the "−" control. Removing the
  // newest keeps an explicitly-timed earlier completion ("I did it at 8am")
  // intact, which deleting an arbitrary row would not.
  const undoLastMutation = useMutation<any, Error, void>({
    mutationFn: async () => {
      try {
        return await apiRequest("POST", `/api/habits/${habit.id}/checkin/undo`, { date: today });
      } catch (e: any) {
        // 404 = nothing recorded today (stale render / double tap). The
        // desired state already holds.
        if (!String(e?.message || "").startsWith("404")) throw e;
      }
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      const newest = todayCheckinEntries[todayCheckinEntries.length - 1];
      const wasCompleteToday = todayCheckins >= targetPerDay;
      const stillCompleteToday = todayCheckins - 1 >= targetPerDay;
      const streakDrop = wasCompleteToday && !stillCompleteToday ? 1 : 0;
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === habit.id
          ? { ...h, checkins: (h.checkins || []).filter((c: any) => c.id !== newest?.id), currentStreak: Math.max(0, (h.currentStreak || 0) - streakDrop) }
          : h
        )
      );
      toast({ title: `${habit.name} — ${Math.max(0, todayCheckins - 1)} / ${targetPerDay}`, description: "Removed one completion" });
      return { prev };
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to undo ${habit.name}`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    },
  });

  // Clear TODAY only. Previous days keep every completion they recorded.
  const resetDayMutation = useMutation<any, Error, void>({
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin/reset`, { date: today }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      const streakDrop = todayCheckins >= targetPerDay ? 1 : 0;
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === habit.id
          ? { ...h, checkins: (h.checkins || []).filter((c: any) => c.date !== today), currentStreak: Math.max(0, (h.currentStreak || 0) - streakDrop) }
          : h
        )
      );
      toast({ title: `${habit.name} reset`, description: `Cleared today's ${todayCheckins} completion${todayCheckins === 1 ? "" : "s"}` });
      return { prev };
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to reset ${habit.name}`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    },
  });

  // Change the DAILY TARGET (1x, 2x, 3x, 5x, 8x, custom). Lowering it never
  // deletes completions already recorded — a 4/3 day stays 4/3.
  const targetMutation = useMutation<any, Error, number, { prev: any }>({
    mutationFn: (n: number) => apiRequest("PATCH", `/api/habits/${habit.id}`, { targetPerDay: n }),
    onMutate: async (n) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData({ queryKey: ["/api/habits"] }, (old: any) =>
        Array.isArray(old) ? old.map((h: any) => h.id === habit.id ? { ...h, targetPerDay: n } : h) : old
      );
      return { prev };
    },
    onSuccess: (_d, n) => toast({ title: `${habit.name} — ${n}× per day`, description: todayCheckins > 0 ? `Today reads ${todayCheckins} / ${n}.` : undefined }),
    onError: (err: Error, _v, context) => {
      if (context?.prev) { for (const [key, value] of context.prev) queryClient.setQueryData(key, value); }
      toast({ title: "Failed to change target", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("habits"); },
  });

  // Rename habit — optimistic so the new name shows instantly
  const renameMutation = useMutation<any, Error, string, { prev: any }>({
    mutationFn: (newName: string) =>
      apiRequest("PATCH", `/api/habits/${habit.id}`, { name: newName }),
    onMutate: async (newName) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData({ queryKey: ["/api/habits"] }, (old: any) =>
        Array.isArray(old) ? old.map((h: any) => h.id === habit.id ? { ...h, name: newName } : h) : old
      );
      return { prev };
    },
    onSuccess: () => toast({ title: "Habit renamed" }),
    onError: (err: Error, _v, context) => {
      if (context?.prev) {
        for (const [key, value] of context.prev) queryClient.setQueryData(key, value);
      }
      toast({ title: "Failed to rename", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
    },
  });

  // Change frequency — optimistic
  const frequencyMutation = useMutation<any, Error, string, { prev: any }>({
    mutationFn: (newFrequency: string) =>
      apiRequest("PATCH", `/api/habits/${habit.id}`, { frequency: newFrequency }),
    onMutate: async (newFrequency) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData({ queryKey: ["/api/habits"] }, (old: any) =>
        Array.isArray(old) ? old.map((h: any) => h.id === habit.id ? { ...h, frequency: newFrequency } : h) : old
      );
      return { prev };
    },
    onSuccess: (_data, newFrequency) => toast({ title: `Frequency updated to ${newFrequency}` }),
    onError: (err: Error, _v, context) => {
      if (context?.prev) {
        for (const [key, value] of context.prev) queryClient.setQueryData(key, value);
      }
      toast({ title: "Failed to update frequency", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
    },
  });

  const restoreMutation = useMutation<any,Error,void>({
    mutationFn: () => apiRequest("PATCH", `/api/habits/${habit.id}/restore`),
    onSuccess: () => {
      invalidateDomain("habits");
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
      // Undo rides the shared helper (8s window) and hits the server's
      // soft-delete restore endpoint (PATCH /api/habits/:id/restore).
      showUndoToast({
        title: `"${habit.name}" deleted`,
        onUndo: () => restoreMutation.mutate(),
      });
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to delete "${habit.name}"`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
      // Calendar timeline reads habit checkins to render the dot grid — with
      // checkins now cascade-deleted server-side, the timeline view needs
      // to refetch or it shows ghost completion dots for the gone habit.
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    },
  });

  // 14-day grid with day-of-week labels
  const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const last14: { date: string; done: boolean; count: number; dayLabel: string; isToday: boolean; isSunday: boolean }[] = [];
  for (let i = 13; i >= 0; i--) {
    // Walk back from the user's-timezone "today" with tz-safe date math
    // instead of Date.now() millisecond arithmetic (DST/tz-shift safe).
    const ds = addDays(today, -i);
    const dayOfWeek = parseLocalDate(ds).getDay();
    const count = habit.checkins.filter(c => c.date === ds).length;
    last14.push({ date: ds, done: count >= targetPerDay, count, dayLabel: DAY_LABELS[dayOfWeek], isToday: i === 0, isSunday: dayOfWeek === 0 });
  }
  const completedDays = last14.filter(d => d.done).length;

  const isBusy = checkinMutation.isPending || undoLastMutation.isPending || resetDayMutation.isPending;

  const applyCustomTarget = () => {
    const n = Math.floor(Number(customTarget));
    if (!Number.isFinite(n) || n < 1 || n > HABIT_MAX_TARGET_PER_DAY) {
      toast({ title: "Enter a target between 1 and " + HABIT_MAX_TARGET_PER_DAY, variant: "destructive" });
      return;
    }
    setShowCustomTarget(false);
    if (n !== targetPerDay) targetMutation.mutate(n);
  };

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

        {/* Icon — also the "tap the habit itself to record another completion"
            target, so a multi-completion habit doesn't force the user to aim
            for the small + button. */}
        <button
          type="button"
          onClick={stopProp(() => { if (!isBusy) checkinMutation.mutate(); })}
          disabled={isBusy}
          data-testid={`button-habit-tap-${habit.id}`}
          aria-label={`Record a completion of ${habit.name} (${todayCheckins} of ${targetPerDay} today)`}
          className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 bg-white/20 hover:bg-white/30 active:scale-90 transition-all touch-manipulation disabled:opacity-60"
        >
          {completedToday
            ? <Check className="h-5 w-5 text-white" strokeWidth={3} />
            : <Icon className="h-5 w-5 text-white" />}
        </button>

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

          {/* TODAY'S PROGRESS.
              A habit with a target of 1 stays a plain checkbox. Above 1 it
              shows the real count against the target — "2 / 3 completed
              today" — with − / + controls, because a single done/not-done
              state cannot represent "walked the dog twice out of three". */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {isMulti ? (
              <>
                <button
                  type="button"
                  onClick={stopProp(() => { if (!isBusy && todayCheckins > 0) undoLastMutation.mutate(); })}
                  disabled={isBusy || todayCheckins === 0}
                  data-testid={`button-habit-minus-${habit.id}`}
                  aria-label={`Remove one completion of ${habit.name}`}
                  className="w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 disabled:opacity-30 flex items-center justify-center active:scale-90 transition-all touch-manipulation"
                >
                  <Minus className="h-3.5 w-3.5 text-white" strokeWidth={3} />
                </button>

                <span
                  className="text-white font-bold text-sm tabular-nums min-w-[3.25rem] text-center"
                  data-testid={`text-habit-progress-${habit.id}`}
                >
                  {todayCheckins} / {targetPerDay}
                </span>

                <button
                  type="button"
                  onClick={stopProp(() => { if (!isBusy) checkinMutation.mutate(); })}
                  disabled={isBusy}
                  data-testid={`button-habit-plus-${habit.id}`}
                  aria-label={`Record another completion of ${habit.name}`}
                  className="w-7 h-7 rounded-full bg-white/25 hover:bg-white/40 disabled:opacity-40 flex items-center justify-center active:scale-90 transition-all touch-manipulation"
                >
                  <Plus className="h-3.5 w-3.5 text-white" strokeWidth={3} />
                </button>

                {/* Segments: one per target, plus an "over" chip when the user
                    went past the goal. Exceeding is shown, never hidden. */}
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(targetPerDay, 12) }).map((_, idx) => (
                    <div
                      key={idx}
                      data-testid={`seg-habit-${habit.id}-${idx}`}
                      className="rounded-full transition-all duration-200"
                      style={{
                        width: 14, height: 5,
                        backgroundColor: idx < todayCheckins ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.28)',
                      }}
                    />
                  ))}
                  {progress.exceeded && (
                    <span className="text-[11px] font-bold text-white/90 ml-0.5" data-testid={`text-habit-exceeded-${habit.id}`}>
                      +{todayCheckins - targetPerDay}
                    </span>
                  )}
                </div>
              </>
            ) : (
              /* Target of 1 — the familiar single checkbox. */
              <button
                type="button"
                onClick={stopProp(() => {
                  if (isBusy) return;
                  if (todayCheckins > 0) undoLastMutation.mutate(); else checkinMutation.mutate();
                })}
                data-testid={`button-seg-${habit.id}-0`}
                className="relative active:scale-90 touch-manipulation transition-all duration-200"
                style={{ width: 26, height: 26, minWidth: 26 }}
                title={completedToday ? 'Tap to undo' : 'Tap to check in'}
                aria-label={completedToday ? `Undo check-in for ${habit.name}` : `Check in ${habit.name}`}
              >
                <div
                  className="w-full h-full rounded-full border-2 flex items-center justify-center transition-all duration-150"
                  style={{
                    backgroundColor: completedToday ? 'rgba(255,255,255,0.9)' : 'transparent',
                    borderColor: completedToday ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                  }}
                >
                  {completedToday && <Check className="h-3.5 w-3.5" style={{ color: accentColor }} strokeWidth={3} />}
                  {!completedToday && checkinMutation.isPending && (
                    <div className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  )}
                </div>
              </button>
            )}

            {/* DAILY TARGET selector — 1x/2x/3x/5x/8x or a custom number. */}
            <Select
              value={showCustomTarget ? "custom" : String(targetPerDay)}
              onValueChange={(v) => {
                if (v === "custom") { setShowCustomTarget(true); setCustomTarget(String(targetPerDay)); return; }
                setShowCustomTarget(false);
                const n = Number(v);
                if (n >= 1 && n !== targetPerDay) targetMutation.mutate(n);
              }}
            >
              <SelectTrigger className="h-5 w-auto min-w-0 border-0 bg-white/15 text-white/80 text-[11px] font-semibold px-1.5 py-0 gap-0.5 hover:bg-white/25 focus:ring-0 focus:ring-offset-0 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-white/60" data-testid={`select-target-${habit.id}`}>
                <span>{targetPerDay}× daily</span>
              </SelectTrigger>
              <SelectContent>
                {HABIT_TARGET_PRESETS.map(n => (
                  <SelectItem key={n} value={String(n)}>{n}× daily</SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>

            {showCustomTarget && (
              <span className="flex items-center gap-1" onClick={stopProp()}>
                <Input
                  type="number"
                  min={1}
                  max={HABIT_MAX_TARGET_PER_DAY}
                  value={customTarget}
                  onChange={e => setCustomTarget(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") applyCustomTarget(); }}
                  data-testid={`input-custom-target-${habit.id}`}
                  className="h-5 w-14 px-1 text-[11px] bg-white/20 border-white/30 text-white"
                  aria-label={`Custom daily target for ${habit.name}`}
                />
                <button
                  type="button"
                  onClick={stopProp(applyCustomTarget)}
                  data-testid={`button-custom-target-${habit.id}`}
                  className="text-[11px] font-semibold text-white/90 bg-white/20 hover:bg-white/30 rounded px-1.5 h-5"
                >
                  Set
                </button>
              </span>
            )}

            <Select
              value={habit.frequency}
              onValueChange={(v) => frequencyMutation.mutate(v)}
            >
              <SelectTrigger className="h-5 w-auto min-w-0 border-0 bg-white/15 text-white/80 text-[11px] font-semibold px-1.5 py-0 gap-0.5 hover:bg-white/25 focus:ring-0 focus:ring-offset-0 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-white/60" data-testid={`select-freq-${habit.id}`}>
                <span>{habit.frequency}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>

            {todayCheckins > 0 && (
              <>
                {/* Previous completion times for today — each completion is a
                    real occurrence with its own timestamp, so they can be
                    listed instead of collapsing into one "done". */}
                <button
                  type="button"
                  onClick={stopProp(() => setShowTimes(v => !v))}
                  data-testid={`button-habit-times-${habit.id}`}
                  aria-expanded={showTimes}
                  className="flex items-center gap-1 text-[11px] font-semibold text-white/70 hover:text-white bg-white/10 hover:bg-white/20 rounded px-1.5 h-5"
                >
                  <Clock className="h-2.5 w-2.5" /> {showTimes ? "Hide" : "Times"}
                </button>
                <button
                  type="button"
                  onClick={stopProp(() => { if (!isBusy) resetDayMutation.mutate(); })}
                  disabled={isBusy}
                  data-testid={`button-habit-reset-${habit.id}`}
                  aria-label={`Reset today's completions for ${habit.name}`}
                  className="flex items-center gap-1 text-[11px] font-semibold text-white/70 hover:text-white bg-white/10 hover:bg-white/20 rounded px-1.5 h-5 disabled:opacity-40"
                >
                  <RotateCcw className="h-2.5 w-2.5" /> Reset
                </button>
              </>
            )}
          </div>

          {showTimes && todayCheckins > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5" data-testid={`list-habit-times-${habit.id}`}>
              {todayCheckinEntries.map((c, i) => (
                <span key={c.id || i} className="text-[11px] text-white/80 bg-white/15 rounded px-1.5 py-0.5 tabular-nums">
                  {formatCompletionTime(c.timestamp)}
                </span>
              ))}
            </div>
          )}

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
            <span className="text-[11px] text-white/50 ml-0.5">
              {last14.slice(7).filter(d => d.done).length}/7
            </span>
          </div>
        </div>

        {/* Delete */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button type="button" onClick={stopProp()} aria-label={`Delete habit ${habit.name}`} className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors shrink-0">
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
  // QA Bug 7: auto-open create form when arriving via command palette ?new=1
  useEffect(() => {
    const hash = window.location.hash || "";
    const q = hash.includes("?") ? hash.split("?")[1] : "";
    if (q && new URLSearchParams(q).get("new") === "1") {
      setShowCreate(true);
      const cleaned = hash.split("?")[0];
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
    }
  }, []);
  const [newName, setNewName] = useState("");
  // New habits pick a daily target up front — "walk the dog 3x a day" should
  // be creatable in one step, not created as 1x and edited afterwards.
  const [newTarget, setNewTarget] = useState<number>(1);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [dupWarning, setDupWarning] = useState<string | null>(null);

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  // Default a new habit's profile to the ACTIVE scope (the profile the user is
  // working in), not unconditionally "me".
  const activeCreateProfileId = useActiveCreateProfileId(profiles);
  useEffect(() => {
    if (activeCreateProfileId && !selectedProfileId) setSelectedProfileId(activeCreateProfileId);
  }, [activeCreateProfileId]);
  // Reactive read of the active profile scope (single source of truth) so this
  // page re-renders the instant the selection changes anywhere in the app.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const filterLabel = getFilterLabel();
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allHabits = [], isLoading, error, refetch } = useQuery<Habit[]>({
    queryKey: ["/api/habits", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/habits${profileParam}`).then(r => r.json()),
  });

  // Client-side profile filter
  // Habits with empty linkedProfiles (null or []) show for ALL profiles (backward compat)
  const habits = filterMode === "selected" && filterIds.length > 0
    ? allHabits.filter(h => {
        const lp = h.linkedProfiles || [];
        return lp.length === 0 || lp.some(id => filterIds.includes(id));
      })
    : allHabits;

  const handleCreate = (force?: boolean) => {
    if (!newName.trim()) { toast({ title: "Name required", description: "Enter a habit name", variant: "destructive" }); return; }
    if (!force) {
      const duplicate = habits.find(h => h.name.toLowerCase() === newName.trim().toLowerCase());
      if (duplicate) {
        setDupWarning(duplicate.name);
        return;
      }
    }
    createMutation.mutate(newName.trim());
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/habits", {
      name,
      frequency: "daily",
      targetPerDay: newTarget,
      ...(selectedProfileId ? { linkedProfiles: [selectedProfileId] } : {}),
    }),
    onSuccess: () => { invalidateDomain("habits"); queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] }); const saved = newName.trim(); const savedTarget = newTarget; setNewName(""); setNewTarget(1); setSelectedProfileId(activeCreateProfileId || ""); setShowCreate(false); toast({ title: `"${saved}" habit created`, description: savedTarget > 1 ? `${savedTarget}× per day — check in each time` : "Check in daily to build your streak" }); },
    onError: (err: Error) => toast({ title: "Failed to create habit", description: formatApiError(err), variant: "destructive" }),
  });

  // Summary stats — same user-timezone "today" as HabitCard / the server
  const today = getUserToday(BROWSER_TIMEZONE);
  const completedToday = habits.filter(h => {
    const tpd = (h as any).targetPerDay || 1;
    return h.checkins.filter(c => c.date === today).length >= tpd;
  }).length;
  const totalActive = habits.length;

  return (
    <PageContainer>
      <PageHeader
        title="Habits"
        subtitle={filterMode === "selected" && filterLabel
          ? `${completedToday}/${totalActive} completed today · ${filterLabel}`
          : `${completedToday}/${totalActive} completed today`}
        icon={Flame}
        accent={HABITS_ACCENT}
        backHref="/dashboard"
        actions={
          <Button size="sm" onClick={() => setShowCreate(!showCreate)} data-testid="button-create-habit">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Habit
          </Button>
        }
      />

      {/* Today's progress — the accent is the tab's, not the generic primary,
          so this page agrees with the habit rows below it. */}
      <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: `hsl(${HABITS_ACCENT} / 0.15)` }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: totalActive > 0 ? `${(completedToday / totalActive) * 100}%` : "0%",
            background: `linear-gradient(90deg, hsl(${HABITS_ACCENT}), hsl(${HABITS_ACCENT} / 0.65))`,
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
              className="flex-1"
            />
            <Select value={String(newTarget)} onValueChange={(v) => setNewTarget(Math.max(1, Number(v) || 1))}>
              <SelectTrigger className="w-[110px] h-9 text-xs" data-testid="select-new-habit-target">
                <SelectValue placeholder="1× daily" />
              </SelectTrigger>
              <SelectContent>
                {HABIT_TARGET_PRESETS.map(n => (
                  <SelectItem key={n} value={String(n)}>{n}× daily</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
              <SelectTrigger className="w-[120px] h-9 text-xs" data-testid="select-habit-profile">
                <SelectValue placeholder="Profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.filter(p => ["self", "person", "pet"].includes(p.type)).map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.type === "self" ? "Me" : p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              disabled={createMutation.isPending}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleCreate(); }}
              onPointerDown={(e) => { e.stopPropagation(); }}
              data-testid="button-save-habit"
            >
              Add
            </Button>
          </div>
        </Card>
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
      ) : habits.length === 0 ? (
        <EmptyState
          icon={Flame}
          accent={HABITS_ACCENT}
          label="No streaks going yet"
          hint="Pick one small thing you want to do daily. The streak does the rest."
          ctaLabel="Create your first habit"
          onCta={() => setShowCreate(true)}
        />
      ) : (
        <div className="grid gap-3">
          {habits.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(habit => (
            <HabitCard key={habit.id} habit={habit} />
          ))}
        </div>
      )}

      {/* Duplicate habit warning */}
      <AlertDialog open={!!dupWarning} onOpenChange={(open) => { if (!open) setDupWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Duplicate Habit</AlertDialogTitle>
            <AlertDialogDescription>
              A habit named "{dupWarning}" already exists. Create another?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setDupWarning(null); handleCreate(true); }}>
              Create Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
