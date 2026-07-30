import { formatApiError } from "@/lib/formatError";
import { stopProp } from "@/lib/event-utils";
import { EmptyState } from "@/components/ui/empty-state";
import { useQuery, useMutation } from "@tanstack/react-query";
import EditableTitle from "@/components/EditableTitle";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useProfileScope, useActiveCreateProfileId } from "@/hooks/useProfileScope";
import { formatStoredDate, farFutureWarning } from "@/lib/dates";
import { passesProfileFilter } from "@shared/profile-filter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { Card, CardContent } from "@/components/ui/card";
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
  SelectItem,
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
import { ListTodo, Calendar, AlertCircle, ArrowLeft, Plus, Trash2, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import type { Task, Profile } from "@shared/schema";
import { useState, useEffect, useRef, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "bg-red-500/10 text-red-600 dark:text-red-400",
};

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
        const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, body);
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
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid={isEdit ? "dialog-edit-task" : "dialog-create-task"}>
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
              <Label>Profile</Label>
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger data-testid="select-task-profile"><SelectValue placeholder="Profile" /></SelectTrigger>
                <SelectContent>
                  {profiles.filter(p => ["self", "person", "pet"].includes(p.type)).map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.type === "self" ? "Me" : p.name}
                    </SelectItem>
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

// ── Task Item ────────────────────────────────────────────────────────────────

function TaskItem({
  task,
  onEdit,
}: {
  task: Task;
  onEdit: (t: Task) => void;
}) {
  const { toast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Optimistic rows carry a synthetic "tmp-"/"temp-" id until the create
  // settles; PATCH/DELETE against one 404s ("red error but it worked" class).
  const isTempTask = /^te?mp-/.test(String(task.id));
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
      // Confirm instantly — the row already flipped optimistically. Toasting
      // in onSuccess bound the confirmation to the server roundtrip (8s+ on a
      // cold serverless write), which read as "the notification comes 30
      // seconds later". On failure the destructive toast below replaces this.
      toast({ title: task.status === "done" ? `"${task.title}" reopened` : `"${task.title}" completed` });
      return { prevQueries };
    },
    onSuccess: () => {
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
      // Instant confirmation (see toggleMutation note).
      toast({ title: `"${task.title}" restored` });
      return { prevQueries };
    },
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
      <Card
        data-testid={`card-task-${task.id}`}
        className={`transition-colors ${task.status === "done" ? "opacity-60" : ""}`}
      >
        <CardContent className="p-4 flex items-start gap-3">
          <Checkbox
            checked={task.status === "done"}
            onCheckedChange={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            className={`mt-0.5 ${toggleMutation.isPending ? "opacity-50 animate-pulse" : ""}`}
            data-testid={`checkbox-task-${task.id}`}
          />
          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={() => onEdit(task)}
            // a11y: keyboard-operable stand-in for a click target that wraps
            // block content (can't be a <button> — it contains EditableTitle's
            // own interactive controls, and nested buttons are invalid HTML).
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
            <div
              className={`text-sm font-medium ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}
              data-testid={`text-task-title-${task.id}`}
              onClick={(e) => e.stopPropagation()}
            >
              <EditableTitle
                value={task.title}
                onSave={async (newTitle) => {
                  try {
                    await apiRequest("PATCH", `/api/tasks/${task.id}`, { title: newTitle });
                    invalidateTaskQueries();
                    toast({ title: `Renamed to "${newTitle}"` });
                  } catch (err: any) {
                    toast({ title: "Failed to rename task", description: formatApiError(err), variant: "destructive" });
                  }
                }}
              />
            </div>
            {task.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.description}</p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap min-w-0">
              <Badge variant="secondary" className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>
                {task.priority === "high" && <AlertCircle className="h-3 w-3 mr-1" />}
                {task.priority}
              </Badge>
              {task.dueDate && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {/* One formatter, shared with every other due-date surface:
                      never shifts a day, always shows a non-current year. */}
                  {formatStoredDate(task.dueDate) || task.dueDate}
                </span>
              )}
              {/* BUG-TSK-002: tags must wrap and never truncate */}
              {task.tags?.map(tag => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="text-xs max-w-full whitespace-normal break-words leading-tight py-0.5"
                  style={{ height: "auto" }}
                  data-testid={`badge-task-tag-${task.id}-${tag}`}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
            onClick={stopProp(() => setDeleteOpen(true))}
            disabled={deleteMutation.isPending}
            aria-label="Delete task"
            data-testid={`button-delete-task-${task.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </CardContent>
      </Card>

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
    <div className="relative overflow-hidden rounded-lg">
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
        style={{ transform: `translateX(${offsetX}px)`, transition: offsetX === 0 ? 'transform 0.2s ease' : 'none', background: 'hsl(var(--card))', position: 'relative' }}
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
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const [tabFilter, setTabFilter] = useState<"all" | "open" | "completed">("all");

  const taskUrl = filterMode === "selected" && filterIds.length > 0
    ? `/api/tasks?profileIds=${filterIds.join(",")}`
    : "/api/tasks";
  const { data: tasks, isLoading, error, refetch } = useQuery<Task[]>({
    queryKey: ["/api/tasks", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", taskUrl).then(r => r.json()),
  });

  // Profiles are needed for the unified filter rule below (it must know which
  // profiles are `self` to decide whether orphan tasks pass the filter).
  const { data: allProfiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Apply profile filter client-side (must be before early returns — Rules of Hooks).
  // P2.4 remediation: use the unified passesProfileFilter rule
  // (shared/profile-filter.ts) instead of an inline `linked.some(...)` so
  // orphan tasks (no linkedProfiles) still show when the selection includes a
  // self profile — matching finance/journal/server semantics.
  const profileFilteredTasks = useMemo(() => {
    if (filterMode === "everyone" || filterIds.length === 0) return tasks || [];
    const ctx = {
      selectedIds: filterIds,
      allProfiles: allProfiles.map(p => ({ id: p.id, type: p.type })),
    };
    return (tasks || []).filter(t => passesProfileFilter(t.linkedProfiles, ctx));
  }, [tasks, filterMode, filterIds, allProfiles]);
  const activeTasks = useMemo(() => profileFilteredTasks.filter(t => t.status !== "done"), [profileFilteredTasks]);
  const completedTasks = useMemo(() => profileFilteredTasks.filter(t => t.status === "done"), [profileFilteredTasks]);
  // v2 summary band: overdue / today / upcoming / done.
  const taskSummary = useMemo(() => {
    const todayStr = new Date().toLocaleDateString("en-CA");
    let overdue = 0, dueToday = 0, upcoming = 0;
    for (const t of activeTasks) {
      const d = String(t.dueDate || "").slice(0, 10);
      if (!d) continue;
      if (d < todayStr) overdue++;
      else if (d === todayStr) dueToday++;
      else upcoming++;
    }
    return { overdue, dueToday, upcoming, done: completedTasks.length };
  }, [activeTasks, completedTasks]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <div className="h-8 w-48 rounded skeleton-shimmer" />
        <div className="h-20 rounded skeleton-shimmer" />
        <div className="h-20 rounded skeleton-shimmer" />
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
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-tasks">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Link href="/dashboard" className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </Link>

            <MultiProfileFilter
              // The chip writes straight to the global scope store; useProfileScope
              // above re-renders this page reactively, so no local wiring is needed.
              onChange={() => {}}
              compact
            />
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {activeTasks.length} active, {completedTasks.length} completed
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-new-task">
          <Plus className="h-3.5 w-3.5 mr-1" /> New Task
        </Button>
      </div>

      {/* v2 summary band */}
      <div className="grid grid-cols-4 gap-2" data-testid="tasks-summary">
        {[
          { label: "Overdue", value: taskSummary.overdue, color: "0 72% 55%" },
          { label: "Today", value: taskSummary.dueToday, color: "43 85% 52%" },
          { label: "Upcoming", value: taskSummary.upcoming, color: "200 80% 55%" },
          { label: "Done", value: taskSummary.done, color: "155 60% 48%" },
        ].map(s => (
          <div key={s.label} className="bubble p-2.5 text-center">
            <p className="text-lg font-bold tabular-nums leading-none" style={{ color: `hsl(${s.color})` }}>{s.value}</p>
            <p className="mt-1 micro-label text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tab filters */}
      <div className="flex items-center gap-1" data-testid="task-tab-filters">
        {(["all", "open", "completed"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setTabFilter(tab)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              tabFilter === tab
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
            data-testid={`tab-${tab}`}
          >
            {tab === "all" ? `All (${profileFilteredTasks.length})`
              : tab === "open" ? `Open (${activeTasks.length})`
              : `Completed (${completedTasks.length})`}
          </button>
        ))}
      </div>

      {profileFilteredTasks.length === 0 ? (
        <div className="text-center py-16">
          <ListTodo className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Create your first task
          </Button>
        </div>
      ) : (
        <>
          {(tabFilter === "all" || tabFilter === "open") && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Active ({activeTasks.length})
              </h2>
              {activeTasks.length === 0 ? (
                <EmptyState icon={ListTodo} label="No active tasks" hint="All tasks are completed or create a new one." />
              ) : (
                activeTasks.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).map(task => (
                  <SwipeableItem
                    key={task.id}
                    onSwipeLeft={async () => {
                      // Optimistic update: mark task done immediately
                      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
                      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
                      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
                        (old || []).map(t => t.id === task.id ? { ...t, status: "done" as const } : t)
                      );
                      toast({ title: `"${task.title}" completed` });
                      try {
                        await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: "done" });
                        invalidateTaskQueries();
                      } catch (err: any) {
                        // Rollback
                        for (const [key, data] of prevQueries) queryClient.setQueryData(key, data);
                        toast({ title: `Failed to complete "${task.title}"`, description: formatApiError(err), variant: "destructive" });
                      }
                    }}
                    onSwipeRight={async () => {
                      const tomorrow = new Date();
                      tomorrow.setDate(tomorrow.getDate() + 1);
                      const dateStr = tomorrow.toISOString().slice(0, 10);
                      // Optimistic update: set dueDate immediately
                      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
                      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
                      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
                        (old || []).map(t => t.id === task.id ? { ...t, dueDate: dateStr } : t)
                      );
                      toast({ title: `"${task.title}" snoozed to tomorrow` });
                      try {
                        await apiRequest("PATCH", `/api/tasks/${task.id}`, { dueDate: dateStr });
                        invalidateTaskQueries();
                      } catch (err: any) {
                        for (const [key, data] of prevQueries) queryClient.setQueryData(key, data);
                        toast({ title: `Failed to snooze "${task.title}"`, description: formatApiError(err), variant: "destructive" });
                      }
                    }}
                  >
                    <TaskItem task={task} onEdit={setEditTask} />
                  </SwipeableItem>
                ))
              )}
            </div>
          )}
          {(tabFilter === "all" || tabFilter === "completed") && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Completed ({completedTasks.length})
              </h2>
              {completedTasks.length === 0 ? (
                <EmptyState icon={CheckCircle2} label="No completed tasks" hint="Complete a task to see it here." />
              ) : (
                completedTasks.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).map(task => (
                  <SwipeableItem
                    key={task.id}
                    leftLabel="↩ Reopen"
                    leftColor="#3b82f6"
                    onSwipeLeft={async () => {
                      // Optimistic: reopen immediately
                      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
                      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
                      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
                        (old || []).map(t => t.id === task.id ? { ...t, status: "todo" as const } : t)
                      );
                      toast({ title: `"${task.title}" reopened` });
                      try {
                        await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: "todo" });
                        invalidateTaskQueries();
                      } catch (err: any) {
                        for (const [key, data] of prevQueries) queryClient.setQueryData(key, data);
                        toast({ title: `Failed to reopen "${task.title}"`, description: formatApiError(err), variant: "destructive" });
                      }
                    }}
                  >
                    <TaskItem task={task} onEdit={setEditTask} />
                  </SwipeableItem>
                ))
              )}
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
    </div>
  );
}
