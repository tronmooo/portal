// ── Tasks + Habits popups (extracted from pages/dashboard.tsx, 2026-07-08) ───
// Moved verbatim so the hub KPI strip (eagerly loaded) and any other surface
// can open the SAME popups the dashboard KPI tiles use, without importing the
// ~7k-line dashboard page chunk. Exported: TasksPopup, HabitsPopup.
// Behavior is unchanged — only the module boundary moved.
import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { habitDayProgress, habitsDayRollup } from "@shared/habit-progress";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import { normalizeFilter } from "@/lib/filter-utils";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import {
  RECUR_PRESETS, parseRecurrence, recurrenceToTags, isRecurring as isRecurringRule,
  nextOccurrence as nextRecurOccurrence, seriesEnded, humanSummary, freqToUnit,
  type RecurrenceRule,
} from "@shared/recurrence";
import { groupMaterializedSeries } from "@shared/series-detect";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BubbleModal } from "@/components/ui/bubble-modal";

// Tasks and habits are Executive-tab concepts; they take its accent so opening
// this popup from anywhere still reads as the same part of the app.
const TASKS_ACCENT = "262 70% 62%";
const HABITS_ACCENT = "155 65% 45%";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlarmClock, AlertTriangle, ArrowDown, Bell, Calendar, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronUp, ChevronsUpDown, Clock, FileText, Flag,
  Flame, ListChecks, ListTodo, Pause, Play, Plus, Repeat, SkipForward,
  Sparkles, Tag as TagIcon, Target, Timer, Trash2, X,
} from "lucide-react";

// Same short-date formatter the dashboard page uses (kept local — 2 lines).
//
// The `T00:00:00` is load-bearing. `new Date("2026-08-08")` is parsed as UTC
// midnight, and rendering that in any timezone west of UTC lands on the
// PREVIOUS day — so a task due Aug 8 read "Aug 7" here while the Calendar tab
// correctly said August 8 (reported 2026-08-04, visible on every dated task,
// not just the refills). Appending the time parses it as LOCAL midnight, which
// is what a bare YYYY-MM-DD due date means.
function fmtDate(d: string): string {
  return new Date(`${String(d ?? "").slice(0, 10)}T00:00:00`)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// ─── Tasks Popup ──────────────────────────────────────────────────────────────

// U1 fix forward declaration: TasksPopup uses a confirmation AlertDialog before
// permanently deleting a completed task. State held inside the component.
export function TasksPopup({ open, onClose, filterIds = [], filterMode = "everyone" }: { open: boolean; onClose: () => void; filterIds?: string[]; filterMode?: string }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  // Which task is expanded into the detail/edit panel.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Active tab — organizes tasks the way a task manager does. "One-time" and
  // "Recurring" are the two kinds a task can be, and they get separate homes:
  // a to-do you do once and are finished with is not a schedule.
  const [tab, setTab] = useState<"today" | "onetime" | "recurring" | "upcoming">("today");
  // Rich add-task composer. `kind` is the task's category — one-time (done once
  // and finished) or recurring (a standing schedule). One-time is the default
  // and the common case; picking it keeps `recurrence` empty, which is what
  // keeps the task off the Recurring tab.
  const emptyComposer = { open: false, title: "", kind: "onetime" as "onetime" | "recurring", priority: "medium", recurrence: "", dueDate: "", dueTime: "", category: "" };
  const [composer, setComposer] = useState(emptyComposer);
  // Reveal completed tasks (collapsed by default — no dedicated tab anymore).
  const [showCompleted, setShowCompleted] = useState(false);
  // Sort within a tab.
  const [sortBy, setSortBy] = useState<"smart" | "priority" | "due">("smart");
  // U1 fix: track which task is pending confirmation before delete.
  // `seriesIds` is set when the task belongs to a detected schedule, so the
  // dialog can offer "just this one" vs "the whole series" instead of silently
  // deleting one row and leaving the other occurrences behind.
  const [taskToDelete, setTaskToDelete] = useState<{ id: string; title: string; seriesIds?: string[] } | null>(null);
  // Profiles for the assigned-to chip (id → name).
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: open,
  });
  const profileName = (id: string) => allProfiles.find((p: any) => p.id === id)?.name || "Someone";
  // Force refetch when popup opens — prevents stale cache after AI chat mutations
  useEffect(() => { if (open) { queryClient.invalidateQueries({ queryKey: ["/api/tasks"] }); } }, [open]);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // PERF: isPending (not isLoading) so placeholderData keepPreviousData keeps prior list visible on filter switch.
  const { data: tasksRaw = [], isPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/tasks${profileParam}`).then(r => r.json()),
    enabled: open,
  });
  const isLoading = isPending;
  // Same test-data preference the dashboard header toggle drives — QA/AUDIT
  // rows stay out of the popup unless "Show test data" is on.
  const showTestData = useShowTestData();
  const tasks = useMemo(
    () => showTestData ? tasksRaw : tasksRaw.filter((t: any) => !isTestDataRow(t.title) && !isTestDataRow(t.description)),
    [tasksRaw, showTestData],
  );

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, any>) => apiRequest("POST", "/api/tasks", { status: "todo", priority: "medium", ...payload }).then(r => r.json()),
    onMutate: async (payload: Record<string, any>) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prev = queryClient.getQueryData(["/api/tasks", filterMode, ...filterIds]);
      const tempId = 'tmp-' + Date.now();
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) =>
        [{ id: tempId, status: 'todo', priority: 'medium', tags: [], linkedProfiles: [], ...payload }, ...(old || [])]
      );
      // Confirm INSTANTLY, matching the optimistic UI. The toast used to fire
      // in onSettled, so on a cold serverless write it arrived seconds after
      // the row appeared (user report: "notification comes 30 seconds later")
      // — and onSettled also runs on FAILURE, so a failed create showed
      // "Failed to create task" immediately followed by "Task added".
      toast({ title: "Task added" });
      return { prev, tempId };
    },
    onSuccess: (serverTask: any, _v, ctx: any) => {
      // Swap the tmp row for the real row the moment the create resolves —
      // shrinks the window in which a tap on the new task targets a synthetic
      // id (the tmp-…-404 red-error class) from "until refetch" to ~0.
      if (serverTask?.id && ctx?.tempId) {
        queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) =>
          (old || []).map((t: any) => t.id === ctx.tempId ? serverTask : t));
      }
    },
    onError: (_e, _v, ctx: any) => {
      if (ctx?.prev) {
        queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      } else {
        queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) => old?.filter((t: any) => !String(t.id).startsWith('tmp-')));
      }
      toast({ title: "Failed to create task", variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("tasks"); },
  });

  // ─ Helper: optimistically adjust stats.activeTasks & dashboard-enhanced ─
  // The KPI tile (Open Tasks) and the popup pull from different queries.
  // To make the chip flip instantly when you check a task off, we patch
  // both /api/stats and /api/dashboard-enhanced in the cache BEFORE the
  // server roundtrip resolves. Server data wins on next refetch.
  const patchStatsTaskDelta = (delta: number) => {
    const statsKey = ["/api/stats", filterMode, ...filterIds];
    queryClient.setQueryData<any>(statsKey, (old: any) => {
      if (!old) return old;
      const next = Number(old.activeTasks || 0) + delta;
      return { ...old, activeTasks: Math.max(0, next) };
    });
    const dashKey = ["/api/dashboard-enhanced", filterMode, ...filterIds];
    queryClient.setQueryData<any>(dashKey, (old: any) => {
      if (!old || !old.taskSnapshot) return old;
      const open = Math.max(0, Number(old.taskSnapshot.open || 0) + delta);
      return { ...old, taskSnapshot: { ...old.taskSnapshot, open } };
    });
  };

  // Optimistic rows carry a synthetic id ("tmp-…"/"temp-…") until the server
  // create lands and the refetch swaps in the real row. Acting on one PATCHes
  // /api/tasks/tmp-… → 404 → a red "Failed to update task" even though the
  // task exists (caught live: HTTP 404 PATCH /api/tasks/tmp-17841…). On a cold
  // serverless write that window is seconds long, so fast taps hit it easily.
  const STILL_SAVING = "STILL_SAVING";
  const isTempId = (id: any) => /^te?mp-/.test(String(id));
  const stillSavingToast = () => toast({ title: "Still saving…", description: "That item is a moment from being created — try again in a second." });

  const toggleMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string; title?: string }) => {
      if (isTempId(id)) throw new Error(STILL_SAVING);
      return apiRequest("PATCH", `/api/tasks/${id}`, { status });
    },
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks", filterMode, ...filterIds] });
      const prev = queryClient.getQueryData<any[]>(["/api/tasks", filterMode, ...filterIds]);
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      const prevDash = queryClient.getQueryData<any>(["/api/dashboard-enhanced", filterMode, ...filterIds]);
      // Update the task list itself
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) =>
        (old || []).map((t: any) => t.id === id ? { ...t, status } : t)
      );
      // Compute the active-task delta from the PREVIOUS state so toggling
      // back and forth always adjusts correctly.
      const prevTask = (prev || []).find(t => t.id === id);
      const wasDone = String(prevTask?.status || "").toLowerCase() === "done";
      const isDone = String(status).toLowerCase() === "done";
      if (wasDone !== isDone) {
        patchStatsTaskDelta(isDone ? -1 : +1);
      }
      // Instant confirmation (see create-task note): the UI already flipped,
      // so the toast must not wait for the server roundtrip — and must never
      // fire from onSettled, which also runs when the request FAILED.
      toast({ title: status === 'done' ? "Task completed" : "Task updated" });
      return { prev, prevStats, prevDash };
    },
    onError: (e: any, _v, ctx: any) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      if (ctx?.prevDash !== undefined) queryClient.setQueryData(["/api/dashboard-enhanced", filterMode, ...filterIds], ctx.prevDash);
      if (String(e?.message) === STILL_SAVING) { stillSavingToast(); return; }
      toast({ title: "Failed to update task", variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("tasks");
    },
  });

  // Deleting a whole detected schedule: every generated row goes, so the
  // schedule disappears from Tasks, the Calendar grid and the Recurring Dates
  // tab together (all three read the same task rows). Deleting one row only
  // would shrink the series and leave it listed — reported 2026-08-04.
  const deleteSeriesMutation = useMutation({
    mutationFn: async ({ ids }: { ids: string[]; title: string }) => {
      const real = ids.filter((id) => !isTempId(id));
      if (real.length === 0) throw new Error(STILL_SAVING);
      // Sequential, not parallel: a burst of deletes against the same user hits
      // the write path harder than the saving is worth.
      for (const id of real) await apiRequest("DELETE", `/api/tasks/${id}`);
      return real.length;
    },
    onSuccess: (count: number, { title }) => {
      toast({ title: `Deleted ${count} occurrence${count === 1 ? "" : "s"}`, description: `“${title}” was removed from your tasks, calendar and recurring dates.` });
    },
    onError: (e: any) => {
      if (String(e?.message) === STILL_SAVING) { stillSavingToast(); return; }
      toast({ title: "Couldn't delete the series", variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("tasks"); },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => {
      // Deleting a temp row would no-op on the server while the real task is
      // still being created — it would then "come back" on refetch.
      if (isTempId(id)) throw new Error(STILL_SAVING);
      return apiRequest("DELETE", `/api/tasks/${id}`);
    },
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks", filterMode, ...filterIds] });
      const prev = queryClient.getQueryData<any[]>(["/api/tasks", filterMode, ...filterIds]);
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      const prevDash = queryClient.getQueryData<any>(["/api/dashboard-enhanced", filterMode, ...filterIds]);
      const removed = (prev || []).find(t => t.id === id);
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) => (old || []).filter((t: any) => t.id !== id));
      // If the deleted task was open, drop the active-task count too
      if (removed && String(removed.status || "").toLowerCase() !== "done") {
        patchStatsTaskDelta(-1);
      }
      // Instant confirmation (see create-task note).
      toast({ title: "Task deleted" });
      return { prev, prevStats, prevDash };
    },
    onError: (e: any, _v, ctx: any) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      if (ctx?.prevDash !== undefined) queryClient.setQueryData(["/api/dashboard-enhanced", filterMode, ...filterIds], ctx.prevDash);
      if (String(e?.message) === STILL_SAVING) { stillSavingToast(); return; }
      toast({ title: "Failed to delete task", variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("tasks");
    },
  });

  // Generic field update (priority, dueDate, description, recurrence-via-tags).
  // Patches the cached list optimistically so edits feel instant.
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, any> }) => {
      if (isTempId(id)) throw new Error(STILL_SAVING);
      return apiRequest("PATCH", `/api/tasks/${id}`, patch).then(r => r.json());
    },
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks", filterMode, ...filterIds] });
      const prev = queryClient.getQueryData<any[]>(["/api/tasks", filterMode, ...filterIds]);
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) =>
        (old || []).map((t: any) => t.id === id ? { ...t, ...patch } : t));
      return { prev };
    },
    onError: (e: any, _v, ctx: any) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      if (String(e?.message) === STILL_SAVING) { stillSavingToast(); return; }
      toast({ title: "Couldn't update task", variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("tasks"); },
  });

  // ── Recurrence + metadata helpers ──
  // Recurrence rules and rich task metadata live in the task's `tags` array (no
  // schema column), so everything persists through the normal tasks API.
  // ── Schedules written as several rows ──
  //
  // Not every repeating task carries a `recur:` tag. A monthly prescription
  // refill was generated as six separate dated rows ("… - August", "… -
  // September", …) with no rule between them, so this popup filed them under
  // One-time and reported "Recurring (0)" — reported 2026-08-04, and the same
  // gap the Recurring Dates screen had. `groupMaterializedSeries` recognises
  // the shape at read time (shared/series-detect); nothing is migrated.
  //
  // Detection runs over ALL tasks, completed ones included: the finished May–
  // July refills are the evidence that the remaining three are a monthly
  // schedule and not three coincidences.
  const detectedSeries = useMemo(() => {
    const groups = groupMaterializedSeries(
      (tasks || [])
        .filter((t: any) => t?.id && t.dueDate)
        .map((t: any) => ({
          id: String(t.id),
          title: t.title,
          date: String(t.dueDate).slice(0, 10),
          ownerId: Array.isArray(t.linkedProfiles) ? t.linkedProfiles[0] ?? null : null,
          tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
          row: t,
        })),
    );
    const byId = new Map<string, { recurrence: string; openIds: string[]; rowIds: string[] }>();
    const anchors = new Set<string>();
    for (const g of groups) {
      const open = g.rows.filter((r: any) => normalizeFilter(r.row.status) !== normalizeFilter("done"));
      if (open.length === 0) continue; // schedule already finished
      anchors.add(open[0].id);
      const meta = { recurrence: g.recurrence, openIds: open.map((r: any) => r.id), rowIds: g.rows.map((r: any) => r.id) };
      for (const r of g.rows) byId.set(r.id, meta);
    }
    return { byId, anchors };
  }, [tasks]);
  /** Every member of a detected schedule, anchor or not. */
  const inSeries = (t: any) => detectedSeries.byId.has(String(t?.id));
  /** The one row that REPRESENTS the schedule — its earliest open occurrence. */
  const isSeriesAnchor = (t: any) => detectedSeries.anchors.has(String(t?.id));
  const seriesMetaOf = (t: any) => detectedSeries.byId.get(String(t?.id));

  const ruleOf = (t: any): RecurrenceRule => {
    const tagged = parseRecurrence(t.tags || []);
    if (tagged.freq) return tagged;
    // A detected schedule has a real cadence even with no rule in its tags, so
    // the card can say "Monthly" instead of "Does not repeat".
    const meta = seriesMetaOf(t);
    if (!meta) return tagged;
    return { ...tagged, freq: meta.recurrence, ...freqToUnit(meta.recurrence) };
  };
  const isReminderT = (t: any) => (t.tags || []).includes("reminder") || t.source === "reminder";
  const isRecurringT = (t: any) => isRecurringRule(t.tags || []) || inSeries(t);
  const setRule = (t: any, rule: RecurrenceRule) =>
    updateMutation.mutate({ id: t.id, patch: { tags: recurrenceToTags(rule, t.tags || []) } });

  // Single-value metadata tags: cat:<x>, time:<HH:MM>, remind:<offset>, est:<min>.
  const metaOf = (t: any, prefix: string) => {
    const tag = (t.tags || []).find((x: string) => x.startsWith(prefix));
    return tag ? tag.slice(prefix.length) : "";
  };
  const setMetaTag = (t: any, prefix: string, value: string) => {
    const tags = (t.tags || []).filter((x: string) => !x.startsWith(prefix));
    if (value) tags.push(prefix + value);
    updateMutation.mutate({ id: t.id, patch: { tags } });
  };
  /**
   * A task's clock time is a column (2026-08-09), not a tag. Older rows carry
   * it as `time:HH:MM`, so writing the column also strips the tag — otherwise
   * the two would disagree and the reader below would keep preferring the
   * column while the tag quietly said something else.
   */
  const setDueTime = (t: any, value: string) => {
    const tags = (t.tags || []).filter((x: string) => !x.startsWith("time:"));
    // null, not undefined — JSON drops undefined, and the server reads null as
    // "clear it" (an empty HH:MM would fail validation).
    updateMutation.mutate({ id: t.id, patch: { dueTime: value || null, tags } });
  };
  const hasFlag = (t: any, flag: string) => (t.tags || []).includes(flag);
  const toggleFlag = (t: any, flag: string) => {
    const turningOn = !hasFlag(t, flag);
    const tags = turningOn ? [...(t.tags || []), flag] : (t.tags || []).filter((x: string) => x !== flag);
    // Marking a task all-day drops its hour rather than leaving a disabled
    // input showing a time the calendar no longer honours.
    const patch: Record<string, any> = { tags };
    if (flag === "allday" && turningOn) {
      patch.dueTime = null;
      patch.tags = tags.filter((x: string) => !x.startsWith("time:"));
    }
    updateMutation.mutate({ id: t.id, patch });
  };

  // Priority gains a 4th level — "critical" — encoded as a `prio:critical` tag
  // on top of the stored priority (kept "high" for calendar compatibility).
  const effPrio = (t: any): string => (hasFlag(t, "prio:critical") ? "critical" : t.priority);
  const setPriority = (t: any, p: string) => {
    const tags = (t.tags || []).filter((x: string) => x !== "prio:critical");
    if (p === "critical") { tags.push("prio:critical"); updateMutation.mutate({ id: t.id, patch: { priority: "high", tags } }); }
    else updateMutation.mutate({ id: t.id, patch: { priority: p, tags } });
  };

  // Subtasks: `st:<0|1>:<text>` tags → checklist with completion %.
  const subtasksOf = (t: any) => (t.tags || []).filter((x: string) => x.startsWith("st:"))
    .map((raw: string) => ({ raw, done: raw[3] === "1", text: raw.slice(5) }));
  const addSubtask = (t: any, text: string) => {
    if (!text.trim()) return;
    updateMutation.mutate({ id: t.id, patch: { tags: [...(t.tags || []), `st:0:${text.trim()}`] } });
  };
  const toggleSubtask = (t: any, raw: string) =>
    updateMutation.mutate({ id: t.id, patch: { tags: (t.tags || []).map((x: string) => x === raw ? `st:${x[3] === "1" ? "0" : "1"}:${x.slice(5)}` : x) } });
  const removeSubtask = (t: any, raw: string) =>
    updateMutation.mutate({ id: t.id, patch: { tags: (t.tags || []).filter((x: string) => x !== raw) } });

  // User-facing free tags (everything that isn't a system-encoded tag).
  const SYS_TAG_RE = /^(recur:|runtil:|rcount:|rdone:|rpaused$|prio:|cat:|time:|remind:|est:|st:|reminder$|allday$)/;
  const freeTagsOf = (t: any) => (t.tags || []).filter((x: string) => !SYS_TAG_RE.test(x));

  // ── Recurring lifecycle ──
  const completeTask = (t: any) => {
    const rule = ruleOf(t);
    if (rule.freq && !rule.paused) {
      const next = nextRecurOccurrence(t.dueDate, rule);
      if (seriesEnded(rule, next)) {
        toggleMutation.mutate({ id: t.id, status: "done" });
        toast({ title: "Series complete 🎉" });
      } else {
        const tags = recurrenceToTags({ ...rule, done: rule.done + 1 }, t.tags || []);
        updateMutation.mutate({ id: t.id, patch: { dueDate: next || t.dueDate, tags } });
        toast({ title: `Done — next on ${next ? fmtDate(next) : "schedule"}` });
      }
    } else {
      toggleMutation.mutate({ id: t.id, status: "done" });
    }
  };
  const skipOccurrence = (t: any) => {
    const next = nextRecurOccurrence(t.dueDate, ruleOf(t));
    updateMutation.mutate({ id: t.id, patch: { dueDate: next || t.dueDate } });
    toast({ title: `Skipped to ${next ? fmtDate(next) : "next"}` });
  };
  const togglePause = (t: any) => { const r = ruleOf(t); setRule(t, { ...r, paused: !r.paused }); };
  const endSeries = (t: any) => { setRule(t, { freq: "", interval: 1, unit: "", done: 0, paused: false }); toast({ title: "Repeat ended" }); };

  // ── Date scaffolding for smart sections ──
  const todayStr = new Date().toLocaleDateString('en-CA');
  const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const tomorrowStr = addDays(1);
  const daysToSunday = (7 - new Date().getDay()) % 7;
  const endThisWeek = addDays(daysToSunday);
  const endNextWeek = addDays(daysToSunday + 7);
  // A pending task's effective date: its dueDate, or today for an undated recurring chore.
  const whenOf = (t: any): string | null => t.dueDate || (isRecurringT(t) ? todayStr : null);
  // Paused recurring chores don't surface a next occurrence in the date views.
  const datedVisible = (t: any) => !(isRecurringT(t) && ruleOf(t).paused);

  const PRIO_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortTasks = (list: any[]) => {
    if (sortBy === "priority") return [...list].sort((a, b) => (PRIO_RANK[effPrio(a)] ?? 2) - (PRIO_RANK[effPrio(b)] ?? 2));
    const clockOf = (t: any) => t.dueTime || metaOf(t, "time:") || "99:99";
    if (sortBy === "due") return [...list].sort((a, b) => ((a.dueDate || "9999") + clockOf(a)).localeCompare((b.dueDate || "9999") + clockOf(b)));
    return list; // smart = server order
  };

  const pendingAll = useMemo(() => tasks.filter((t: any) => normalizeFilter(t.status) !== normalizeFilter('done')), [tasks]);
  const done = useMemo(() => tasks.filter((t: any) => normalizeFilter(t.status) === normalizeFilter('done')).slice(0, 8), [tasks]);

  // Today tab = overdue + due-today (+ undated one-offs). Recurring chores flow
  // in here too, by their next occurrence date.
  const overdueTasks = useMemo(() => sortTasks(pendingAll.filter((t: any) => datedVisible(t) && t.dueDate && t.dueDate < todayStr)), [pendingAll, todayStr, sortBy]);
  const todayTasks = useMemo(() => sortTasks(pendingAll.filter((t: any) => datedVisible(t) && (whenOf(t) === todayStr || (!t.dueDate && !isRecurringT(t))))), [pendingAll, todayStr, sortBy]);
  // Recurring tab = every series (incl. paused) for management. A DETECTED
  // schedule contributes ONE row — its earliest open occurrence — not one row
  // per generated task, or "the monthly refill" would read as three separate
  // recurring tasks.
  const recurringTasks = useMemo(
    () => sortTasks(pendingAll.filter((t: any) => isRecurringRule(t.tags || []) || isSeriesAnchor(t))),
    [pendingAll, sortBy, detectedSeries],
  );
  // One-time tab = every task that carries NO repeat schedule — the default
  // shape of a task, and the counterpart to the Recurring tab. Grouped by when
  // it is due so a long list stays scannable; undated one-offs get their own
  // section instead of being findable only on Today.
  const oneTimeTasks = useMemo(() => sortTasks(pendingAll.filter((t: any) => !isRecurringT(t))), [pendingAll, sortBy]);
  const oneTimeSections = useMemo(() => {
    const buckets: Record<string, any[]> = { overdue: [], today: [], later: [], undated: [] };
    for (const t of oneTimeTasks) {
      if (!t.dueDate) buckets.undated.push(t);
      else if (t.dueDate < todayStr) buckets.overdue.push(t);
      else if (t.dueDate === todayStr) buckets.today.push(t);
      else buckets.later.push(t);
    }
    return [
      { key: "onetime-overdue", label: "Overdue", items: buckets.overdue },
      { key: "onetime-today", label: "Today", items: buckets.today },
      { key: "onetime-later", label: "Upcoming", items: buckets.later },
      { key: "onetime-undated", label: "No date", items: buckets.undated },
    ].filter(s => s.items.length > 0);
  }, [oneTimeTasks, todayStr]);
  // Upcoming tab = everything after today, grouped into smart sections.
  // Recurring series are managed on their own tab — listing their next
  // occurrence here too showed one task on two tabs at once.
  const upcomingPending = useMemo(() => sortTasks(pendingAll.filter((t: any) => !isRecurringT(t) && datedVisible(t) && whenOf(t) && whenOf(t)! > todayStr)), [pendingAll, todayStr, sortBy]);
  const upcomingSections = useMemo(() => {
    const buckets: Record<string, any[]> = { tomorrow: [], week: [], nextweek: [], later: [] };
    for (const t of upcomingPending) {
      const w = whenOf(t)!;
      if (w === tomorrowStr) buckets.tomorrow.push(t);
      else if (w <= endThisWeek) buckets.week.push(t);
      else if (w <= endNextWeek) buckets.nextweek.push(t);
      else buckets.later.push(t);
    }
    return [
      { key: "tomorrow", label: "Tomorrow", items: buckets.tomorrow },
      { key: "week", label: "This Week", items: buckets.week },
      { key: "nextweek", label: "Next Week", items: buckets.nextweek },
      { key: "later", label: "Later", items: buckets.later },
    ].filter(s => s.items.length > 0);
  }, [upcomingPending, tomorrowStr, endThisWeek, endNextWeek]);

  const tabCounts = { today: overdueTasks.length + todayTasks.length, onetime: oneTimeTasks.length, recurring: recurringTasks.length, upcoming: upcomingPending.length };
  // Today progress (done today vs total touched today) for the summary bar.
  const doneToday = useMemo(() => tasks.filter((t: any) => normalizeFilter(t.status) === normalizeFilter('done')).length, [tasks]);
  const todayTotal = overdueTasks.length + todayTasks.length + doneToday;

  // Priority color lines — critical adds a distinct violet above the rest.
  const PLINE: Record<string, string> = { critical: '#9333EA', high: '#E53935', medium: '#FFA726', low: '#42A5F5' };

  const handleAdd = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const title = newTaskTitle.trim();
    if (!title) return;
    createMutation.mutate({ title });
    setNewTaskTitle("");
    setAddingTo(null);
  };

  // Submit the rich composer.
  const submitComposer = () => {
    const title = composer.title.trim();
    if (!title) return;
    const tags: string[] = [];
    // A one-time task carries NO recur: tag, whatever is left sitting in the
    // recurrence select — the kind toggle is the authority.
    const recurrence = composer.kind === "recurring" ? composer.recurrence : "";
    if (recurrence) tags.push(`recur:${recurrence}`);
    if (composer.priority === "critical") tags.push("prio:critical");
    if (composer.category) tags.push(`cat:${composer.category}`);
    createMutation.mutate({
      title,
      priority: composer.priority === "critical" ? "high" : composer.priority,
      tags,
      ...(composer.dueDate ? { dueDate: composer.dueDate } : recurrence ? { dueDate: todayStr } : {}),
      // A task's clock time is a real column (2026-08-09), not a `time:` tag.
      // The tag was invisible to the calendar and to notifications, which is
      // why timed work had to be filed as a "reminder" to be seen at all.
      ...(composer.dueTime ? { dueTime: composer.dueTime } : {}),
    });
    setComposer(emptyComposer);
  };

  // Reminder offset presets (label ↔ encoded value).
  const REMINDER_OPTS = [
    { value: "", label: "No reminder" },
    { value: "0", label: "At due time" },
    { value: "5m", label: "5 min before" },
    { value: "15m", label: "15 min before" },
    { value: "30m", label: "30 min before" },
    { value: "1h", label: "1 hour before" },
    { value: "1d", label: "1 day before" },
  ];
  const CATEGORY_OPTS = ["", "home", "work", "health", "finance", "errands", "family", "auto"];

  const TaskRow = ({ t, dimmed = false }: { t: any; dimmed?: boolean }) => {
    const rule = ruleOf(t);
    const recurring = !!rule.freq;
    const expanded = expandedId === t.id;
    const onCalendar = !!t.dueDate;
    const ep = effPrio(t);
    const pColor = PLINE[ep] || '#42A5F5';
    const subs = subtasksOf(t);
    const subDone = subs.filter((s: any) => s.done).length;
    // `dueTime` is the column; `time:` is the legacy tag rows carried before
    // 2026-08-09. Read both so an older task still shows its hour.
    const dTime = t.dueTime || metaOf(t, "time:");
    const cat = metaOf(t, "cat:");
    const est = metaOf(t, "est:");
    const overdue = !dimmed && t.dueDate && t.dueDate < todayStr;
    const [adv, setAdv] = useState(false);
    const [newSub, setNewSub] = useState("");
    const [newTag, setNewTag] = useState("");
    return (
    <div
      className={`rounded-xl border transition-all ${dimmed ? 'opacity-50 border-border/30 bg-card/40' : expanded ? 'border-emerald-500/50 bg-card shadow-[0_0_0_1px_rgba(16,185,129,0.35),0_4px_20px_-6px_rgba(16,185,129,0.25)]' : overdue ? 'border-red-500/40 bg-card/60 hover:bg-card' : 'border-border/50 bg-card/60 hover:border-border hover:bg-card'}`}
      data-testid={`task-card-${t.id}`}
    >
      <div className="flex items-start gap-2.5 p-3">
        {/* Glowing circular checkbox — completing a recurring task advances it */}
        <button
          onClick={() => dimmed ? toggleMutation.mutate({ id: t.id, status: 'todo' }) : completeTask(t)}
          className="shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center touch-manipulation -m-1"
          aria-label={dimmed ? "Mark as not done" : "Mark as done"}
        >
          <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${dimmed ? 'bg-emerald-500/15 border-emerald-500/40' : expanded ? 'border-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'border-muted-foreground/40 hover:border-emerald-500'}`}>
            {(dimmed || expanded) && <Check className={`h-3.5 w-3.5 ${dimmed ? 'text-emerald-500/60' : 'text-emerald-500'}`} strokeWidth={3} />}
          </div>
        </button>
        {/* Title + meta — click to expand */}
        <button className="flex-1 min-w-0 text-left" onClick={() => setExpandedId(expanded ? null : t.id)} data-testid={`task-row-${t.id}`} aria-expanded={expanded}>
          <div className="flex items-center gap-1.5">
            {!dimmed && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: pColor }} title={ep} />}
            <p className={`text-[15px] font-medium ${dimmed ? 'line-through text-muted-foreground' : 'text-foreground'} truncate`}>{t.title}</p>
          </div>
          {!dimmed && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {ep === 'critical' && <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-violet-500/15 text-violet-500 font-semibold">Critical</span>}
              {overdue && <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 font-semibold">Overdue</span>}
              {/* The task's kind, always stated. A schedule says how often it
                  comes back; a one-time task says it doesn't — silence used to
                  be the only marker, which is how six one-offs sat under
                  "Repeats daily" without looking wrong. */}
              {recurring
                ? <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-md bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" data-testid={`task-kind-recurring-${t.id}`}><Repeat className="h-2.5 w-2.5" />{rule.paused ? 'Paused' : humanSummary(rule, t.dueDate)}</span>
                : <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground" data-testid={`task-kind-onetime-${t.id}`}><ListTodo className="h-2.5 w-2.5" />One-time</span>}
              {t.dueDate && <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground"><Calendar className="h-2.5 w-2.5" />{fmtDate(t.dueDate)}{dTime ? ` · ${dTime}` : ''}</span>}
              {cat && <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400 capitalize"><TagIcon className="h-2.5 w-2.5" />{cat}</span>}
              {metaOf(t, "remind:") && <Bell className="h-3 w-3 text-amber-500" />}
              {subs.length > 0 && <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground"><ListChecks className="h-2.5 w-2.5" />{subDone}/{subs.length}</span>}
              {t.description && <FileText className="h-3 w-3 text-muted-foreground/50" />}
            </div>
          )}
        </button>
        {/* Right: delete (completed) / expand */}
        <div className="flex items-center gap-1.5 shrink-0">
          {dimmed ? (
            <button onClick={() => setTaskToDelete({ id: t.id, title: t.title, seriesIds: seriesMetaOf(t)?.rowIds })} disabled={deleteMutation.isPending}
              className="text-muted-foreground/40 hover:text-destructive min-w-[36px] min-h-[36px] flex items-center justify-center disabled:opacity-40" aria-label="Delete task" data-testid={`btn-delete-task-${t.id}`}><X className="h-3.5 w-3.5" /></button>
          ) : (
            <button onClick={() => setExpandedId(expanded ? null : t.id)} className="min-w-[36px] min-h-[36px] flex items-center justify-center text-muted-foreground/50" aria-label="Edit task" data-testid={`task-expand-${t.id}`}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {/* ── Expanded detail / edit panel ── */}
      {expanded && !dimmed && (
        <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border/30 mt-0" data-testid={`task-detail-${t.id}`}>
          {/* Title */}
          <input defaultValue={t.title} placeholder="Task title"
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.title) updateMutation.mutate({ id: t.id, patch: { title: v } }); }}
            className="w-full text-sm font-semibold bg-transparent border-b border-border/40 pb-1.5 mt-1 focus:outline-none focus:border-primary" data-testid="task-title-edit" />
          {/* Priority — 4 levels incl. Critical */}
          <div>
            <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><Flag className="h-3 w-3" />Priority</label>
            <div className="grid grid-cols-4 gap-1.5">
              {(["low", "medium", "high", "critical"] as const).map(p => (
                <button key={p} onClick={() => setPriority(t, p)}
                  className={`text-[11px] py-1.5 rounded-lg border capitalize transition-colors ${ep === p ? 'text-white border-transparent' : 'bg-muted/40 border-border text-muted-foreground hover:bg-muted'}`}
                  style={ep === p ? { backgroundColor: PLINE[p] } : undefined}
                  data-testid={`task-priority-${p}`}
                >{p}</button>
              ))}
            </div>
          </div>
          {/* Due date + time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><Calendar className="h-3 w-3" />Due date</label>
              <input type="date" value={t.dueDate || ""} onChange={e => updateMutation.mutate({ id: t.id, patch: { dueDate: e.target.value || undefined } })}
                className="w-full text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary" data-testid="task-due-date" />
            </div>
            <div>
              <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><Clock className="h-3 w-3" />Due time</label>
              {/* Writes the real `dueTime` column and clears any legacy
                  `time:` tag, so one task can never carry two clock times. */}
              <input type="time" value={dTime} disabled={hasFlag(t, 'allday')} onChange={e => setDueTime(t, e.target.value)}
                className="w-full text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-40" data-testid="task-due-time" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={hasFlag(t, 'allday')} onChange={() => toggleFlag(t, 'allday')} className="rounded accent-emerald-500" data-testid="task-allday" />
            All-day (no specific time)
          </label>
          {/* Quick reschedule */}
          <div className="flex items-center gap-1.5">
            {[
              { label: "Today", to: () => todayStr },
              { label: "Tomorrow", to: () => addDays(1) },
              { label: "+1 week", to: () => { const d = t.dueDate ? new Date(t.dueDate + 'T00:00:00') : new Date(); d.setDate(d.getDate() + 7); return d.toLocaleDateString('en-CA'); } },
            ].map(q => (
              <button key={q.label} onClick={() => updateMutation.mutate({ id: t.id, patch: { dueDate: q.to() } })}
                className="text-[11px] px-2 py-1 rounded-md bg-muted/50 text-muted-foreground hover:bg-muted" data-testid={`task-snooze-${q.label}`}>{q.label}</button>
            ))}
          </div>
          {/* Task type — the same one-time/recurring choice the composer makes,
              so a mis-filed task is two taps from the right tab. Switching to
              One-time drops the whole rule (and its until/count bookkeeping). */}
          <div>
            <label className="micro-label font-semibold text-muted-foreground mb-1 block">Task type</label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                { key: "onetime", label: "One-time", icon: ListTodo },
                { key: "recurring", label: "Recurring", icon: Repeat },
              ] as const).map(({ key, label, icon: Icon }) => {
                const on = key === "recurring" ? recurring : !recurring;
                return (
                  <button key={key} data-testid={`task-kind-${key}`}
                    onClick={() => {
                      if (on) return;
                      if (key === "onetime") endSeries(t);
                      else { const u = freqToUnit("weekly"); setRule(t, { ...rule, freq: "weekly", unit: u.unit, interval: u.interval }); }
                    }}
                    className={`inline-flex items-center justify-center gap-1.5 text-[11px] py-1.5 rounded-lg border transition-colors ${on ? 'bg-foreground text-background border-transparent font-semibold' : 'bg-muted/40 border-border text-muted-foreground hover:bg-muted'}`}
                  ><Icon className="h-3 w-3" />{label}</button>
                );
              })}
            </div>
            {!recurring && (
              <p className="text-[11px] text-muted-foreground/70 mt-1" data-testid="task-onetime-note">
                Done once, then it's finished. It won't come back.
              </p>
            )}
          </div>
          {/* Repeat preset + live preview */}
          {recurring && (
          <div>
            <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><Repeat className="h-3 w-3" />Repeat</label>
            <select value={RECUR_PRESETS.some(o => o.value === rule.freq) ? rule.freq : (rule.freq ? "__custom" : "")}
              onChange={e => { if (e.target.value === "__custom") return; const f = e.target.value; const u = freqToUnit(f); setRule(t, { ...rule, freq: f, unit: u.unit, interval: u.interval, ...(f ? {} : { until: undefined, count: undefined, done: 0, paused: false }) }); }}
              className="w-full text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary" data-testid="task-recurrence">
              {RECUR_PRESETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              {rule.freq && !RECUR_PRESETS.some(o => o.value === rule.freq) && <option value="__custom">Custom…</option>}
            </select>
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1.5 flex items-center gap-1" data-testid="task-recur-summary">
              <Sparkles className="h-3 w-3" />{humanSummary(rule, t.dueDate)}
              {nextRecurOccurrence(t.dueDate, rule) && !rule.paused && <span className="text-muted-foreground/70">· next {fmtDate(nextRecurOccurrence(t.dueDate, rule)!)}</span>}
            </p>
          </div>
          )}
          {/* Recurring lifecycle controls */}
          {recurring && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button onClick={() => togglePause(t)} data-testid="task-pause" className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted/50 text-muted-foreground hover:bg-muted">
                {rule.paused ? <><Play className="h-3 w-3" />Resume</> : <><Pause className="h-3 w-3" />Pause</>}
              </button>
              <button onClick={() => skipOccurrence(t)} data-testid="task-skip" className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted/50 text-muted-foreground hover:bg-muted"><SkipForward className="h-3 w-3" />Skip</button>
              <button onClick={() => endSeries(t)} data-testid="task-end-repeat" className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted/50 text-muted-foreground hover:bg-muted"><X className="h-3 w-3" />End repeat</button>
            </div>
          )}
          {/* Subtasks / checklist with progress */}
          <div>
            <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><ListChecks className="h-3 w-3" />Subtasks{subs.length > 0 && <span className="text-muted-foreground/60 normal-case">· {subDone}/{subs.length}</span>}</label>
            {subs.length > 0 && (
              <div className="h-1 rounded-full bg-muted overflow-hidden mb-2"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((subDone / subs.length) * 100)}%` }} /></div>
            )}
            <div className="space-y-1">
              {subs.map((s: any) => (
                <div key={s.raw} className="flex items-center gap-2">
                  <button onClick={() => toggleSubtask(t, s.raw)} className="shrink-0" data-testid={`subtask-toggle-${s.raw}`}>
                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${s.done ? 'bg-emerald-500 border-emerald-500' : 'border-muted-foreground/40'}`}>{s.done && <Check className="h-3 w-3 text-white" strokeWidth={3} />}</div>
                  </button>
                  <span className={`flex-1 text-xs ${s.done ? 'line-through text-muted-foreground' : ''}`}>{s.text}</span>
                  <button onClick={() => removeSubtask(t, s.raw)} className="text-muted-foreground/40 hover:text-destructive" aria-label={`Remove subtask ${s.text}`}><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
            <input value={newSub} onChange={e => setNewSub(e.target.value)} placeholder="Add a subtask…"
              onKeyDown={e => { if (e.key === 'Enter') { addSubtask(t, newSub); setNewSub(""); } }}
              className="w-full text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 mt-1 focus:outline-none focus:ring-1 focus:ring-primary" data-testid="task-add-subtask" />
          </div>
          {/* Notes */}
          <div>
            <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><FileText className="h-3 w-3" />Notes</label>
            <textarea defaultValue={t.description || ""} rows={2} placeholder="Add notes…"
              onBlur={e => { if ((e.target.value || "") !== (t.description || "")) updateMutation.mutate({ id: t.id, patch: { description: e.target.value } }); }}
              className="w-full text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary" data-testid="task-notes" />
          </div>
          {/* ── Advanced options (collapsed by default) ── */}
          <button onClick={() => setAdv(a => !a)} className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground" data-testid="task-advanced-toggle">
            <ChevronsUpDown className="h-3 w-3" />{adv ? "Hide advanced" : "Advanced options"}
          </button>
          {adv && (
            <div className="space-y-3 rounded-lg bg-muted/20 p-2.5">
              {/* Custom recurrence builder — recurring tasks only. Touching the
                  interval on a one-time task used to hand it a schedule from a
                  panel that never mentions repeating. */}
              {recurring && (
              <div>
                <label className="micro-label font-semibold text-muted-foreground mb-1 block">Custom repeat</label>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">Every</span>
                  <input type="number" min={1} value={rule.interval}
                    onChange={e => { const n = Math.max(1, parseInt(e.target.value) || 1); const u = (rule.unit || 'day'); const f = u === 'day' ? (n === 1 ? 'daily' : `every-${n}-days`) : u === 'week' ? (n === 1 ? 'weekly' : `every-${n}-weeks`) : u === 'month' ? 'monthly' : u === 'year' ? 'yearly' : 'weekdays'; setRule(t, { ...rule, freq: f, unit: u as any, interval: n }); }}
                    className="w-14 bg-background border border-border rounded-md px-2 py-1 focus:outline-none" data-testid="task-custom-interval" />
                  <select value={rule.unit || 'day'}
                    onChange={e => { const u = e.target.value; const n = (u === 'day' || u === 'week') ? rule.interval : 1; const f = u === 'day' ? (n === 1 ? 'daily' : `every-${n}-days`) : u === 'week' ? (n === 1 ? 'weekly' : `every-${n}-weeks`) : u === 'month' ? 'monthly' : u === 'year' ? 'yearly' : 'weekdays'; setRule(t, { ...rule, freq: f, unit: u as any, interval: n }); }}
                    className="flex-1 bg-background border border-border rounded-md px-2 py-1 focus:outline-none" data-testid="task-custom-unit">
                    <option value="day">day(s)</option>
                    <option value="week">week(s)</option>
                    <option value="month">month</option>
                    <option value="year">year</option>
                    <option value="weekday">weekday</option>
                  </select>
                </div>
                {/* End condition */}
                  <div className="flex items-center gap-1.5 text-xs mt-2">
                    <span className="text-muted-foreground">Ends</span>
                    <select value={rule.until ? 'until' : rule.count ? 'count' : 'never'}
                      onChange={e => { const m = e.target.value; if (m === 'never') setRule(t, { ...rule, until: undefined, count: undefined }); else if (m === 'until') setRule(t, { ...rule, until: rule.until || addDays(30), count: undefined }); else setRule(t, { ...rule, count: rule.count || 5, until: undefined }); }}
                      className="bg-background border border-border rounded-md px-2 py-1 focus:outline-none" data-testid="task-end-mode">
                      <option value="never">Never</option>
                      <option value="until">On date</option>
                      <option value="count">After N times</option>
                    </select>
                    {rule.until && <input type="date" value={rule.until} onChange={e => setRule(t, { ...rule, until: e.target.value })} className="flex-1 bg-background border border-border rounded-md px-2 py-1 focus:outline-none" data-testid="task-end-date" />}
                    {rule.count != null && <input type="number" min={1} value={rule.count} onChange={e => setRule(t, { ...rule, count: Math.max(1, parseInt(e.target.value) || 1) })} className="w-16 bg-background border border-border rounded-md px-2 py-1 focus:outline-none" data-testid="task-end-count" />}
                  </div>
              </div>
              )}
              {/* Category + Reminder */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><TagIcon className="h-3 w-3" />Category</label>
                  <select value={cat} onChange={e => setMetaTag(t, 'cat:', e.target.value)} className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 capitalize focus:outline-none" data-testid="task-category">
                    {CATEGORY_OPTS.map(c => <option key={c} value={c}>{c || "None"}</option>)}
                  </select>
                </div>
                <div>
                  <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><AlarmClock className="h-3 w-3" />Reminder</label>
                  <select value={metaOf(t, "remind:")} onChange={e => setMetaTag(t, 'remind:', e.target.value)} className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 focus:outline-none" data-testid="task-reminder">
                    {REMINDER_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              {/* Estimated duration */}
              <div>
                <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><Timer className="h-3 w-3" />Estimated minutes</label>
                <input type="number" min={0} value={est} onChange={e => setMetaTag(t, 'est:', e.target.value)} placeholder="e.g. 30"
                  className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 focus:outline-none" data-testid="task-estimate" />
              </div>
              {/* Free tags */}
              <div>
                <label className="micro-label font-semibold text-muted-foreground flex items-center gap-1 mb-1"><TagIcon className="h-3 w-3" />Tags</label>
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {freeTagsOf(t).map((tag: string) => (
                    <span key={tag} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">#{tag}
                      <button onClick={() => updateMutation.mutate({ id: t.id, patch: { tags: (t.tags || []).filter((x: string) => x !== tag) } })} className="hover:text-destructive" aria-label={`Remove tag ${tag}`}><X className="h-2.5 w-2.5" /></button>
                    </span>
                  ))}
                </div>
                <input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder="Add tag + Enter"
                  onKeyDown={e => { if (e.key === 'Enter') { const v = newTag.trim().replace(/^#/, ''); if (v && !(t.tags || []).includes(v)) updateMutation.mutate({ id: t.id, patch: { tags: [...(t.tags || []), v] } }); setNewTag(""); } }}
                  className="w-full text-xs bg-background border border-border rounded-lg px-2 py-1.5 focus:outline-none" data-testid="task-add-tag" />
              </div>
            </div>
          )}
          {/* Footer */}
          <div className="flex items-center justify-between pt-0.5">
            {onCalendar
              ? <span className="inline-flex items-center gap-1 text-[11px] text-sky-600 dark:text-sky-400"><CalendarDays className="h-3 w-3" />On calendar</span>
              : <span className="text-[11px] text-muted-foreground/50">Add a due date to put it on the calendar</span>}
            <button onClick={() => setTaskToDelete({ id: t.id, title: t.title, seriesIds: seriesMetaOf(t)?.rowIds })} className="text-[11px] text-muted-foreground/60 hover:text-destructive inline-flex items-center gap-1" data-testid={`task-delete-${t.id}`}>
              <Trash2 className="h-3 w-3" />Delete
            </button>
          </div>
        </div>
      )}
    </div>
    );
  };


  return (
    <>
    {/* The header here was a FIFTH popup design — a red rounded square, an
        ALL-CAPS "TASK MANAGER", a hand-rolled 40px close button and a rose glow.
        BubbleModal supplies all of that now. The progress bar stays, because it
        is information rather than chrome, and moves into the body. */}
    <BubbleModal
      open={open}
      onClose={() => { onClose(); setAddingTo(null); setNewTaskTitle(""); setExpandedId(null); setTab("today"); setComposer(emptyComposer); setShowCompleted(false); }}
      title="Tasks" icon={CheckCircle2} accent={TASKS_ACCENT} count={pendingAll.length}
      testId="popup-tasks"
      footer={
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <ListTodo className="h-4 w-4 text-primary" />
          </div>
          <input
            className="flex-1 text-sm bg-transparent focus:outline-none text-muted-foreground placeholder:text-muted-foreground/60"
            placeholder="I want to..."
            data-testid="input-quick-task"
            value={addingTo === 'quick' ? newTaskTitle : ''}
            onChange={e => { setNewTaskTitle(e.target.value); setAddingTo('quick'); }}
            onKeyDown={handleAdd}
            onFocus={() => setAddingTo('quick')}
          />
        </div>
      }
    >
        {/* Today's progress */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${todayTotal ? Math.round((doneToday / todayTotal) * 100) : 0}%` }} />
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums">{doneToday}/{todayTotal} done today</span>
        </div>

        {/* Tabs — Today / One-time / Recurring / Upcoming + sort */}
        <div className="flex items-center gap-1 py-1 overflow-x-auto scrollbar-hide -mx-1 px-1">
          {([
            { key: "today", label: "Today", icon: Flame },
            { key: "onetime", label: "One-time", icon: ListTodo },
            { key: "recurring", label: "Recurring", icon: Repeat },
            { key: "upcoming", label: "Upcoming", icon: CalendarDays },
          ] as const).map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            const count = (tabCounts as any)[key];
            return (
              <button
                key={key}
                onClick={() => { setTab(key); setExpandedId(null); }}
                data-testid={`task-tab-${key}`}
                className={`inline-flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-lg whitespace-nowrap shrink-0 transition-colors ${active ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted/60'}`}
              >
                <Icon className="h-3.5 w-3.5" />{label}
                <span className={`tabular-nums text-[11px] ${active ? 'opacity-70' : 'opacity-50'}`}>({count})</span>
              </button>
            );
          })}
          <div className="ml-auto shrink-0">
            <button
              onClick={() => setSortBy(s => s === "smart" ? "priority" : s === "priority" ? "due" : "smart")}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/60"
              data-testid="task-sort" title="Change sort order"
            ><ArrowDown className="h-3 w-3" />{sortBy === "smart" ? "Smart" : sortBy === "priority" ? "Priority" : "Due date"}</button>
          </div>
        </div>

        <div>
          {isLoading ? (
            <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
          ) : (
            <div>
              {/* Section header for the active tab */}
              <div className="flex items-center justify-between px-1 mb-2">
                <span className="micro-label text-muted-foreground">
                  {tab === "today" ? "Today's priorities" : tab === "onetime" ? "One-time tasks" : tab === "recurring" ? "Recurring schedules" : "Upcoming"}
                </span>
                <button onClick={() => setComposer(c => ({ ...emptyComposer, open: !c.open, kind: tab === "recurring" ? "recurring" : "onetime", recurrence: tab === "recurring" ? "weekly" : "" }))} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-muted transition-colors" aria-label="Add task" title="Add task" data-testid="button-add-task"><Plus className="h-4 w-4 text-muted-foreground" /></button>
              </div>
              {/* Only tasks on a real schedule belong on the Recurring tab — say
                  where the exit is for anything that landed here by mistake. */}
              {tab === "recurring" && recurringTasks.length > 0 && (
                <p className="px-1 mb-2 text-[11px] text-muted-foreground/70" data-testid="recurring-tab-hint">
                  These repeat on a schedule. Done-once? Open it and tap <span className="font-medium">End repeat</span> to move it to One-time.
                </p>
              )}

              {/* ── Rich add-task composer ── */}
              {composer.open && (
                <div className="mb-3 bubble p-3 space-y-2.5" data-testid="task-composer">
                  <input autoFocus value={composer.title} onChange={e => setComposer(c => ({ ...c, title: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitComposer(); }}
                    placeholder="What needs doing?" data-testid="composer-title"
                    className="w-full text-sm bg-transparent font-medium focus:outline-none placeholder:text-muted-foreground/60" />
                  {/* Priority — 4 levels */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {(["low","medium","high","critical"] as const).map(p => (
                      <button key={p} onClick={() => setComposer(c => ({ ...c, priority: p }))}
                        className={`text-[11px] py-1 rounded-lg border capitalize transition-colors ${composer.priority === p ? 'text-white border-transparent' : 'bg-muted/40 border-border text-muted-foreground'}`}
                        style={composer.priority === p ? { backgroundColor: PLINE[p] } : undefined} data-testid={`composer-priority-${p}`}>{p}</button>
                    ))}
                  </div>
                  {/* Kind — the task's category. One-time is the default and
                      leaves the recurrence select out of the way entirely, so
                      a one-off can't pick up a schedule by accident. */}
                  <div>
                    <label className="micro-label font-semibold text-muted-foreground mb-1 block">Task type</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {([
                        { key: "onetime", label: "One-time", icon: ListTodo },
                        { key: "recurring", label: "Recurring", icon: Repeat },
                      ] as const).map(({ key, label, icon: Icon }) => (
                        <button key={key} data-testid={`composer-kind-${key}`}
                          onClick={() => setComposer(c => ({ ...c, kind: key, recurrence: key === "recurring" ? (c.recurrence || "weekly") : "" }))}
                          className={`inline-flex items-center justify-center gap-1.5 text-[11px] py-1.5 rounded-lg border transition-colors ${composer.kind === key ? 'bg-foreground text-background border-transparent font-semibold' : 'bg-muted/40 border-border text-muted-foreground'}`}
                        ><Icon className="h-3 w-3" />{label}</button>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70 mt-1">
                      {composer.kind === "onetime" ? "Do it once, then it's done — lands on the One-time tab." : "Comes back on a schedule — lands on the Recurring tab."}
                    </p>
                  </div>
                  {/* Repeat (recurring only) + Due date */}
                  <div className="grid grid-cols-2 gap-2">
                    {composer.kind === "recurring" ? (
                      <select value={composer.recurrence} onChange={e => setComposer(c => ({ ...c, recurrence: e.target.value }))}
                        className="text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 focus:outline-none" data-testid="composer-recurrence">
                        {RECUR_PRESETS.filter(o => o.value).map(o => <option key={o.value} value={o.value}>{`🔁 ${o.label}`}</option>)}
                      </select>
                    ) : (
                      <div className="text-xs text-muted-foreground/60 border border-dashed border-border rounded-lg px-2 py-1.5" data-testid="composer-no-repeat">No repeat</div>
                    )}
                    <input type="date" value={composer.dueDate} onChange={e => setComposer(c => ({ ...c, dueDate: e.target.value }))}
                      className="text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 focus:outline-none" data-testid="composer-due" />
                  </div>
                  {/* Due time + Category */}
                  <div className="grid grid-cols-2 gap-2">
                    <input type="time" value={composer.dueTime} onChange={e => setComposer(c => ({ ...c, dueTime: e.target.value }))}
                      className="text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 focus:outline-none" data-testid="composer-time" />
                    <select value={composer.category} onChange={e => setComposer(c => ({ ...c, category: e.target.value }))}
                      className="text-xs bg-muted/40 border border-border rounded-lg px-2 py-1.5 capitalize focus:outline-none" data-testid="composer-category">
                      {CATEGORY_OPTS.map(c => <option key={c} value={c}>{c || 'No category'}</option>)}
                    </select>
                  </div>
                  {composer.kind === "recurring" && composer.recurrence && (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <Sparkles className="h-3 w-3" />{humanSummary(parseRecurrence([`recur:${composer.recurrence}`]), composer.dueDate || todayStr)}
                    </p>
                  )}
                  <div className="flex items-center gap-2 pt-0.5">
                    <button onClick={submitComposer} disabled={!composer.title.trim()} data-testid="composer-add"
                      className="flex-1 text-sm font-semibold py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-40">Add task</button>
                    <button onClick={() => setComposer(emptyComposer)} className="text-sm text-muted-foreground px-3 py-2">Cancel</button>
                  </div>
                </div>
              )}

              {/* ── Lists — smart sections per tab ── */}
              {tab === "today" ? (
                (overdueTasks.length + todayTasks.length) === 0 && !composer.open ? (
                  <div className="text-center py-10 text-sm text-muted-foreground">Nothing for today 🎉</div>
                ) : (
                  <div className="space-y-4">
                    {overdueTasks.length > 0 && (
                      <div data-testid="section-overdue">
                        <div className="micro-label flex items-center gap-1.5 px-1 mb-1.5 text-red-500"><AlertTriangle className="h-3 w-3" />Overdue ({overdueTasks.length})</div>
                        <div className="space-y-2">{overdueTasks.map((t: any) => <TaskRow key={t.id} t={t} />)}</div>
                      </div>
                    )}
                    {todayTasks.length > 0 && (
                      <div data-testid="section-today">
                        {overdueTasks.length > 0 && <div className="micro-label px-1 mb-1.5 text-muted-foreground">Today</div>}
                        <div className="space-y-2">{todayTasks.map((t: any) => <TaskRow key={t.id} t={t} />)}</div>
                      </div>
                    )}
                  </div>
                )
              ) : tab === "onetime" ? (
                oneTimeSections.length === 0 && !composer.open ? (
                  <div className="text-center py-10 text-sm text-muted-foreground">No one-time tasks — tap + to add one</div>
                ) : (
                  <div className="space-y-4">
                    {oneTimeSections.map((s) => (
                      <div key={s.key} data-testid={`section-${s.key}`}>
                        <div className={`micro-label px-1 mb-1.5 ${s.key === "onetime-overdue" ? "text-red-500" : "text-muted-foreground"}`}>{s.label} ({s.items.length})</div>
                        <div className="space-y-2">{s.items.map((t: any) => <TaskRow key={t.id} t={t} />)}</div>
                      </div>
                    ))}
                  </div>
                )
              ) : tab === "recurring" ? (
                recurringTasks.length === 0 && !composer.open ? (
                  <div className="text-center py-10 text-sm text-muted-foreground">No recurring tasks — tap + to add one</div>
                ) : (
                  <div className="space-y-2">{recurringTasks.map((t: any) => <TaskRow key={t.id} t={t} />)}</div>
                )
              ) : (
                upcomingSections.length === 0 && !composer.open ? (
                  <div className="text-center py-10 text-sm text-muted-foreground">Nothing upcoming</div>
                ) : (
                  <div className="space-y-4">
                    {upcomingSections.map((s) => (
                      <div key={s.key} data-testid={`section-${s.key}`}>
                        <div className="micro-label px-1 mb-1.5 text-muted-foreground">{s.label} ({s.items.length})</div>
                        <div className="space-y-2">{s.items.map((t: any) => <TaskRow key={t.id} t={t} />)}</div>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* Completed — collapsed by default (no dedicated tab) */}
              {done.length > 0 && (
                <div className="mt-3">
                  <button onClick={() => setShowCompleted(s => !s)} data-testid="toggle-completed"
                    className="w-full flex items-center justify-between px-1 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
                    <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" />Completed ({done.length})</span>
                    {showCompleted ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  {showCompleted && <div className="space-y-2 mt-1">{done.map((t: any) => <TaskRow key={t.id} t={t} dimmed />)}</div>}
                </div>
              )}
            </div>
          )}
        </div>
    </BubbleModal>
      {/* U1 fix: confirmation dialog for the task delete — prevents accidental loss
          when the dimmed completed-task X is hover-clicked. */}
      <AlertDialog open={taskToDelete !== null} onOpenChange={(open) => { if (!open) setTaskToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {(taskToDelete?.seriesIds?.length ?? 0) > 1 ? "Delete this repeating task?" : "Delete this task?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(taskToDelete?.seriesIds?.length ?? 0) > 1
                ? `“${taskToDelete!.title}” repeats — there ${taskToDelete!.seriesIds!.length === 2 ? "is" : "are"} ${taskToDelete!.seriesIds!.length} occurrences in this schedule. Deleting the whole series also clears it from your calendar and recurring dates.`
                : taskToDelete ? `“${taskToDelete.title}” will be permanently removed.` : "This task will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* A repeating task gets both scopes, the way a calendar app does —
                never a single button that silently destroys the siblings. */}
            {(taskToDelete?.seriesIds?.length ?? 0) > 1 && (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (taskToDelete) deleteSeriesMutation.mutate({ ids: taskToDelete.seriesIds!, title: taskToDelete.title });
                  setTaskToDelete(null);
                }}
                data-testid="btn-confirm-delete-task-series"
              >{`Delete all ${taskToDelete!.seriesIds!.length}`}</AlertDialogAction>
            )}
            <AlertDialogAction
              className={(taskToDelete?.seriesIds?.length ?? 0) > 1
                ? "bg-muted text-foreground hover:bg-muted/80"
                : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
              onClick={() => {
                if (taskToDelete) deleteMutation.mutate({ id: taskToDelete.id });
                setTaskToDelete(null);
              }}
              data-testid="btn-confirm-delete-task"
            >{(taskToDelete?.seriesIds?.length ?? 0) > 1 ? "Just this one" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function HabitsPopup({ open, onClose, filterIds = [], filterMode = "everyone" }: { open: boolean; onClose: () => void; filterIds?: string[]; filterMode?: string }) {
  const { toast } = useToast();
  const today = new Date().toLocaleDateString('en-CA');
  const [, navigate] = useLocation();
  const [addingHabit, setAddingHabit] = useState(false);
  const [newHabitName, setNewHabitName] = useState('');
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'year'>('today');
  const [timeFilter, setTimeFilter] = useState<'all' | 'morning' | 'afternoon' | 'evening' | 'night'>('all');
  // Force refetch when popup opens — prevents stale cache after AI chat mutations
  useEffect(() => { if (open) { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); } }, [open]);

  // BUG (user report: "Add Habit does nothing"): the habit was created WITHOUT
  // linkedProfiles, so under an active profile filter the new habit was
  // instantly filtered OUT of the list — created but invisible. Attribute it to
  // the single selected profile (else self), same rule as every quick-add.
  const [newHabitFrequency, setNewHabitFrequency] = useState<'daily' | 'weekly'>('daily');
  const [newHabitTimeOfDay, setNewHabitTimeOfDay] = useState<'anytime' | 'morning' | 'afternoon' | 'evening' | 'bedtime'>('anytime');
  const [newHabitProfileId, setNewHabitProfileId] = useState('');
  // Which habit row has its inline schedule editor open (the "habit profile" edit).
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const { data: habitProfiles = [] } = useQuery<any[]>({ queryKey: ['/api/profiles'], enabled: open });
  const habitOwnerId = useMemo(() => {
    if (newHabitProfileId) return newHabitProfileId;
    if (filterMode === 'selected' && filterIds.length === 1) return filterIds[0];
    return (habitProfiles.find((p: any) => p.type === 'self')?.id) || '';
  }, [newHabitProfileId, filterMode, filterIds, habitProfiles]);
  const createHabitMutation = useMutation({
    mutationFn: (vars: { name: string; frequency: string; profileId?: string; timeOfDay?: string }) =>
      apiRequest('POST', '/api/habits', {
        name: vars.name,
        frequency: vars.frequency,
        ...(vars.timeOfDay ? { timeOfDay: vars.timeOfDay } : {}),
        ...(vars.profileId ? { linkedProfiles: [vars.profileId] } : {}),
      }),
    onSuccess: (_d, vars) => {
      setNewHabitName(''); setAddingHabit(false);
      // Cache bus: habits domain covers /api/habits + dashboard-enhanced +
      // stats (+ activity/insights) in one consolidated shot.
      invalidateDomain('habits');
      toast({ title: 'Habit created', description: vars.name });
    },
    onError: (err: any) => toast({ title: 'Failed to create habit', description: formatApiError(err), variant: 'destructive' }),
  });
  const submitNewHabit = () => {
    if (!newHabitName.trim() || createHabitMutation.isPending) return;
    createHabitMutation.mutate({
      name: newHabitName.trim(),
      frequency: newHabitFrequency,
      profileId: habitOwnerId || undefined,
      ...(newHabitTimeOfDay !== 'anytime' ? { timeOfDay: newHabitTimeOfDay } : {}),
    });
    setNewHabitTimeOfDay('anytime');
  };

  const habitsProfileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // PERF: isPending (not isLoading) so placeholderData keeps prior habits visible on filter switch.
  const { data: habitsRaw = [], isPending: habitsLoading } = useQuery<any[]>({
    queryKey: ["/api/habits", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/habits${habitsProfileParam}`).then(r => r.json()),
    enabled: open,
  });
  const isLoading = habitsLoading;
  // Hide QA/AUDIT habits unless the header "Show test data" toggle is on —
  // keeps the popup's counts/streaks in step with the executive tab.
  const showTestData = useShowTestData();
  const habits = useMemo(
    () => showTestData ? habitsRaw : habitsRaw.filter((h: any) => !isTestDataRow(h.name)),
    [habitsRaw, showTestData],
  );

  // Optimistically bump stats.habitCompletionRate so the dashboard
  // donut ring jumps to 100% the instant the user marks every habit
  // done, instead of waiting on the server roundtrip.
  const recomputeStatsHabitRate = (habitsList: any[]) => {
    if (!habitsList || habitsList.length === 0) return;
    const total = habitsList.filter((h: any) => !h.archivedAt).length;
    if (total === 0) return;
    const completed = habitsList.filter((h: any) =>
      !h.archivedAt && (h.checkins || []).some((c: any) => c.date === today)
    ).length;
    const pct = Math.round((completed / total) * 100);
    const statsKey = ["/api/stats", filterMode, ...filterIds];
    queryClient.setQueryData<any>(statsKey, (old: any) => {
      if (!old) return old;
      return { ...old, habitCompletionRate: pct, totalHabits: total };
    });
  };

  const checkinMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest("POST", `/api/habits/${id}/checkin`, { date: today }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      // Optimistically add today's check-in to the habit AND bump its streak so
      // the flame/streak chip paints instantly; the server-computed streak
      // reconciles on the onSettled invalidation.
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === id
          ? {
              ...h,
              checkins: [...(h.checkins || []), { date: today, id: 'tmp-' + Date.now() }],
              currentStreak: (h.checkins || []).some((c: any) => c.date === today)
                ? h.currentStreak
                : Number(h.currentStreak || 0) + 1,
            }
          : h)
      );
      // Recompute completion% from the (now-updated) cache.
      const updated = queryClient.getQueryData<any[]>(["/api/habits", filterMode, ...filterIds]);
      if (updated) recomputeStatsHabitRate(updated);
      return { prev, prevStats };
    },
    onError: (_e: any, _v: any, ctx: any) => {
      if (ctx?.prev) for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      toast({ title: "Failed to check in habit", variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
    },
  });

  // Un-check (toggle off) today's completion. The design's check button toggles,
  // so tapping a completed habit must remove today's check-in.
  const deleteCheckinMutation = useMutation({
    mutationFn: async ({ id, checkinId }: { id: string; checkinId: string }) => {
      // Idempotent un-check: 404 = already gone (stale render / double tap);
      // the desired state holds, so don't surface a red error for it.
      try {
        await apiRequest("DELETE", `/api/habits/${id}/checkin/${checkinId}`);
      } catch (e: any) {
        if (!String(e?.message || "").startsWith("404")) throw e;
      }
    },
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      // Mirror of the check-in path: drop today's check-in and walk the streak
      // back optimistically; server confirms via the onSettled invalidation.
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === id
          ? {
              ...h,
              checkins: (h.checkins || []).filter((c: any) => c.date !== today),
              currentStreak: (h.checkins || []).some((c: any) => c.date === today)
                ? Math.max(0, Number(h.currentStreak || 0) - 1)
                : h.currentStreak,
            }
          : h)
      );
      const updated = queryClient.getQueryData<any[]>(["/api/habits", filterMode, ...filterIds]);
      if (updated) recomputeStatsHabitRate(updated);
      return { prev, prevStats };
    },
    onError: (_e: any, _v: any, ctx: any) => {
      if (ctx?.prev) for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      toast({ title: "Failed to update habit", variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("habits"); },
  });

  // Edit a habit's schedule (time-of-day / precise time) from its profile row.
  const updateHabitMutation = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: Record<string, any> }) =>
      apiRequest('PATCH', `/api/habits/${id}`, changes),
    onMutate: async ({ id, changes }) => {
      await queryClient.cancelQueries({ queryKey: ['/api/habits'] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ['/api/habits'] });
      queryClient.setQueriesData<any[]>({ queryKey: ['/api/habits'] }, (old) =>
        (old || []).map((h: any) => h.id === id ? { ...h, ...changes } : h));
      return { prev };
    },
    onError: (_e: any, _v: any, ctx: any) => {
      if (ctx?.prev) for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      toast({ title: 'Failed to update schedule', variant: 'destructive' });
    },
    onSettled: () => { invalidateDomain('habits'); },
  });
  const setHabitSchedule = (h: any, timeOfDay: string, scheduledTime?: string | null) => {
    updateHabitMutation.mutate({
      id: h.id,
      changes: {
        timeOfDay,
        // Clear a precise time when switching to a named slot; keep/replace it
        // for custom. Send null to unset so the server column is cleared.
        scheduledTime: scheduledTime === undefined ? (h.scheduledTime || null) : scheduledTime,
      },
    });
  };

  const active = useMemo(() => habits.filter((h: any) => !h.archivedAt), [habits]);
  const VIVID = ['#6C5CE7','#E84393','#E55353','#F6A623','#2ECC71','#3498DB','#E67E22','#9B59B6','#1ABC9C','#E74C3C'];

  // ── Derived view state for the redesigned Habits screen ──────────────────
  const dateKey = (d: Date) => d.toLocaleDateString('en-CA');
  const periodDays = period === 'today' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365;
  const last7 = useMemo(() => {
    const arr: string[] = []; const t = new Date();
    for (let i = 6; i >= 0; i--) { const d = new Date(t); d.setDate(t.getDate() - i); arr.push(dateKey(d)); }
    return arr;
  }, []);
  const windowDates = useMemo(() => {
    const arr: string[] = []; const t = new Date();
    for (let i = periodDays - 1; i >= 0; i--) { const d = new Date(t); d.setDate(t.getDate() - i); arr.push(dateKey(d)); }
    return arr;
  }, [periodDays]);
  // A habit can require several completions a day, each its own check-in row.
  // "Done" is the DAY's target being met — not "there is at least one row" —
  // and everything below reads it through the one shared module so this popup,
  // the habits page and the server can't disagree (shared/habit-progress.ts).
  const isDone = (h: any, dk: string) => habitDayProgress(h, dk).isComplete;
  const progressOn = (h: any, dk: string) => habitDayProgress(h, dk);
  const togglePending = checkinMutation.isPending || deleteCheckinMutation.isPending;
  /**
   * The main button records or removes ONE occurrence.
   *
   * On a 2× daily habit: tap → 1 of 2 (50%), tap → 2 of 2 (100%), tap → back to
   * 1 of 2. It used to check in once and then delete that check-in, so a
   * twice-daily habit could never reach its own target from this screen.
   */
  const toggleToday = (h: any) => {
    const p = progressOn(h, today);
    if (p.isComplete) {
      const last = p.occurrences[p.occurrences.length - 1]?.checkin;
      if (last?.id) deleteCheckinMutation.mutate({ id: h.id, checkinId: last.id });
      return;
    }
    checkinMutation.mutate({ id: h.id });
  };
  /** Tap occurrence N directly: fill the next one, or undo that exact one. */
  const toggleOccurrence = (h: any, occ: any) => {
    if (occ.done && occ.checkin?.id && !String(occ.checkin.id).startsWith('tmp-')) {
      deleteCheckinMutation.mutate({ id: h.id, checkinId: occ.checkin.id });
    } else if (!occ.done) {
      checkinMutation.mutate({ id: h.id });
    }
  };
  // Time-of-day bucket. Prefer the habit's EXPLICIT schedule (editable from the
  // habit profile); fall back to inferring the slot from the most recent
  // check-in timestamp only when no schedule is set.
  const TOD_TO_BUCKET: Record<string, string | null> = {
    morning: 'morning', afternoon: 'afternoon', evening: 'evening',
    bedtime: 'night', anytime: null,
  };
  const bucketOf = (h: any): string | null => {
    if (h.timeOfDay) return TOD_TO_BUCKET[h.timeOfDay] ?? null;
    const cs = h.checkins || []; if (!cs.length) return null;
    const last = cs[cs.length - 1];
    const hr = new Date(last.timestamp || `${last.date}T12:00:00`).getHours();
    if (hr >= 5 && hr < 12) return 'morning';
    if (hr >= 12 && hr < 17) return 'afternoon';
    if (hr >= 17 && hr < 21) return 'evening';
    return 'night';
  };
  // Human label for a habit's scheduled slot, shown on each row.
  const TOD_LABEL: Record<string, string> = {
    morning: '☀️ Morning', afternoon: '🌤️ Afternoon', evening: '🌆 Evening',
    bedtime: '🌙 Bedtime', anytime: 'Anytime',
  };
  const fmtTime = (t?: string) => {
    if (!t || !/^\d{2}:\d{2}$/.test(t)) return '';
    const [hStr, m] = t.split(':'); let h = parseInt(hStr, 10);
    const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  };
  const schedLabel = (h: any): string | null => {
    if (h.scheduledTime && /^\d{2}:\d{2}$/.test(h.scheduledTime)) return `⏰ ${fmtTime(h.scheduledTime)}`;
    if (h.timeOfDay) return TOD_LABEL[h.timeOfDay] || null;
    return null;
  };
  const getEmoji = (name: string) => {
    const n = (name || '').toLowerCase();
    if (n.includes('meditat') || n.includes('mindful')) return '🧘';
    if (n.includes('journal') || n.includes('write') || n.includes('diary')) return '📝';
    if (n.includes('water') || n.includes('hydrat')) return '💧';
    if (n.includes('run') || n.includes('jog')) return '🏃';
    if (n.includes('exercise') || n.includes('workout') || n.includes('gym') || n.includes('lift')) return '💪';
    if (n.includes('walk') || n.includes('step')) return '👣';
    if (n.includes('read') || n.includes('book')) return '📚';
    if (n.includes('sleep') || n.includes('bed')) return '😴';
    if (n.includes('eat') || n.includes('food') || n.includes('meal') || n.includes('sugar')) return '🥗';
    if (n.includes('vitamin') || n.includes('pill') || n.includes('medication') || n.includes('medicine')) return '💊';
    if (n.includes('teeth') || n.includes('brush') || n.includes('dental')) return '🦷';
    if (n.includes('guitar') || n.includes('music') || n.includes('piano') || n.includes('practic')) return '🎸';
    if (n.includes('wake') || n.includes('morning')) return '☀️';
    if (n.includes('stretch') || n.includes('yoga')) return '🤸';
    return '⭐';
  };
  // Row order is FROZEN for the life of the open popup (2026-07-29 tester
  // report: sorting by live streak re-ordered the list mid-tap, so rapid
  // toggles landed on the wrong habit — same failure mode as the bills PAY
  // race). Each habit gets its position the first time it appears (streak
  // order at that moment) and keeps it until the popup closes.
  const habitOrderRef = useRef<Map<string, number>>(new Map());
  useEffect(() => { if (!open) habitOrderRef.current = new Map(); }, [open]);
  const visible = useMemo(() => {
    const list = active.filter((h: any) => timeFilter === 'all' || bucketOf(h) === timeFilter);
    const order = habitOrderRef.current;
    const newcomers = list.filter((h: any) => !order.has(h.id))
      .sort((a: any, b: any) => (b.currentStreak || 0) - (a.currentStreak || 0) || (a.name || '').localeCompare(b.name || ''));
    for (const h of newcomers) order.set(h.id, order.size);
    return [...list].sort((a: any, b: any) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [active, timeFilter, open]);

  // Summary metrics, counted in OCCURRENCES rather than habits.
  //
  // The ring used to divide "habits with any check-in" by "habits × days", so a
  // day needing four doses across two habits read 100% after two taps. It also
  // credited days a habit was never scheduled for. Both are fixed by asking
  // habitsDayRollup per day: unscheduled days contribute nothing to either side.
  const totalActive = active.length;
  const windowRollups = windowDates.map((dk) => habitsDayRollup(active, dk));
  const completedInWindow = windowRollups.reduce((s, r) => s + r.completed, 0);
  const possible = windowRollups.reduce((s, r) => s + r.required, 0);
  const overallPct = possible > 0 ? Math.round((completedInWindow / possible) * 100) : 0;
  const todayRollup = habitsDayRollup(active, today);
  const completedToday = todayRollup.completed;
  const bestStreak = active.reduce((m: number, h: any) => Math.max(m, h.currentStreak || 0), 0);
  const allTimeCheckins = active.reduce((s: number, h: any) => s + (h.checkins || []).length, 0);
  const completedStat = period === 'today' ? completedToday : completedInWindow;

  const STAT_CHIPS = [
    { Icon: CheckCircle2, color: '155 60% 48%', value: period === 'today' ? `${completedToday}/${todayRollup.required}` : completedStat, label: 'Completed' },
    { Icon: Flame, color: '28 90% 55%', value: bestStreak, label: 'Day Streak' },
    { Icon: Target, color: '262 70% 62%', value: totalActive, label: 'Habits' },
    { Icon: ListChecks, color: '205 90% 58%', value: allTimeCheckins, label: 'Check-ins' },
  ];
  const TIME_FILTERS = [
    { key: 'all', label: 'All' }, { key: 'morning', label: '☀️ Morning' },
    { key: 'afternoon', label: 'Afternoon' }, { key: 'evening', label: 'Evening' }, { key: 'night', label: '🌙 Night' },
  ] as const;
  const ringR = 26, ringC = 2 * Math.PI * ringR;

  return (
    // A SIXTH header design lived here: a centre-aligned title flanked by a
    // spacer and two 36px circles. BubbleModal now owns the frame; the add
    // control moves to headerRight, where every other popup puts its action.
    <BubbleModal
      open={open}
      onClose={() => { onClose(); setAddingHabit(false); setNewHabitName(''); }}
      title="Habits" icon={Flame} accent={HABITS_ACCENT} count={active.length}
      testId="popup-habits"
      headerRight={
        <button
          onClick={() => setAddingHabit(v => !v)}
          aria-label="Add habit"
          data-testid="button-add-habit"
          className={`pressable w-8 h-8 flex items-center justify-center rounded-full transition-colors ${addingHabit ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary hover:bg-primary/25'}`}
        >
          <Plus className="h-4 w-4" />
        </button>
      }
    >
        {/* Period tabs */}
        <div>
          <div className="flex gap-1 rounded-xl bg-muted/40 p-1">
            {(['today', 'week', 'month', 'year'] as const).map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold capitalize transition-colors ${period === p ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Inline add habit form — name + frequency + profile, saves on Enter/Add */}
        {addingHabit && (
          <div className="pt-2.5 space-y-2">
            <div className="flex gap-2">
              <input
                autoFocus
                className="flex-1 text-sm bg-muted/40 border border-border rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground/50"
                placeholder="New habit name (e.g. Drink water)..."
                value={newHabitName}
                onChange={e => setNewHabitName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitNewHabit();
                  if (e.key === 'Escape') { setAddingHabit(false); setNewHabitName(''); }
                }}
                data-testid="input-new-habit-name"
              />
              <button
                onClick={submitNewHabit}
                disabled={!newHabitName.trim() || createHabitMutation.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-semibold disabled:opacity-40 shrink-0"
                data-testid="btn-new-habit-add"
              >
                {createHabitMutation.isPending ? '...' : 'Add'}
              </button>
            </div>
            <div className="flex gap-2">
              <Select value={newHabitFrequency} onValueChange={(v) => setNewHabitFrequency(v as 'daily' | 'weekly')}>
                <SelectTrigger className="h-9 text-xs flex-1" data-testid="select-new-habit-frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
              <Select value={habitOwnerId} onValueChange={setNewHabitProfileId}>
                <SelectTrigger className="h-9 text-xs flex-1" data-testid="select-new-habit-profile"><SelectValue placeholder="Profile" /></SelectTrigger>
                <SelectContent>
                  {habitProfiles
                    .filter((p: any) => ['self', 'person', 'pet'].includes(p.type))
                    .sort((a: any, b: any) => (a.type === 'self' ? -1 : b.type === 'self' ? 1 : (a.name || '').localeCompare(b.name || '')))
                    .map((p: any) => <SelectItem key={p.id} value={p.id}>{p.type === 'self' ? 'Me' : p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* When during the day this habit should occur */}
            <div>
              <p className="micro-label text-muted-foreground/70 mb-1 flex items-center gap-1">
                <Clock className="h-3 w-3" /> When?
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(['anytime', 'morning', 'afternoon', 'evening', 'bedtime'] as const).map((slot) => (
                  <button key={slot} type="button" onClick={() => setNewHabitTimeOfDay(slot)}
                    data-testid={`new-habit-tod-${slot}`}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize transition-colors ${newHabitTimeOfDay === slot ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}`}>
                    {slot === 'bedtime' ? 'Bedtime' : slot}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Summary: overall ring + stat chips */}
        <div className="pt-3">
          <div className="bubble flex items-center gap-3 p-3">
            <div className="relative shrink-0" style={{ width: 64, height: 64 }}>
              <svg width="64" height="64" className="-rotate-90">
                <circle cx="32" cy="32" r={ringR} fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
                <circle cx="32" cy="32" r={ringR} fill="none" stroke="hsl(262 70% 60%)" strokeWidth="6" strokeLinecap="round"
                  strokeDasharray={`${(overallPct / 100) * ringC} ${ringC}`}
                  style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(0.34,1.56,0.64,1)' }} />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-sm font-bold tabular-nums leading-none">{overallPct}%</span>
                <span className="micro-label text-muted-foreground mt-0.5">Overall</span>
              </div>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-x-2 gap-y-2.5">
              {STAT_CHIPS.map(({ Icon, color, value, label }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <Icon className="h-4 w-4 shrink-0" style={{ color: `hsl(${color})` }} />
                  <div className="leading-none min-w-0">
                    <div className="text-sm font-bold tabular-nums">{value}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Time-of-day filter chips */}
        <div className="pt-2.5 pb-1">
          <div className="flex flex-wrap gap-1.5">
            {TIME_FILTERS.map((f) => (
              <button key={f.key} onClick={() => setTimeFilter(f.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${timeFilter === f.key ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Habit list — native scroll (ScrollArea is broken on iOS Safari in dialogs) */}
        <div className="pb-2">
          {isLoading ? (
            <div className="space-y-2 py-2">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 rounded-2xl" />)}</div>
          ) : active.length === 0 ? (
            <div className="py-10 text-center px-4">
              <Flame className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">No habits tracked yet</p>
              <Button onClick={() => setAddingHabit(true)}>Add your first habit</Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No habits in this time block yet.</p>
          ) : (
            <div className="space-y-2 pt-1">
              {visible.map((h: any) => {
                const color = (h.color && h.color !== '#4F98A3') ? h.color : VIVID[h.id.charCodeAt(0) % VIVID.length];
                const dayProgress = progressOn(h, today);
                const done = dayProgress.isComplete;
                const multi = dayProgress.required > 1;
                const streak = h.currentStreak || 0;
                const emoji = h.icon || getEmoji(h.name);
                const freqLabel = (h.targetPerDay || 1) > 1 ? `${h.targetPerDay}× daily` : (h.frequency === 'weekly' ? 'Weekly' : 'Daily');
                const sLabel = schedLabel(h);
                const editing = editingScheduleId === h.id;
                return (
                  <div key={h.id} className="bubble">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
                        style={{ background: `${color}22`, border: `1px solid ${color}55` }}>
                        <span>{emoji}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{h.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {freqLabel}{sLabel ? ` · ${sLabel}` : ''}
                          {h.endDate ? ` · through ${h.endDate}` : ''}
                        </p>
                        {/* TODAY'S OCCURRENCES — one tappable dot each.
                            A multi-completion habit shows how far through the
                            day it is; tapping a filled dot undoes THAT
                            completion and leaves the others alone. */}
                        {multi && dayProgress.isScheduled && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <div className="flex gap-1" data-testid={`habit-occurrences-${h.id}`}>
                              {dayProgress.occurrences.map((occ) => (
                                <button
                                  key={occ.index}
                                  type="button"
                                  disabled={togglePending}
                                  onClick={(e) => { e.stopPropagation(); toggleOccurrence(h, occ); }}
                                  aria-label={occ.done ? `Undo completion ${occ.position}` : `Record completion ${occ.position}`}
                                  title={occ.done ? `Completion ${occ.position} — tap to undo` : `Completion ${occ.position} of ${dayProgress.required}`}
                                  data-testid={`habit-occ-${h.id}-${occ.position}`}
                                  className="touch-manipulation active:scale-90 transition-transform"
                                  style={{ minWidth: 22, minHeight: 22, padding: 3 }}
                                >
                                  <span className="block h-3.5 w-3.5 rounded-full border-2 transition-colors"
                                    style={{
                                      background: occ.done ? color : 'transparent',
                                      borderColor: occ.done ? color : 'hsl(var(--muted-foreground) / 0.45)',
                                    }} />
                                </button>
                              ))}
                            </div>
                            <span className="text-[11px] tabular-nums text-muted-foreground" data-testid={`habit-progress-label-${h.id}`}>
                              {dayProgress.label} · {dayProgress.percent}%
                            </span>
                          </div>
                        )}
                        {/* The last 7 days: filled only when the whole day's
                            target was met, half-lit when it was started. */}
                        <div className="mt-1.5 flex gap-1">
                          {last7.map((dk) => {
                            const p = progressOn(h, dk);
                            return (
                              <span key={dk} className="h-2 w-2 rounded-full" title={`${dk} — ${p.isScheduled ? p.label : 'not scheduled'}`}
                                style={{
                                  background: p.isComplete ? 'hsl(155 60% 48%)' : 'hsl(var(--muted))',
                                  // A started-but-unfinished day is neither a
                                  // success nor a blank — show it as partial.
                                  opacity: !p.isComplete && p.isPartial ? 0.95 : 1,
                                  boxShadow: !p.isComplete && p.isPartial ? 'inset 0 0 0 2px hsl(155 60% 48%)' : undefined,
                                }} />
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <button onClick={() => setEditingScheduleId(editing ? null : h.id)}
                          aria-label="Edit schedule" data-testid={`habit-edit-schedule-${h.id}`}
                          className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${editing ? 'bg-primary/20 text-primary' : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted'}`}>
                          <Clock className="h-3.5 w-3.5" />
                        </button>
                        <span className="flex items-center gap-0.5 text-[11px] font-semibold tabular-nums leading-none"
                          style={{ color: streak > 0 ? 'hsl(28 90% 55%)' : 'hsl(var(--muted-foreground))' }}>
                          {streak} {streak > 0 ? '🔥' : ''}
                        </span>
                        <span className="micro-label text-muted-foreground/70 leading-none">day streak</span>
                        <button onClick={() => toggleToday(h)} disabled={togglePending}
                          aria-label={done ? 'Mark not done today' : 'Mark done today'}
                          className="touch-manipulation active:scale-90 transition-transform mt-0.5"
                          style={{ minWidth: 40, minHeight: 40 }}>
                          <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 transition-all"
                            style={{
                              background: done ? 'hsl(262 70% 58%)' : 'transparent',
                              borderColor: done || dayProgress.isPartial ? 'hsl(262 70% 58%)' : 'hsl(var(--muted-foreground) / 0.5)',
                            }}>
                            {done
                              ? <Check className="h-4 w-4 text-white" strokeWidth={3} />
                              /* Partial: say how far in, rather than showing an
                                 empty circle that reads as "not started". */
                              : dayProgress.isPartial
                                ? (
                                  /* "1/2" at the type scale's floor. A 10× habit
                                     would overflow the 28px circle, so past 9 the
                                     count alone carries it — the dots above have
                                     the full picture either way. */
                                  <span className="text-[11px] font-bold tabular-nums leading-none" style={{ color: 'hsl(262 70% 58%)' }}>
                                    {dayProgress.required >= 10 ? dayProgress.completed : `${dayProgress.completed}/${dayProgress.required}`}
                                  </span>
                                )
                                : null}
                          </div>
                        </button>
                      </div>
                    </div>
                    {/* Inline schedule editor — the editable "habit profile" schedule */}
                    {editing && (
                      <div className="border-t border-border/50 px-3 py-2.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="micro-label text-muted-foreground/70">Scheduled for</p>
                          <button type="button" onClick={() => setEditingScheduleId(null)}
                            data-testid={`habit-schedule-done-${h.id}`}
                            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/10 transition-colors">
                            <Check className="h-3 w-3" /> Done
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {(['anytime', 'morning', 'afternoon', 'evening', 'bedtime'] as const).map((slot) => {
                            const activeSlot = (h.timeOfDay || 'anytime') === slot && !h.scheduledTime;
                            return (
                              <button key={slot} type="button"
                                // Apply the slot and collapse the editor — picking a
                                // named slot is a complete edit, so close right away.
                                onClick={() => { setHabitSchedule(h, slot, null); setEditingScheduleId(null); }}
                                disabled={updateHabitMutation.isPending}
                                data-testid={`habit-tod-${slot}-${h.id}`}
                                className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize transition-colors ${activeSlot ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}`}>
                                {slot === 'bedtime' ? 'Bedtime' : slot}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-2 pt-0.5">
                          <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Custom time</span>
                          <input type="time" value={h.scheduledTime || ''}
                            data-testid={`habit-custom-time-${h.id}`}
                            onChange={(e) => {
                              const v = e.target.value;
                              // Derive the slot from the chosen hour so the row still
                              // groups sensibly, and store the precise time.
                              const hr = v ? parseInt(v.split(':')[0], 10) : NaN;
                              const slot = isNaN(hr) ? 'anytime' : hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : hr < 21 ? 'evening' : 'bedtime';
                              setHabitSchedule(h, slot, v || null);
                            }}
                            className="text-xs bg-muted/40 border border-border rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary" />
                          {h.scheduledTime && (
                            <button onClick={() => setHabitSchedule(h, h.timeOfDay || 'anytime', null)}
                              className="text-[11px] text-muted-foreground hover:text-foreground underline">Clear</button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Motivational footer */}
        <div className="pt-1">
          <div className="bubble flex items-center gap-3 px-4 py-3" style={{ ["--accent-hsl" as any]: "262 70% 62%" }}>
            <Sparkles className="h-5 w-5 shrink-0" style={{ color: 'hsl(262 70% 62%)' }} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Small habits, big changes.</p>
              <p className="text-xs text-muted-foreground">
                {active.length === 0 ? 'Add your first habit to begin.'
                  : overallPct >= 80 ? "You're doing great!"
                  : overallPct > 0 ? 'Keep it up!'
                  : 'Tap a habit to start your streak.'}
              </p>
            </div>
          </div>
        </div>
    </BubbleModal>
  );
}
