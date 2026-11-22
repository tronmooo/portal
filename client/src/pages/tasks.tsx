import { formatApiError } from "@/lib/formatError";
import { Skeleton } from "@/components/ui/skeleton";
import { stopProp } from "@/lib/event-utils";
import { EmptyState } from "@/components/ui/empty-state";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { MetricCard } from "@/components/ui/metric-card";
import { accentScope, accentTriple } from "@/components/tracker-detail/theme";

// Tasks live on the Executive tab; the page takes its accent so opening the
// full list doesn't feel like leaving the app.
const TASKS_ACCENT = "262 70% 62%";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday, addDays as tzAddDays, formatClockTime } from "@shared/timezone";
import { taskSummaryTiles, openTaskBucket, countOpenDueWithin, type OpenTaskBucket } from "@shared/task-counts";
import { taskGroupOf, taskGroupItemKind, type TaskGroupKind } from "@shared/task-groups";
import { isAssetTabProfile, isLiabilityTabProfile } from "@shared/asset-value";
import { hashNavigate } from "@/lib/hashNavigate";
import { ToastAction } from "@/components/ui/toast";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isRecurring, humanSummary, parseRecurrence, userTags } from "@shared/recurrence";
import { isMigrationTag, isRetiredMigratedReminderTask } from "@shared/legacy-reminder-tasks";
import { invalidateDomain } from "@/lib/cache-bus";
import { withFullLimit } from "@/lib/list-limit";
import { useProfileScope, useActiveCreateProfileId } from "@/hooks/useProfileScope";
import { formatStoredDate, farFutureWarning } from "@/lib/dates";
import { passesProfileFilter } from "@shared/profile-filter";
import { useProfileFilterCtx } from "@/hooks/useProfileFilterCtx";
import { useRecordHighlight } from "@/hooks/useRecordHighlight";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { ActiveFilterNotice, FilteredEmptyState } from "@/components/ActiveFilterNotice";
import { setFilterEveryone, scopeLabel } from "@/lib/profileFilter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { showUndoToast } from "@/lib/undo-delete";
import { ListTodo, Calendar, CalendarDays, AlertCircle, AlertTriangle, Flame, Plus, Trash2, CheckCircle2, Repeat, Inbox, Flag, Hourglass, User, Car, Layers, Home, Landmark, CreditCard, Package, ChevronDown, MoreHorizontal, Pencil, ExternalLink, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import type { Task, Profile } from "@shared/schema";
import { useState, useEffect, useRef, useMemo } from "react";
import { changedFieldsOnly } from "@shared/field-patch";
import { useToast } from "@/hooks/use-toast";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "bg-red-500/10 text-red-600 dark:text-red-400",
};

const PRIORITY_ICONS: Record<string, LucideIcon> = { high: AlertCircle, medium: Flag, low: ChevronDown };

const TASK_NOUN = { one: "task", many: "tasks" };

// The open list is grouped by when a task is due, in the order it needs
// attention. The same four buckets (shared/task-counts) cut the summary tiles,
// so the number on a tile is the number of rows under the heading it opens.
// Each bucket has the two-stop colour identity a tracker card has ("H S%"
// pairs, components/tracker-detail/theme): the section heading, its summary
// tile and every card under it share it, so a late task is red the way a
// Nutrition tracker is orange.
type TaskTone = { hs: string; hs2: string; icon: LucideIcon };
const TASK_TONES: Record<OpenTaskBucket | "done", TaskTone> = {
  overdue:  { hs: "0 72%",   hs2: "24 88%",  icon: AlertTriangle },
  dueToday: { hs: "43 85%",  hs2: "24 90%",  icon: Flame },
  upcoming: { hs: "200 80%", hs2: "228 78%", icon: CalendarDays },
  undated:  { hs: "262 70%", hs2: "292 65%", icon: Inbox },
  done:     { hs: "155 60%", hs2: "178 62%", icon: CheckCircle2 },
};
// The page is organised by what a task is ABOUT (shared/task-groups): the
// user, something they own, something they owe. Each section is a tracker-
// style hero panel with its own two-stop colour.
const GROUP_SECTIONS: { kind: TaskGroupKind; title: string; subtitle: string; tab: string; icon: LucideIcon; hs: string; hs2: string }[] = [
  { kind: "mine", title: "My Tasks", subtitle: "Personal and general tasks", tab: "Mine", icon: User, hs: "173 70%", hs2: "199 80%" },
  { kind: "asset", title: "Asset Tasks", subtitle: "Tasks tied to your assets", tab: "Assets", icon: Car, hs: "213 85%", hs2: "240 75%" },
  { kind: "liability", title: "Liability Tasks", subtitle: "Tasks tied to your liabilities", tab: "Liabilities", icon: Layers, hs: "265 72%", hs2: "292 65%" },
];
const ITEM_ICONS: Record<string, LucideIcon> = {
  vehicle: Car, property: Home, account: Landmark, investment: Landmark, loan: Landmark,
  liability: Landmark, subscription: CreditCard, asset: Package,
};
/** What a row needs to know about the asset or liability its task is tied to. */
type LinkedItem = { id: string; name: string; kind: TaskGroupKind };
const BUCKET_ORDER: Record<OpenTaskBucket, number> = { overdue: 0, dueToday: 1, upcoming: 2, undated: 3 };
const PRIORITY_CYCLE = ["low", "medium", "high"];
/** The priority a tap on the row's badge moves to: low → medium → high → low. */

export function nextPriority(current: string | null | undefined): string {
  const i = PRIORITY_CYCLE.indexOf(String(current || "medium"));
  return PRIORITY_CYCLE[(i + 1) % PRIORITY_CYCLE.length];
}

// Cache bus: the "tasks" domain ripples to every linked surface (task lists,
// dashboard KPIs, stats, activity feed, calendar timeline, insights) in one
// call instead of a hand-maintained key list.
const invalidateTaskQueries = () => invalidateDomain("tasks");

// ── Create / Edit Dialog ─────────────────────────────────────────────────────

function TaskDialog({
  open,
  onClose,
  task,
}: {
  open: boolean;
  onClose: () => void;
  task?: Task | null;
}) {
  const { toast } = useToast();
  const isEdit = !!task;

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<string>(task?.priority ?? "medium");
  const [dueDate, setDueDate] = useState(task?.dueDate?.slice(0, 10) ?? "");
  const [tagsInput, setTagsInput] = useState((task?.tags ?? []).join(", "));
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Co-ownership widens a person's scope to the assets they co-own (shared/profile-filter).

  // Default the new task's profile to whichever profile is ACTIVE in the global
  // scope (the one the user is working in) — not unconditionally "me". Creating
  // a task while "Jane" is selected must link it to Jane so it stays visible.
  const activeCreateProfileId = useActiveCreateProfileId(profiles);
  useEffect(() => {
    if (activeCreateProfileId && !selectedProfileId) setSelectedProfileId(activeCreateProfileId);
  }, [activeCreateProfileId]);

  const mutation = useMutation<any, Error, void, { prev: [readonly unknown[], unknown][]; tempId: string }>({
    mutationFn: async () => {
      const body: Record<string, any> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        dueDate: dueDate || undefined,
        tags: tagsInput.split(",").map(t => t.trim()).filter(Boolean),
        ...(selectedProfileId && !isEdit ? { linkedProfiles: [selectedProfileId] } : {}),
      };
      if (isEdit) {
        // Only what the user changed. The form was seeded from the task when
        // it opened and used to hand the whole thing back, so the priority or
        // due date the phone changed while this dialog sat open was written
        // back to its stale value. A cleared description or due date goes as
        // "" (the schema's clear) — as `undefined` it fell out of the JSON
        // and the clear silently did nothing.
        const seeded = {
          title: task!.title,
          description: task!.description ?? "",
          priority: task!.priority ?? "medium",
          dueDate: task!.dueDate?.slice(0, 10) ?? "",
          tags: task!.tags ?? [],
        };
        const next = { ...body, description: description.trim(), dueDate: dueDate || "" };
        const patch = changedFieldsOnly(seeded, next);
        if (Object.keys(patch).length === 0) return task;
        const res = await apiRequest("PATCH", `/api/tasks/${task!.id}`, patch);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/tasks", body);
      return res.json();
    },
    onMutate: async () => {
      // Optimistic create/edit so the task list updates the moment the user
      // hits Save and the dialog can close without waiting for the network.
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/tasks"] });
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tags = tagsInput.split(",").map(t => t.trim()).filter(Boolean);
      if (isEdit && task?.id) {
        const patch: any = {
          title: title.trim(),
          description: description.trim() || null,
          priority,
          dueDate: dueDate || null,
          tags,
        };
        queryClient.setQueriesData({ queryKey: ["/api/tasks"] }, (old: any) =>
          Array.isArray(old) ? old.map((t: any) => t?.id === task.id ? { ...t, ...patch } : t) : old
        );
      } else {
        const tempTask: any = {
          id: tempId,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          dueDate: dueDate || null,
          status: "todo",
          completed: false,
          tags,
          linkedProfiles: selectedProfileId ? [selectedProfileId] : [],
          createdAt: new Date().toISOString(),
          _optimistic: true,
        };
        queryClient.setQueriesData({ queryKey: ["/api/tasks"] }, (old: any) =>
          Array.isArray(old) ? [tempTask, ...old] : old
        );
      }
      return { prev, tempId };
    },
    onSuccess: (data, _v, ctx) => {
      // Swap the optimistic temp row for the real server row (real id) so
      // toggle/delete on the fresh task works before the refetch settles
      // (temp ids are guarded with a "Still saving…" toast).
      if (!isEdit && data?.id && ctx?.tempId) {
        queryClient.setQueriesData({ queryKey: ["/api/tasks"] }, (old: any) =>
          Array.isArray(old) ? old.map((t: any) => t?.id === ctx.tempId ? { ...t, ...data, _optimistic: undefined } : t) : old
        );
      }
      invalidateTaskQueries();
      // `warning` is set when the server stripped unsafe markup from the title
      // or description — surface it instead of silently changing their text.
      toast({
        title: isEdit ? `"${title.trim()}" updated` : `"${title.trim()}" created`,
        description: (data as any)?.warning || (dueDate ? `Due ${formatStoredDate(dueDate)}` : undefined),
      });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: isEdit ? "Update failed" : "Create failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast({ title: "Title required", description: "Enter a task title", variant: "destructive" });
      return;
    }
    // Close dialog immediately for snappy UX — optimistic insert/patch is in onMutate.
    mutation.mutate();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[85dvh] overflow-y-auto" data-testid={isEdit ? "dialog-edit-task" : "dialog-create-task"}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Task" : "New Task"}</DialogTitle>
          <DialogDescription>{isEdit ? "Update task details." : "Create a new task."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label>Title *</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Task title"
              autoFocus
              data-testid="input-task-title"
            />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={2}
              data-testid="input-task-description"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger data-testid="select-task-priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Due Date</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                data-testid="input-task-due-date"
              />
              {/* A due date a century out is a mistyped year, not a plan
                  (QA 2026-07-29 EDGE-004). Warn, don't block — someone may
                  genuinely be tracking a 30-year bond. */}
              {farFutureWarning(dueDate) && (
                <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="warn-task-due-date">
                  {farFutureWarning(dueDate)}
                </p>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Tags</Label>
            <Input
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="work, personal (comma-separated)"
              data-testid="input-task-tags"
            />
          </div>
          {!isEdit && (
            <div className="space-y-1">
              {/* What the task is about. An asset or a liability can be
                  chosen here, and the page lists the task under it. */}
              <Label>Related to</Label>
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger data-testid="select-task-profile"><SelectValue placeholder="Me" /></SelectTrigger>
                <SelectContent>
                  {([
                    ["People", profiles.filter(p => ["self", "person", "pet"].includes(p.type))],
                    ["Assets", profiles.filter(p => isAssetTabProfile(p))],
                    ["Liabilities", profiles.filter(p => isLiabilityTabProfile(p))],
                  ] as const).filter(([, list]) => list.length > 0).map(([label, list]) => (
                    <SelectGroup key={label}>
                      <SelectLabel>{label}</SelectLabel>
                      {list.map(p => (
                        <SelectItem key={p.id} value={p.id} data-testid={`option-task-profile-${p.id}`}>
                          {p.type === "self" ? "Me" : p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="button-submit-task">
              {mutation.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The confirmation for a completed task. Checking off a bill's reminder closes
 * the reminder, not the bill: the payment is a separate record (Auto Pay rule
 * A1 — no screen records one on its own), so the toast offers the way to it.
 */
function showCompletedToast(toast: ReturnType<typeof useToast>["toast"], title: string, linked?: LinkedItem | null) {
  if (linked?.kind !== "liability") { toast({ title }); return; }
  toast({
    title,
    description: `If you paid ${linked.name}, record the payment so its history stays right.`,
    action: (
      <ToastAction altText={`Open ${linked.name}`} onClick={() => hashNavigate(`/profiles/${linked.id}`)} data-testid="toast-open-linked">
        Open {linked.name}
      </ToastAction>
    ),
  });
}

// ── Task Item ────────────────────────────────────────────────────────────────

function TaskItem({
  task,
  onEdit,
  today,
  linked,
  dense,
}: {
  task: Task;
  onEdit: (t: Task) => void;
  /** The user's calendar day: an open task due before it shows its date in red. */
  today: string;
  /** The asset or liability this task is tied to, when it is. */
  linked?: LinkedItem | null;
  /** Beside its item (the narrow column of an asset/liability group): on a
   *  phone the priority shows as its icon alone so the title keeps the room. */
  dense?: boolean;
}) {
  const bucket = task.status === "done" ? "done" : openTaskBucket(task, today);
  const isOverdue = bucket === "overdue";
  const tone = TASK_TONES[bucket];
  const PriorityIcon = PRIORITY_ICONS[task.priority] || Flag;
  const completedToast = (title: string) => showCompletedToast(toast, title, linked);
  const { toast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dateEditing, setDateEditing] = useState(false);

  // Optimistic rows carry a synthetic "tmp-"/"temp-" id until the create
  // settles; PATCH/DELETE against one 404s ("red error but it worked" class).
  const isTempTask = /^te?mp-/.test(String(task.id));

  // One optimistic PATCH for the row's inline fields (due date, priority).
  const patchMutation = useMutation<any, Error, { dueDate?: string | null; priority?: string }, { prevQueries: [readonly unknown[], Task[] | undefined][] }>({
    mutationFn: async (patch) => {
      if (isTempTask) throw new Error("STILL_SAVING");
      const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, patch);
      return res.json();
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
        old?.map(t => t.id === task.id ? { ...t, ...patch } as Task : t)
      );
      return { prevQueries };
    },
    onSuccess: () => { invalidateTaskQueries(); },
    onError: (err: Error, _vars, context) => {
      if (context?.prevQueries) {
        for (const [key, data] of context.prevQueries) queryClient.setQueryData(key, data);
      }
      if (err.message === "STILL_SAVING") { stillSaving(); return; }
      toast({ title: `Failed to update "${task.title}"`, description: formatApiError(err), variant: "destructive" });
    },
  });
  const stillSaving = () => toast({ title: "Still saving…", description: "This task is a moment from being created — try again in a second." });

  const toggleMutation = useMutation<any,Error,void>({
    mutationFn: async () => {
      if (isTempTask) throw new Error("STILL_SAVING");
      const newStatus = task.status === "done" ? "todo" : "done";
      const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: newStatus });
      return res.json();
    },
    onMutate: async () => {
      // Optimistic update: immediately toggle the task status in cache
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
      const newStatus = task.status === "done" ? "todo" : "done";
      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
        old?.map(t => t.id === task.id ? { ...t, status: newStatus } : t)
      );
      // Rule 16: the row flips optimistically; the confirmation waits for
      // the commit (onSuccess). The label is decided HERE, from the pre-tap
      // status, and carried in the context — by the time the server answers
      // the optimistic cache has already changed `task.status`.
      const doneTitle = task.status === "done" ? `"${task.title}" reopened` : `"${task.title}" completed`;
      return { prevQueries, doneTitle, completed: task.status !== "done" };
    },
    onSuccess: (_d, _v, ctx: any) => {
      const title = String(ctx?.doneTitle || `"${task.title}" updated`);
      if (ctx?.completed) completedToast(title); else toast({ title });
      invalidateTaskQueries();
    },
    onError: (err: Error, _vars, context: any) => {
      // Rollback optimistic update on error
      if (context?.prevQueries) {
        for (const [key, data] of context.prevQueries) {
          queryClient.setQueryData(key, data);
        }
      }
      if (err.message === "STILL_SAVING") { stillSaving(); return; }
      toast({ title: `Failed to update "${task.title}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const restoreMutation = useMutation<any,Error,void>({
    mutationFn: () => apiRequest("PATCH", `/api/tasks/${task.id}/restore`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
        (old || []).map(t => t.id === task.id ? { ...t, status: "todo" as const } : t)
      );
      // Rule 16: confirmation waits for the commit (onSuccess below).
      return { prevQueries };
    },
    onSuccess: () => { toast({ title: `"${task.title}" restored` }); },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prevQueries) { for (const [key, data] of ctx.prevQueries) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to restore "${task.title}"`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => { invalidateTaskQueries(); },
  });

  const deleteMutation = useMutation<any,Error,void>({
    mutationFn: async () => {
      if (isTempTask) throw new Error("STILL_SAVING");
      return apiRequest("DELETE", `/api/tasks/${task.id}`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
        (old || []).filter(t => t.id !== task.id)
      );
      // Instant confirmation (see toggleMutation note). Undo rides the
      // shared helper (8s window) and hits the server's soft-delete restore
      // endpoint, so the row and its history come back intact.
      showUndoToast({
        title: `"${task.title}" deleted`,
        onUndo: () => restoreMutation.mutate(),
      });
      return { prevQueries };
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prevQueries) { for (const [key, data] of ctx.prevQueries) queryClient.setQueryData(key, data); }
      if (err.message === "STILL_SAVING") { stillSaving(); return; }
      toast({ title: `Failed to delete "${task.title}"`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => { invalidateTaskQueries(); },
  });

  return (
    <>
      {/* A row inside its section's panel (the tracker popup's .bubble-row),
          not a card of its own. The row keeps its due bucket's colour for
          the checkbox ring and the date. */}
      <div
        data-testid={`card-task-${task.id}`}
        data-record-id={task.id}
        data-tone={bucket}
        data-due={task.status !== "done" ? String(task.dueDate || "").slice(0, 10) : ""}
        className={`td-scope bubble-row relative ${task.status === "done" ? "opacity-60" : ""}`}
        style={{ ...accentScope(tone.hs, tone.hs2), borderRadius: "0.65rem", boxShadow: "inset 0 0 0 1px hsl(var(--border) / 0.55)" }}
      >
        <div className={`${dense ? "px-2" : "px-3"} py-1.5 flex items-center gap-2.5`}>
          <Checkbox
            checked={task.status === "done"}
            onCheckedChange={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            className={`h-5 w-5 rounded-[5px] border-2 border-[hsl(var(--td-hs)_var(--td-l))] data-[state=checked]:bg-[hsl(var(--td-hs)_var(--td-l))] data-[state=checked]:text-background [&_svg]:h-3.5 [&_svg]:w-3.5 ${toggleMutation.isPending ? "opacity-50 animate-pulse" : ""}`}
            data-testid={`checkbox-task-${task.id}`}
          />
          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={() => onEdit(task)}
            // a11y: keyboard-operable stand-in for a click target that wraps
            // block content (can't be a <button> — it contains the row's own
            // date control, and nested buttons are invalid HTML).
            role="button"
            tabIndex={0}
            aria-label={`Edit task: ${task.title}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onEdit(task);
              }
            }}
            data-testid={`task-edit-trigger-${task.id}`}
          >
            {/* One line, cut with an ellipsis: a row is a line in a list, and
                the whole title is one tap away in the editor (and in the
                tooltip). Renaming is in the editor too. */}
            <p
              className={`text-sm font-medium leading-tight truncate ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}
              title={task.title}
              data-testid={`text-task-title-${task.id}`}
            >
              {task.title}
            </p>
            {task.description && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{task.description}</p>
            )}
            <div className="flex items-center gap-2 mt-1 flex-nowrap overflow-hidden min-w-0 [&>*]:shrink-0">
              {/* Inline edits on the row itself (QA 2026-09-18 F-30): the
                  title already edits in place; priority cycles on a tap and
                  the date opens a picker. Both go through the same PATCH the
                  dialog uses, optimistic, with the row still clickable to
                  open the full editor for notes and tags. */}
              {dateEditing ? (
                <input
                  type="date"
                  autoFocus
                  defaultValue={task.dueDate?.slice(0, 10) ?? ""}
                  className="text-xs bg-transparent border border-border rounded px-1 py-0.5"
                  onClick={e => e.stopPropagation()}
                  onChange={e => {
                    const next = e.target.value;
                    if (next === (task.dueDate?.slice(0, 10) ?? "")) return;
                    setDateEditing(false);
                    patchMutation.mutate({ dueDate: next || null });
                  }}
                  onBlur={() => setDateEditing(false)}
                  onKeyDown={e => { if (e.key === "Escape") setDateEditing(false); }}
                  aria-label="Due date"
                  data-testid={`input-task-due-inline-${task.id}`}
                />
              ) : (task.dueDate || task.status !== "done") && (
                <button
                  type="button"
                  className={`text-xs flex items-center gap-1 ${task.dueDate && task.status !== "done" ? "font-medium" : "text-muted-foreground hover:text-foreground"}`}
                  style={task.dueDate && task.status !== "done" ? { color: `hsl(var(--td-hs) var(--td-l))` } : undefined}
                  onClick={stopProp(() => setDateEditing(true))}
                  data-overdue={isOverdue ? "true" : undefined}
                  aria-label={task.dueDate ? "Change due date" : "Add due date"}
                  data-testid={`btn-task-due-${task.id}`}
                >
                  <Calendar className="h-3 w-3" />
                  {/* One formatter, shared with every other due-date surface:
                      never shifts a day, always shows a non-current year. */}
                  {task.dueDate
                    ? (String(task.dueDate).slice(0, 10) === today ? "Today" : (formatStoredDate(task.dueDate) || task.dueDate))
                    : "Add date"}
                  {/* A timed task shows its time — "remind me Friday at
                      10am" stored 10:00 and the row used to drop it. */}
                  {task.dueDate && formatClockTime(task.dueTime) ? (
                    <span data-testid={`text-task-due-time-${task.id}`}>· {formatClockTime(task.dueTime)}</span>
                  ) : null}
                </button>
              )}
              {/* The recurrence grammar (recur:weekly, rdone:1, ranchor:31 …) lives
                  in tags but is not a label; it reads as one summary pill. */}
              {isRecurring(task.tags || []) && (
                <Badge variant="outline" className="text-xs py-0.5" data-testid={`badge-task-recurrence-${task.id}`}>
                  <Repeat className="h-3 w-3 mr-1" />
                  {humanSummary(parseRecurrence(task.tags || []), task.dueDate || undefined)}
                </Badge>
              )}
              {/* The meta line is one line; tags past its end are clipped here
                  and listed in full in the editor. A migration's bookkeeping
                  tag (migrated:reminder) is not a label (F-29). */}
              {userTags(task.tags).filter(tag => !isMigrationTag(tag)).map(tag => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="text-xs whitespace-nowrap leading-tight py-0.5"
                  data-testid={`badge-task-tag-${task.id}-${tag}`}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-0.5 -mr-1.5">
              <button
                type="button"
                onClick={stopProp(() => patchMutation.mutate({ priority: nextPriority(task.priority) }))}
                disabled={patchMutation.isPending}
                aria-label={`Priority ${task.priority} — change`}
                title="Change priority"
                data-testid={`btn-task-priority-${task.id}`}
              >
                <Badge variant="secondary" className={`text-xs capitalize gap-1 ${dense ? "px-1.5 min-[480px]:px-2.5" : ""} ${PRIORITY_COLORS[task.priority]}`}>
                  <PriorityIcon className="h-3 w-3" />
                  <span className={dense ? "hidden min-[480px]:inline" : ""}>{task.priority}</span>
                </Badge>
              </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground"
                  onClick={e => e.stopPropagation()}
                  aria-label={`More actions for ${task.title}`}
                  data-testid={`button-task-menu-${task.id}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                <DropdownMenuItem onSelect={() => onEdit(task)} data-testid={`menu-edit-task-${task.id}`}>
                  <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                </DropdownMenuItem>
                {linked && (
                  <DropdownMenuItem onSelect={() => hashNavigate(`/profiles/${linked.id}`)} data-testid={`menu-open-linked-${task.id}`}>
                    <ExternalLink className="h-3.5 w-3.5 mr-2" /> Open {linked.name}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={deleteMutation.isPending}
                  onSelect={() => setDeleteOpen(true)}
                  data-testid={`button-delete-task-${task.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent data-testid={`alert-delete-task-${task.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{task.title}"?</AlertDialogTitle>
            <AlertDialogDescription>This task will be deleted. You can undo this action briefly after deletion.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-task"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Swipeable Item Wrapper ──────────────────────────────────────────────────

function SwipeableItem({ children, onSwipeLeft, onSwipeRight, leftLabel = '✓ Done', rightLabel = 'Snooze', leftColor = '#10b981', rightColor = '#f59e0b' }: {
  children: React.ReactNode;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  leftLabel?: string;
  rightLabel?: string;
  leftColor?: string;
  rightColor?: string;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const startX = useRef<number | null>(null);
  const threshold = 72;

  return (
    <div className="relative overflow-hidden rounded-[0.65rem]">
      {/* Background actions */}
      <div className="absolute inset-0 flex items-center">
        <div className="flex-1 h-full flex items-center px-4" style={{ background: leftColor + '30' }}>
          <span className="text-xs font-bold" style={{ color: leftColor }}>{leftLabel}</span>
        </div>
        <div className="flex-1 h-full flex items-center justify-end px-4" style={{ background: rightColor + '30' }}>
          <span className="text-xs font-bold" style={{ color: rightColor }}>{rightLabel}</span>
        </div>
      </div>
      {/* Swipeable content */}
      <div
        style={{ transform: `translateX(${offsetX}px)`, transition: offsetX === 0 ? 'transform 0.2s ease' : 'none', background: 'hsl(var(--card))', borderRadius: '0.65rem', position: 'relative' }}
        onTouchStart={e => { startX.current = e.touches[0].clientX; }}
        onTouchMove={e => {
          if (startX.current === null) return;
          const dx = e.touches[0].clientX - startX.current;
          setOffsetX(Math.max(-threshold * 1.5, Math.min(threshold * 1.5, dx)));
        }}
        onTouchEnd={() => {
          if (offsetX < -threshold) onSwipeLeft?.();
          else if (offsetX > threshold) onSwipeRight?.();
          setOffsetX(0);
          startX.current = null;
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── Tasks Page ───────────────────────────────────────────────────────────────

export default function TasksPage() {
  useEffect(() => { document.title = "Tasks — Portol"; }, []);
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  // Rules 23/24: `?highlight=task:<id>` (a search result, a chat receipt, a
  // calendar tap) scrolls to and flashes that task's card.
  useRecordHighlight("task");
  // QA Bug 7: when the command palette sends us here with ?new=1, auto-open
  // the New Task dialog so the "New task" command actually creates instead of
  // just navigating. The query lives in the hash (#/tasks?new=1).
  useEffect(() => {
    const hash = window.location.hash || "";
    const q = hash.includes("?") ? hash.split("?")[1] : "";
    if (q && new URLSearchParams(q).get("new") === "1") {
      setCreateOpen(true);
      // Strip the param so a refresh doesn't reopen the dialog.
      const cleaned = hash.split("?")[0];
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
    }
  }, []);
  const [editTask, setEditTask] = useState<Task | null>(null);
  // PROFILE-CONTEXT FIX: Tasks now honors the global active-profile scope like
  // every other page. The old code called setFilterEveryone() on mount, which
  // WIPED the user's selection for the entire app every time they opened Tasks —
  // the single most visible "the app forgot which profile I picked" bug. The
  // scope is read reactively from the one source of truth (useProfileScope), so
  // it updates instantly when the user changes the filter here or anywhere else.
  const { mode: filterMode, selectedIds: filterIds, selectedNames: filterNames } = useProfileScope();
  const [tabFilter, setTabFilter] = useState<"all" | TaskGroupKind>("all");
  // Section state is for this visit only: a collapsed section or an opened
  // "completed" list is never remembered (Rule 4).
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskGroupKind, boolean>>>({});
  const [showDone, setShowDone] = useState<Partial<Record<TaskGroupKind, boolean>>>({});

  // The page always reads the WHOLE task list and applies the scope below,
  // with the same shared rule the server uses (passesProfileFilter). Reading
  // a server-scoped list left the page unable to tell "you have no tasks"
  // from "your tasks belong to someone the filter excludes", so a scope left
  // over from an earlier screen read as "Nothing on your list" (Rule 4: a
  // filter must never look like deletion). Knowing the total lets the page
  // say how many rows the scope hides and offer to clear it.
  const { data: tasks, isLoading, error, refetch } = useQuery<Task[]>({
    queryKey: ["/api/tasks", "everyone"],
    // Whole set: the route pages at 100 rows by default (server paginate()),
    // which left every task past the newest hundred off this page while the
    // dashboard tile still counted it.
    queryFn: () => apiRequest("GET", withFullLimit("/api/tasks")).then(r => r.json()),
  });

  // Profiles are needed for the unified filter rule below (it must know which
  // profiles are `self` to decide whether orphan tasks pass the filter).
  const { data: allProfiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const scopeCtx = useProfileFilterCtx(filterIds, allProfiles);

  // Apply profile filter client-side (must be before early returns — Rules of Hooks).
  // P2.4 remediation: use the unified passesProfileFilter rule
  // (shared/profile-filter.ts) instead of an inline `linked.some(...)` so
  // orphan tasks (no linkedProfiles) still show when the selection includes a
  // self profile — matching finance/journal/server semantics.
  // `undefined` until the list has arrived — the summary band reads it as
  // "no number yet", never as zero (QA 2026-09-18 F-25).
  const todayStr = getUserToday(BROWSER_TIMEZONE);
  // A migrated reminder whose series has already ended is a closed chapter
  // ("Take medication · until Aug 11", four times over); it is folded out
  // of every list and count here (shared/legacy-reminder-tasks, F-29).
  const liveTasks = useMemo<Task[] | undefined>(
    () => (tasks ? tasks.filter(t => !isRetiredMigratedReminderTask(t, todayStr)) : undefined),
    [tasks, todayStr],
  );
  const scopeActive = filterMode === "selected" && filterIds.length > 0;
  const profileFilteredTasks = useMemo<Task[] | undefined>(() => {
    if (!liveTasks) return undefined;
    if (!scopeActive) return liveTasks;
    return liveTasks.filter(t => passesProfileFilter(t.linkedProfiles, scopeCtx));
  }, [liveTasks, scopeActive, scopeCtx]);
  const visibleTasks = useMemo(() => profileFilteredTasks ?? [], [profileFilteredTasks]);
  // Rule 4: what the scope hides, and the words for it. The label comes from
  // the SAME snapshot the rows were filtered with, so the notice can never
  // say one thing while the list does another.
  const totalTasks = liveTasks?.length ?? 0;
  const hiddenByScope = scopeActive ? totalTasks - visibleTasks.length : 0;
  const scopeLabels = scopeActive ? [scopeLabel(filterNames, filterMode, filterIds.length)] : [];
  const activeTasks = useMemo(() => visibleTasks.filter(t => t.status !== "done"), [visibleTasks]);
  const completedTasks = useMemo(() => visibleTasks.filter(t => t.status === "done"), [visibleTasks]);
  // Render the lists in pages: every card is a swipeable tree with several
  // icons (120 tasks = ~4,600 DOM nodes and a 150ms long task on open). The
  // counts above still read the full lists; only the cards on screen are paged.
  const TASK_PAGE = 60;
  const [visibleActive, setVisibleActive] = useState(TASK_PAGE);
  const [visibleCompleted, setVisibleCompleted] = useState(TASK_PAGE);
  useEffect(() => { setVisibleActive(TASK_PAGE); setVisibleCompleted(TASK_PAGE); }, [tabFilter, filterMode, filterIds.join(",")]);
  // Open tasks in the order they need attention: overdue (oldest first),
  // today, upcoming (soonest first), then undated. They used to be listed
  // A–Z, which put a bill 52 days late below one due next month.
  const sortedActive = useMemo(() => activeTasks.slice().sort((a, b) =>
    BUCKET_ORDER[openTaskBucket(a, todayStr)] - BUCKET_ORDER[openTaskBucket(b, todayStr)]
    || String(a.dueDate || "").slice(0, 10).localeCompare(String(b.dueDate || "").slice(0, 10))
    || String(a.dueTime || "").localeCompare(String(b.dueTime || ""))
    || (a.title || '').localeCompare(b.title || '')), [activeTasks, todayStr]);
  const shownActive = useMemo(() => sortedActive.slice(0, visibleActive), [sortedActive, visibleActive]);
  const sortedCompleted = useMemo(() => completedTasks.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')), [completedTasks]);
  // v2 summary band: overdue / today / upcoming / done.
  // The buckets are the shared rule (shared/task-counts) so this band, the
  // Tasks popup and the Executive tab agree: "Done" here used to be every
  // completed task ever (14) while the Executive tab said "5 completed today".
  // The tiles are cut from the SAME list the rows below render from, and are
  // null (rendered "—") until that list exists — never a real-looking zero
  // above a page of overdue rows (QA 2026-09-18 F-25).
  const taskSummary = useMemo(
    () => taskSummaryTiles(profileFilteredTasks, todayStr, BROWSER_TIMEZONE),
    [profileFilteredTasks, todayStr],
  );

  // What each task is about, from its own links (shared/task-groups).
  const profilesById = useMemo(() => new Map(allProfiles.map(p => [p.id, p])), [allProfiles]);
  const linkedOf = (task: Task): LinkedItem | null => {
    const g = taskGroupOf(task, profilesById);
    const p = g.profileId ? profilesById.get(g.profileId) : null;
    return p ? { id: p.id, name: p.name, kind: g.kind } : null;
  };
  const sections = useMemo(() => GROUP_SECTIONS.map(def => {
    const inKind = (t: Task) => taskGroupOf(t, profilesById).kind === def.kind;
    // `open` is the rows on this page of the list; `openTotal` the whole group.
    const open = shownActive.filter(inKind);
    const items: { profile: Profile; rows: Task[] }[] = [];
    if (def.kind !== "mine") {
      for (const t of open) {
        const id = taskGroupOf(t, profilesById).profileId!;
        const item = items.find(i => i.profile.id === id);
        if (item) item.rows.push(t); else items.push({ profile: profilesById.get(id)!, rows: [t] });
      }
    }
    return { def, open, items, openTotal: sortedActive.filter(inKind).length, done: sortedCompleted.filter(inKind) };
  }), [shownActive, sortedActive, sortedCompleted, profilesById]);
  // Open tasks due today through the next six days.
  const dueThisWeek = profileFilteredTasks ? countOpenDueWithin(profileFilteredTasks, todayStr, tzAddDays(todayStr, 6)) : null;
  const weekEnd = tzAddDays(todayStr, 6);

  // A summary tile opens the rows it counts: every section is shown and
  // expanded, then the first such row is brought into view. Nothing is
  // filtered away.
  const jumpTo = (match: (row: HTMLElement) => boolean, done = false) => {
    setTabFilter("all");
    setCollapsed({});
    if (done) setShowDone({ mine: true, asset: true, liability: true });
    setTimeout(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="page-tasks"] [data-record-id]'));
      rows.find(match)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }, 60);
  };

  // The swipe gestures: the same optimistic PATCH for every row.
  const swipePatch = async (task: Task, patch: Partial<Task>, okTitle: string, failTitle: string, completed = false) => {
    await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
    const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
    queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
      (old || []).map(t => t.id === task.id ? { ...t, ...patch } : t)
    );
    if (completed) showCompletedToast(toast, okTitle, linkedOf(task)); else toast({ title: okTitle });
    try {
      await apiRequest("PATCH", `/api/tasks/${task.id}`, patch);
      invalidateTaskQueries();
    } catch (err: any) {
      for (const [key, data] of prevQueries) queryClient.setQueryData(key, data);
      toast({ title: failTitle, description: formatApiError(err), variant: "destructive" });
    }
  };
  const openRow = (task: Task, dense = false) => (
    <SwipeableItem
      key={task.id}
      onSwipeLeft={() => swipePatch(task, { status: "done" }, `"${task.title}" completed`, `Failed to complete "${task.title}"`, true)}
      // Tomorrow in the user's zone: the UTC slice was already a day ahead
      // after ~5 PM Pacific, so "snooze to tomorrow" landed two days out.
      onSwipeRight={() => swipePatch(task, { dueDate: tzAddDays(getUserToday(BROWSER_TIMEZONE), 1) }, `"${task.title}" snoozed to tomorrow`, `Failed to snooze "${task.title}"`)}
    >
      <TaskItem task={task} onEdit={setEditTask} today={todayStr} linked={linkedOf(task)} dense={dense} />
    </SwipeableItem>
  );
  const doneRow = (task: Task) => (
    <SwipeableItem
      key={task.id}
      leftLabel="↩ Reopen"
      leftColor="#3b82f6"
      onSwipeLeft={() => swipePatch(task, { status: "todo" }, `"${task.title}" reopened`, `Failed to reopen "${task.title}"`)}
    >
      <TaskItem task={task} onEdit={setEditTask} today={todayStr} linked={linkedOf(task)} />
    </SwipeableItem>
  );

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-8 w-48 rounded-full" />
        <BubbleSkeletonGrid count={4} rows={2} height={140} className="grid-cols-1 sm:grid-cols-2" />
      </div>
    );
  }

  if (error) return (
    <div className="p-4 text-center">
      <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
      <p className="text-sm text-destructive">Failed to load data</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
    </div>
  );

  // profileFilteredTasks, activeTasks, completedTasks are memoized above (before early returns)

  return (
    <PageContainer testId="page-tasks">
      {/* Title, counts and the one primary action — the header every hub
          page has. The profile filter is a list control and lives on the
          toolbar below (beside the title it squeezed "Tasks" down to "T."). */}
      <PageHeader
        title={<span className="text-2xl">Tasks</span>}
        subtitle={<span className="text-xs">Task Command Center</span>}
        icon={CheckCircle2}
        accent={TASKS_ACCENT}
        backHref="/dashboard"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-new-task">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Task
          </Button>
        }
      />

      {/* Summary band — the tracker popup's stat tile. A tile with something
          in it brings the first row it counts into view. */}
      <div className="grid grid-cols-4 gap-1.5" data-testid="tasks-summary">
        {([
          { label: "Today", value: taskSummary.dueToday, tone: TASK_TONES.dueToday, icon: CalendarDays, jump: () => jumpTo(r => r.dataset.tone === "dueToday") },
          { label: "This week", value: dueThisWeek, tone: TASK_TONES.upcoming, icon: CalendarDays, jump: () => jumpTo(r => !!r.dataset.due && r.dataset.due >= todayStr && r.dataset.due <= weekEnd) },
          { label: "Overdue", value: taskSummary.overdue, tone: TASK_TONES.overdue, icon: Hourglass, jump: () => jumpTo(r => r.dataset.tone === "overdue") },
          { label: "Done today", value: taskSummary.doneToday, tone: TASK_TONES.done, icon: CheckCircle2, jump: () => jumpTo(r => r.dataset.tone === "done", true) },
        ]).map((s, i) => {
          // Rendered as a plain value, not a count-up: the animation started
          // every tile at "0" and sat there for seconds while the long list
          // below was still being laid out, reading as a real zero (F-25).
          const live = !!s.value;
          const Tile: any = live ? "button" : "div";
          return (
            <Tile key={s.label} type={live ? "button" : undefined} onClick={live ? s.jump : undefined}
              className={`td-scope bubble td-rise px-2 py-2 min-w-0 text-left flex items-center gap-1.5 ${live ? "bubble-interactive pressable" : ""}`}
              style={{ ["--i" as any]: i, borderRadius: "0.9rem", ...accentScope(s.tone.hs, s.tone.hs2) }}
              data-testid={`tasks-summary-${s.label.toLowerCase().replace(/ /g, "-")}`}>
              <s.icon className="h-5 w-5 shrink-0" style={{ color: `hsl(var(--td-hs) var(--td-l))` }} strokeWidth={2} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[11px] font-medium text-muted-foreground leading-tight">{s.label}</span>
                <span className="metric-value block text-lg leading-none mt-0.5">{s.value == null ? "—" : s.value}</span>
              </span>
            </Tile>
          );
        })}
      </div>

      {/* Tab filters: what the tasks are about. Counts are open tasks. */}
      <div className="flex items-stretch gap-0.5 rounded-full p-1 bg-muted/60 dark:bg-foreground/5 ring-1 ring-inset ring-border/50" data-testid="task-tab-filters">
        {([{ key: "all" as const, label: "All", icon: null as LucideIcon | null, n: activeTasks.length }, ...sections.map(sec => ({ key: sec.def.kind, label: sec.def.tab, icon: sec.def.icon as LucideIcon | null, n: sec.openTotal }))]).map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setTabFilter(tab.key)}
            aria-pressed={tabFilter === tab.key}
            className={`flex-auto inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1.5 text-xs font-semibold transition-colors ${
              tabFilter === tab.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-${tab.key}`}
          >
            {tab.icon && <tab.icon className="hidden min-[480px]:block h-3.5 w-3.5" aria-hidden="true" />}
            {tab.label} ({tab.n})
          </button>
        ))}
      </div>
      <div className="min-w-0">
        <MultiProfileFilter onChange={() => {}} compact />
      </div>

      {hiddenByScope > 0 && visibleTasks.length > 0 && (
        <ActiveFilterNotice
          shown={visibleTasks.length}
          total={totalTasks}
          noun={TASK_NOUN}
          labels={scopeLabels}
          onClear={() => setFilterEveryone()}
          testId="tasks-scope-notice"
        />
      )}

      {visibleTasks.length === 0 && hiddenByScope > 0 ? (
        <FilteredEmptyState
          total={hiddenByScope}
          noun={TASK_NOUN}
          labels={scopeLabels}
          onClear={() => setFilterEveryone()}
          testId="tasks-scope-empty"
        />
      ) : visibleTasks.length === 0 ? (
        <EmptyState scope="none"
          icon={ListTodo}
          accent={TASKS_ACCENT}
          label="Nothing on your list"
          hint="Add a task here, or just tell Portol in chat — “remind me to renew the registration”."
          ctaLabel="Create your first task"
          onCta={() => setCreateOpen(true)}
        />
      ) : (
        <>
          {sections.filter(sec => tabFilter === "all" || tabFilter === sec.def.kind).map(sec => {
            const { def } = sec;
            const empty = sec.openTotal === 0 && sec.done.length === 0;
            if (empty && tabFilter === "all") return null;
            if (empty) {
              return (
                <EmptyState key={def.kind} scope="global" icon={def.icon}
                  label={def.kind === "mine" ? "No personal tasks" : `No ${def.kind} tasks`}
                  hint={def.kind === "mine" ? "Create a task to see it here." : `Create a task and choose ${def.kind === "asset" ? "an asset" : "a liability"} under “Related to”.`} />
              );
            }
            const isCollapsed = !!collapsed[def.kind];
            const doneOpen = !!showDone[def.kind];
            return (
              <section key={def.kind} className="td-scope td-hero td-rise" style={{ ...accentScope(def.hs, def.hs2), borderRadius: "1rem", borderLeft: `3px solid hsl(${def.hs} var(--td-l))` }} data-testid={`tasks-group-${def.kind}`}>
                <div className="relative z-[1]">
                  <button
                    type="button"
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                    onClick={() => setCollapsed(c => ({ ...c, [def.kind]: !c[def.kind] }))}
                    aria-expanded={!isCollapsed}
                    data-testid={`tasks-group-toggle-${def.kind}`}
                  >
                    <span className="medallion medallion-sm" aria-hidden="true"><def.icon className="h-4 w-4" strokeWidth={2.2} /></span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-lg font-bold tracking-tight leading-tight">{def.title}</span>
                      <span className="block text-[11px] text-muted-foreground truncate mt-0.5">{def.subtitle} ({sec.openTotal})</span>
                    </span>
                    <span
                      className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums"
                      style={{ color: `hsl(var(--td-hs) var(--td-l))`, boxShadow: `inset 0 0 0 1px hsl(var(--td-hs) var(--td-l) / 0.45)`, background: `hsl(var(--td-hs) var(--td-l) / 0.10)` }}
                      data-testid={`tasks-group-open-${def.kind}`}
                    >
                      {sec.openTotal} open
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "" : "rotate-180"}`} aria-hidden="true" />
                  </button>

                  {!isCollapsed && (
                    <div className="px-1.5 pb-1.5 space-y-1" data-testid={`tasks-group-rows-${def.kind}`}>
                      {sec.openTotal === 0 && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">Nothing open here.</p>
                      )}
                      {def.kind === "mine"
                        ? sec.open.map(t => openRow(t))
                        : sec.items.map(({ profile, rows }) => {
                          const ItemIcon = ITEM_ICONS[profile.type] || Package;
                          const photo = /^(https?:|data:image\/)/.test(String(profile.avatar || "")) ? profile.avatar : null;
                          return (
                            // One asset or liability and the tasks tied to it.
                            // The header opens that item's own page.
                            <div key={profile.id} className="rounded-[0.8rem] flex items-stretch" style={{ boxShadow: `inset 0 0 0 1px hsl(var(--td-hs) var(--td-l) / 0.22)`, background: `hsl(var(--td-hs) var(--td-l) / 0.05)` }} data-testid={`tasks-item-${profile.id}`}>
                              <button
                                type="button"
                                className="w-[37%] shrink-0 flex items-center gap-2 p-2 text-left pressable rounded-l-[0.8rem]"
                                style={{ boxShadow: `inset -1px 0 0 hsl(var(--td-hs) var(--td-l) / 0.18)` }}
                                onClick={() => hashNavigate(`/profiles/${profile.id}`)}
                                aria-label={`Open ${profile.name}`}
                                data-testid={`tasks-item-link-${profile.id}`}
                              >
                                {photo
                                  ? <img src={photo} alt="" className="h-9 w-9 rounded-lg object-cover shrink-0" />
                                  : (
                                    // No picture stored: an asset shows its kind's icon, a
                                    // bill its initial, on a tile in the section's colour.
                                    <span
                                      className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center text-sm font-bold text-white"
                                      style={{ background: `linear-gradient(145deg, hsl(var(--td-hs) 52%), hsl(var(--td-hs2) 42%))`, boxShadow: `0 4px 12px -6px hsl(var(--td-hs) 50% / 0.8)` }}
                                      aria-hidden="true"
                                    >
                                      {def.kind === "liability" ? (profile.name.trim().charAt(0).toUpperCase() || "?") : <ItemIcon className="h-4 w-4" strokeWidth={2.2} />}
                                    </span>
                                  )}
                                <span className="flex-1 min-w-0">
                                  <span className="text-[13px] font-semibold leading-tight line-clamp-2" title={profile.name}>{profile.name}</span>
                                  <span className="block text-[11px] text-muted-foreground leading-tight mt-0.5">
                                    {rows.length} {rows.length === 1 ? "task" : "tasks"} · {taskGroupItemKind(profile)}
                                  </span>
                                </span>
                              </button>
                              <div className="flex-1 min-w-0 p-1 space-y-1 flex flex-col justify-center">
                                {rows.map(t => openRow(t, true))}
                              </div>
                            </div>
                          );
                        })}

                      {/* Completed tasks stay with their section, folded away. */}
                      {sec.done.length > 0 && (
                        <>
                          <button
                            type="button"
                            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                            onClick={() => setShowDone(d => ({ ...d, [def.kind]: !d[def.kind] }))}
                            aria-expanded={doneOpen}
                            data-testid={`tasks-group-done-toggle-${def.kind}`}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {doneOpen ? "Hide" : "Show"} {sec.done.length} completed
                          </button>
                          {doneOpen && sec.done.slice(0, visibleCompleted).map(doneRow)}
                          {doneOpen && sec.done.length > visibleCompleted && (
                            <div className="pt-1 flex justify-center">
                              <Button variant="outline" size="sm" onClick={() => setVisibleCompleted((n) => n + TASK_PAGE)} data-testid={`button-show-more-completed-tasks-${def.kind}`}>
                                Show more ({sec.done.length - visibleCompleted} remaining)
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
          {sortedActive.length > visibleActive && (
            <div className="pt-1 flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setVisibleActive((n) => n + TASK_PAGE)} data-testid="button-show-more-active-tasks">
                Show more ({sortedActive.length - visibleActive} remaining)
              </Button>
            </div>
          )}
        </>
      )}

      {/* Create dialog */}
      {createOpen && (
        <TaskDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      )}

      {/* Edit dialog */}
      {editTask && (
        <TaskDialog open={!!editTask} onClose={() => setEditTask(null)} task={editTask} />
      )}
    </PageContainer>
  );
}
