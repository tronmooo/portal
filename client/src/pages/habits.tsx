import { formatApiError } from "@/lib/formatError";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { stopProp } from "@/lib/event-utils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { withFullLimit } from "@/lib/list-limit";
import { getFilterLabel } from "@/lib/profileFilter";
import { passesProfileFilter } from "@shared/profile-filter";
import { useProfileFilterCtx } from "@/hooks/useProfileFilterCtx";
import { useRecordHighlight } from "@/hooks/useRecordHighlight";
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
import { Flame, Plus, Check, Trophy, Droplets, Brain, BookOpen, Smartphone, Zap, Trash2, AlertCircle } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";

// Habits are green across the app — the Executive tab's habits section, the
// wellness tab's card, and now this page.
const HABITS_ACCENT = "155 65% 45%";
import { Link } from "wouter";
import type { Habit, Profile } from "@shared/schema";
import { getUserToday } from "@shared/timezone";
import { rollingMean } from "@shared/tracker-analytics";
import { useState, useEffect, useMemo } from "react";
import { habitDayProgress, habitsDayRollup, bestHabitStreak } from "@shared/habit-progress";
import { useToast } from "@/hooks/use-toast";
import {
  HeroMetric, StatTile, RingStack, CalendarHeatmap, SectionTitle, MeterRow, CoverageNote,
  accentScope, tone,
} from "@/components/tracker-detail";
import { TimeRangeSelector } from "@/components/ui/time-range";
import {
  HABITS_HS, HABIT_RANGE_DAYS, HABIT_RANGE_OPTIONS, type HabitRange,
  habitAccent, habitCompletion, habitsCompletion, dailyCompletionSeries, habitCheckinPoints, heatmapStartDay,
} from "@/lib/habit-visuals";

/** Columns of check-in history on each card — fits a 390px phone at ~20px a cell. */
const HEATMAP_WEEKS = 14;

const ICON_MAP: Record<string, any> = { Droplets, Brain, BookOpen, Smartphone, Zap, Flame };

function HabitCard({ habit, rangeDays, rangeLabel }: { habit: Habit; rangeDays: number; rangeLabel: string }) {
  const { toast } = useToast();
  // "Today" in the user's timezone. The server has no stored timezone
  // preference — it derives the user's tz from the X-Timezone header the
  // client sends (BROWSER_TIMEZONE, see queryClient.ts). Using the same tz
  // here keeps the client's "today" in lockstep with the server's
  // getUserToday(timezone) used by the canonical streak calculation.
  const today = getUserToday(BROWSER_TIMEZONE);
  // One shared answer for "how far through today is this habit?" — the same
  // module the popup, the briefing, the notifications and the server read, so
  // this page can no longer disagree with them (shared/habit-progress.ts).
  const dayProgress = habitDayProgress(habit as any, today);
  const todayCheckins = dayProgress.completed;
  const targetPerDay = dayProgress.required || ((habit as any).targetPerDay || 1);
  const completedToday = dayProgress.isComplete;
  const Icon = ICON_MAP[habit.icon || ""] || Flame;
  // The habit's own accent ("H S%"), from its chosen color or a fixed palette
  // slot by id — rendered through tone() so it reads in light and dark mode.
  const accent = habitAccent(habit);


  // Today's checkins sorted by timestamp (oldest first) so dot indices match checkin order
  const todayCheckinEntries = habit.checkins
    .filter(c => c.date === today)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  const checkinMutation = useMutation<any, Error, void>({
    // Parse the reply: onSuccess reconciles from `serverHabit.id` and reads
    // `completion.notScheduled`, neither of which exists on a raw Response —
    // the reconcile below had silently never run.
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today }).then((r) => r.json()),
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
          ? { ...h, checkins: [...(h.checkins || []), { date: today, id: 'temp-' + Date.now() }], currentStreak: (h.currentStreak || 0) + streakBump }
          : h
        )
      );
      // Rule 16: the ring/count flip optimistically, but the confirmation is
      // a claim that the check-in is committed — it fires in onSuccess. The
      // message is computed HERE (from the pre-tap count) and carried in the
      // context so a re-render between tap and reply cannot skew it.
      const newCount = todayCheckins + 1;
      return { prev, newCount };
    },
    onSuccess: (serverHabit: any, _v: unknown, ctx: any) => {
      const newCount = Number(ctx?.newCount ?? todayCheckins + 1);
      if (serverHabit?.completion?.notScheduled) {
        // The tap landed on a day this habit isn't scheduled for (a weekly
        // habit is due on Mondays unless days are set): it is recorded, but
        // "complete!" would overstate it — say what really happened.
        toast({ title: `${habit.name} — recorded`, description: "Not one of its scheduled days, so it doesn't count toward the streak." });
      } else if (newCount >= targetPerDay) {
        toast({ title: `✨ ${habit.name} complete!`, description: targetPerDay > 1 ? `All ${targetPerDay} done for today.` : "Keep the streak going!" });
      } else {
        toast({ title: `${habit.name} — ${newCount} / ${targetPerDay}`, description: `${targetPerDay - newCount} more to go today` });
      }
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

  // Undo a check-in by deleting the checkin entry
  const uncheckinMutation = useMutation<any, Error, string>({
    mutationFn: async (checkinId: string) => {
      // Idempotent undo: 404 = the check-in is already gone (stale render or
      // double tap). The desired state holds — not an error.
      try {
        await apiRequest("DELETE", `/api/habits/${habit.id}/checkin/${checkinId}`);
      } catch (e: any) {
        if (!String(e?.message || "").startsWith("404")) throw e;
      }
    },
    onMutate: async (checkinId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      // BUG-HAB-001: Only drop the streak when this undo actually pulls us
      // back below today's target.
      const wasCompleteToday = todayCheckins >= targetPerDay;
      const stillCompleteToday = todayCheckins - 1 >= targetPerDay;
      const streakDrop = wasCompleteToday && !stillCompleteToday ? 1 : 0;
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === habit.id
          ? { ...h, checkins: (h.checkins || []).filter((c: any) => c.id !== checkinId), currentStreak: Math.max(0, (h.currentStreak || 0) - streakDrop) }
          : h
        )
      );
      // Rule 16: confirmation waits for the commit (onSuccess below).
      return { prev };
    },
    onSuccess: () => { toast({ title: `${habit.name} check-in undone` }); },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to undo ${habit.name}`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    },
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

  // Consistency over the page's time frame and a 14-week check-in history.
  // Both read shared/habit-progress through lib/habit-visuals — no local
  // "is it done?" rule.
  const completion = habitCompletion(habit as any, today, rangeDays, BROWSER_TIMEZONE);
  const heatPoints = habitCheckinPoints(habit as any, heatmapStartDay(today, HEATMAP_WEEKS), today);
  const todayPct = completedToday ? 100 : targetPerDay > 0 ? Math.min(100, (todayCheckins / targetPerDay) * 100) : 0;
  const isBusy = checkinMutation.isPending || uncheckinMutation.isPending;
  const best = Math.max(habit.longestStreak || 0, habit.currentStreak || 0);

  return (
    <div
      data-record-id={habit.id}
      className="bubble td-scope td-rise p-4 min-w-0"
      style={accentScope(accent.hs, accent.hs2)}
      data-testid={`card-habit-${habit.id}`}
    >
      {/* Header: icon, name, today's state, frequency, delete */}
      <div className="flex items-start gap-3">
        <span className="medallion medallion-sm mt-0.5" aria-hidden="true">
          {completedToday ? <Check className="h-4 w-4" strokeWidth={3} /> : <Icon className="h-4 w-4" />}
        </span>
        <div className="flex-1 min-w-0">
          <EditableTitle
            value={habit.name}
            onSave={(newName) => renameMutation.mutateAsync(newName)}
            className="font-semibold text-[15px] leading-tight truncate"
          />
          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            <span
              className="font-medium"
              style={completedToday ? { color: tone("var(--td-hs)") } : undefined}
              data-testid={`text-habit-today-${habit.id}`}
            >
              {completedToday ? "Done today" : dayProgress.label}
            </span>
            <Select value={habit.frequency} onValueChange={(v) => frequencyMutation.mutate(v)}>
              <SelectTrigger
                className="h-6 w-auto min-w-0 rounded-full border-0 bg-muted/70 px-2 py-0 gap-1 text-xs font-medium capitalize text-foreground/80 hover:bg-muted focus:ring-0 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3"
                data-testid={`select-freq-${habit.id}`}
                aria-label={`Frequency for ${habit.name}`}
              >
                <span>{habit.frequency}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button type="button" onClick={stopProp()} aria-label={`Delete habit ${habit.name}`} className="p-2 -m-1 rounded-full text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0">
              <Trash2 className="h-4 w-4" />
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

      {/* Today's ring + the three numbers that matter */}
      <div className="mt-3.5 flex items-center gap-4">
        <RingStack
          size={76}
          stroke={8}
          rings={[{ pct: todayPct, hs: "var(--td-hs)", label: `${habit.name} today` }]}
          center={completedToday
            ? <Check className="h-6 w-6" style={{ color: tone("var(--td-hs)") }} strokeWidth={3} aria-hidden="true" />
            : <span className="text-sm font-bold tabular-nums">{todayCheckins}/{targetPerDay}</span>}
        />
        <dl className="grid flex-1 min-w-0 grid-cols-3 gap-2">
          <div className="min-w-0" data-testid={`stat-streak-${habit.id}`}>
            <dt className="micro-label text-muted-foreground truncate">Streak</dt>
            <dd className="mt-1 flex items-center gap-1 text-lg metric-value leading-none" style={{ color: habit.currentStreak > 0 ? tone("var(--td-hs)") : undefined }}>
              {habit.currentStreak > 0 && <Flame className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {habit.currentStreak || 0}
            </dd>
            <p className="mt-1 text-[11px] text-muted-foreground truncate">{habit.currentStreak === 1 ? "day" : "days"}</p>
          </div>
          <div className="min-w-0" data-testid={`stat-best-${habit.id}`}>
            <dt className="micro-label text-muted-foreground truncate">Best</dt>
            <dd className="mt-1 flex items-center gap-1 text-lg metric-value leading-none">
              {best > 0 && <Trophy className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />}
              {best}
            </dd>
            <p className="mt-1 text-[11px] text-muted-foreground truncate">longest run</p>
          </div>
          <div className="min-w-0" data-testid={`stat-rate-${habit.id}`}>
            <dt className="micro-label text-muted-foreground truncate">{rangeLabel}</dt>
            <dd className="mt-1 text-lg metric-value leading-none">
              {completion.percent == null ? "—" : `${completion.percent}%`}
            </dd>
            <p className="mt-1 text-[11px] text-muted-foreground truncate">
              {completion.scheduled > 0 ? `${completion.complete} of ${completion.scheduled} days` : "no days yet"}
            </p>
          </div>
        </dl>
      </div>

      {/* Check-in taps — one per required completion; tap a filled one to undo */}
      <div className="mt-3.5 flex items-center gap-2 flex-wrap">
        {Array.from({ length: Math.min(targetPerDay, 10) }).map((_, idx) => {
          const filled = idx < todayCheckins;
          const next = idx === todayCheckins;
          return (
            <button
              key={idx}
              type="button"
              onClick={stopProp(() => {
                if (isBusy) return;
                if (filled) {
                  // Undo: remove the checkin corresponding to this dot
                  const checkinToRemove = todayCheckinEntries[idx];
                  if (checkinToRemove && checkinToRemove.id && !checkinToRemove.id.startsWith('temp-')) {
                    uncheckinMutation.mutate(checkinToRemove.id);
                  }
                } else if (next) {
                  // Fill: only the next empty dot is fillable
                  checkinMutation.mutate();
                }
              })}
              data-testid={`button-seg-${habit.id}-${idx}`}
              className="relative h-9 w-9 shrink-0 rounded-full border-2 flex items-center justify-center active:scale-90 touch-manipulation transition-transform duration-150"
              style={{
                background: filled ? `linear-gradient(135deg, ${tone("var(--td-hs)")}, ${tone("var(--td-hs2)")})` : "transparent",
                borderColor: filled ? "transparent" : tone("var(--td-hs)", next ? 0.7 : 0.3),
                cursor: (filled || next) ? 'pointer' : 'default',
              }}
              title={filled ? 'Tap to undo' : (next ? 'Tap to check in' : '')}
              aria-label={filled ? `Undo check-in ${idx + 1} for ${habit.name}` : `Check in ${idx + 1} of ${targetPerDay} for ${habit.name}`}
            >
              {filled && <Check className="h-4 w-4 text-white" strokeWidth={3} />}
              {!filled && next && !checkinMutation.isPending && <Plus className="h-4 w-4" style={{ color: tone("var(--td-hs)") }} />}
              {!filled && checkinMutation.isPending && next && (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
              )}
            </button>
          );
        })}
        {!completedToday && dayProgress.isScheduled && dayProgress.remaining > 0 && (
          <span className="text-xs text-muted-foreground">
            {dayProgress.remaining} to go today
          </span>
        )}
      </div>

      {/* 14 weeks of check-ins */}
      <div className="mt-4">
        <p className="micro-label text-muted-foreground mb-1.5">Last {HEATMAP_WEEKS} weeks</p>
        <CalendarHeatmap points={heatPoints} today={today} weeks={HEATMAP_WEEKS} unit="done" />
      </div>
    </div>
  );
}

export default function HabitsPage() {
  useEffect(() => { document.title = "Habits — Portol"; }, []);
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  // Rules 23/24: `?highlight=habit:<id>` lands on that habit's card.
  useRecordHighlight("habit");
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
    queryFn: () => apiRequest("GET", withFullLimit(`/api/habits${profileParam}`)).then(r => r.json()),
  });

  // Client-side profile filter — the canonical rule (shared/profile-filter.ts):
  // an unlinked habit belongs to Self, so it shows under a Self selection and
  // not under every other person's view as the old inline check did.
  const habitScopeCtx = useProfileFilterCtx(filterIds, profiles as any[]);
  const habits = filterMode === "selected" && filterIds.length > 0
    ? allHabits.filter(h => passesProfileFilter(h.linkedProfiles, habitScopeCtx))
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
      ...(selectedProfileId ? { linkedProfiles: [selectedProfileId] } : {}),
    }),
    onSuccess: () => { invalidateDomain("habits"); queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] }); const saved = newName.trim(); setNewName(""); setSelectedProfileId(activeCreateProfileId || ""); setShowCreate(false); toast({ title: `"${saved}" habit created`, description: "Check in daily to build your streak" }); },
    onError: (err: Error) => toast({ title: "Failed to create habit", description: formatApiError(err), variant: "destructive" }),
  });

  // Summary stats — same user-timezone "today" as HabitCard / the server, and
  // the same shared rollup the dashboard reads (shared/habit-progress.ts):
  // a habit not scheduled today is on neither side of "x / y done".
  const today = getUserToday(BROWSER_TIMEZONE);
  const [range, setRange] = useState<HabitRange>("30d");
  const rangeDays = HABIT_RANGE_DAYS[range];
  const rangeLabel = HABIT_RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range;
  const summary = useMemo(() => {
    const rollup = habitsDayRollup(habits as any[], today);
    const completion = habitsCompletion(habits as any[], today, rangeDays, BROWSER_TIMEZONE);
    const series = dailyCompletionSeries(habits as any[], today, rangeDays, BROWSER_TIMEZONE);
    const perHabit = habits
      .map((h) => ({ habit: h, accent: habitAccent(h), c: habitCompletion(h as any, today, rangeDays, BROWSER_TIMEZONE) }))
      .sort((a, b) => (b.c.percent ?? -1) - (a.c.percent ?? -1) || a.habit.name.localeCompare(b.habit.name));
    const longest = habits.reduce((m, h) => Math.max(m, h.longestStreak || 0, h.currentStreak || 0), 0);
    // The hero's sparkline: daily completion smoothed over a week, so one
    // missed day reads as a dip rather than a sawtooth. Too few days to
    // smooth → the raw daily values.
    const smoothed = rollingMean(series, 7).filter((v): v is number => v != null);
    const spark = smoothed.length >= 2 ? smoothed : series.map((p) => p.value);
    return { rollup, completion, spark, perHabit, best: bestHabitStreak(habits), longest };
  }, [habits, today, rangeDays]);
  const completedToday = summary.rollup.habitsComplete;
  const totalActive = summary.rollup.habitsScheduled;
  const occurrencesLeft = summary.rollup.required - summary.rollup.completed;

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
        <div className="td-scope space-y-4 min-w-0" style={accentScope(HABITS_HS[0], HABITS_HS[1])} data-testid="habits-summary">
          {/* Today at a glance: done / scheduled, with a ring for today's
              occurrences and one for the period's completion rate. */}
          <HeroMetric
            icon={Flame}
            eyebrow="Today"
            display={`${completedToday}/${totalActive}`}
            unit={totalActive === 1 ? "habit done" : "habits done"}
            caption={totalActive === 0
              ? "Nothing scheduled today"
              : occurrencesLeft > 0
                ? `${occurrencesLeft} check-in${occurrencesLeft === 1 ? "" : "s"} left today`
                : "Everything done for today"}
            spark={summary.spark.length >= 2 ? summary.spark : undefined}
            side={<div className="flex flex-col items-center gap-1.5">
              <RingStack
                size={104}
                stroke={10}
                rings={[
                  { pct: summary.rollup.percent, hs: "var(--td-hs)", label: "Today" },
                  { pct: summary.completion.percent ?? 0, hs: "var(--td-hs2)", label: `${rangeLabel} completion` },
                ]}
                center={<>
                  <span className="text-lg font-bold tabular-nums" data-testid="text-habits-today-pct">{summary.rollup.percent}%</span>
                  <span className="text-[11px] text-muted-foreground">today</span>
                </>}
              />
              {/* Which ring is which — outer: today's check-ins, inner: the period. */}
              <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground" aria-hidden="true">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: tone("var(--td-hs)") }} />Today</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: tone("var(--td-hs2)") }} />{rangeLabel}</span>
              </div>
            </div>}
          />

          <SectionTitle
            title="Consistency"
            hint="Scheduled days whose target was met"
            aside={<TimeRangeSelector value={range} onChange={setRange} options={HABIT_RANGE_OPTIONS} label="Habits time frame" testId="habits-range" />}
          />
          <div className="grid grid-cols-3 gap-2 -mt-1">
            <StatTile
              label="Completion"
              value={<span data-testid="text-habits-completion">{summary.completion.percent == null ? "—" : `${summary.completion.percent}%`}</span>}
              basis={`${summary.completion.complete}/${summary.completion.scheduled} days · ${rangeLabel}`}
              hs={HABITS_HS[0]}
              i={0}
            />
            <StatTile
              label="Streak"
              value={<span data-testid="text-habits-best-streak">{summary.best}</span>}
              basis={summary.best === 1 ? "day · best now" : "days · best now"}
              icon={Flame}
              hs="24 92%"
              i={1}
            />
            <StatTile
              label="Record"
              value={summary.longest}
              basis="longest run"
              icon={Trophy}
              hs="40 92%"
              i={2}
            />
          </div>

          {/* Which habits are slipping — one meter per habit, in its own color. */}
          {summary.perHabit.length > 1 && (
            <div className="bubble p-4 space-y-3" data-testid="habits-consistency">
              {summary.perHabit.map(({ habit, accent, c }) => (
                <MeterRow
                  key={habit.id}
                  label={habit.name}
                  value={c.percent == null ? "—" : `${c.percent}%`}
                  pct={c.percent ?? 0}
                  hs={accent.hs}
                />
              ))}
            </div>
          )}
          <CoverageNote>
            Today counts once it's done, so an unfinished day never lowers the rate. Days before a habit existed aren't counted. The line under today's numbers is daily completion, averaged over 7 days.
          </CoverageNote>

          <div className="grid gap-3 md:grid-cols-2">
            {habits.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(habit => (
              <HabitCard key={habit.id} habit={habit} rangeDays={rangeDays} rangeLabel={rangeLabel} />
            ))}
          </div>
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
