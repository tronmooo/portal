import { formatApiError } from "@/lib/formatError";
import { stopProp } from "@/lib/event-utils";
import { EmptyState } from "@/components/EmptyState";
import { useQuery, useMutation } from "@tanstack/react-query";
import EditableTitle from "@/components/EditableTitle";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getProfileFilter } from "@/lib/profileFilter";
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
import { ToastAction } from "@/components/ui/toast";
import { ListTodo, Calendar, AlertCircle, ArrowLeft, Plus, Trash2, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import type { Task } from "@shared/schema";
import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "bg-red-500/10 text-red-600 dark:text-red-400",
};

const invalidateTaskQueries = () => {
  queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  // Also invalidate dashboard so KPIs recompute after task changes
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
};

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

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        dueDate: dueDate || undefined,
        tags: tagsInput.split(",").map(t => t.trim()).filter(Boolean),
      };
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, body);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/tasks", body);
      return res.json();
    },
    onSuccess: () => {
      invalidateTaskQueries();
      toast({ title: isEdit ? `"${title.trim()}" updated` : `"${title.trim()}" created`, description: dueDate ? `Due ${new Date(dueDate + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : undefined });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: isEdit ? "Update failed" : "Create failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast({ title: "Title required", description: "Enter a task title", variant: "destructive" });
      return;
    }
    mutation.mutate();
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

  const toggleMutation = useMutation<any,Error,void>({
    mutationFn: async () => {
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
      return { prevQueries };
    },
    onSuccess: () => {
      invalidateTaskQueries();
      toast({ title: task.status === "done" ? `"${task.title}" reopened` : `"${task.title}" completed` });
    },
    onError: (err: Error, _vars, context: any) => {
      // Rollback optimistic update on error
      if (context?.prevQueries) {
        for (const [key, data] of context.prevQueries) {
          queryClient.setQueryData(key, data);
        }
      }
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
      return { prevQueries };
    },
    onSuccess: () => {
      toast({ title: `"${task.title}" restored` });
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prevQueries) { for (const [key, data] of ctx.prevQueries) queryClient.setQueryData(key, data); }
      toast({ title: `Failed to restore "${task.title}"`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => { invalidateTaskQueries(); },
  });

  const deleteMutation = useMutation<any,Error,void>({
    mutationFn: () => apiRequest("DELETE", `/api/tasks/${task.id}`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prevQueries = queryClient.getQueriesData<Task[]>({ queryKey: ["/api/tasks"] });
      queryClient.setQueriesData<Task[]>({ queryKey: ["/api/tasks"] }, (old) =>
        (old || []).filter(t => t.id !== task.id)
      );
      return { prevQueries };
    },
    onSuccess: () => {
      toast({
        title: `"${task.title}" deleted`,
        action: <ToastAction altText="Undo" onClick={() => restoreMutation.mutate()}>Undo</ToastAction>,
      });
    },
    onError: (err: Error, _v: unknown, ctx: any) => {
      if (ctx?.prevQueries) { for (const [key, data] of ctx.prevQueries) queryClient.setQueryData(key, data); }
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
            onCheckedChange={stopProp(() => toggleMutation.mutate())}
            disabled={toggleMutation.isPending}
            className={`mt-0.5 ${toggleMutation.isPending ? "opacity-50 animate-pulse" : ""}`}
            data-testid={`checkbox-task-${task.id}`}
          />
          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={() => onEdit(task)}
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
                  await apiRequest("PATCH", `/api/tasks/${task.id}`, { title: newTitle });
                  invalidateTaskQueries();
                  toast({ title: `Renamed to "${newTitle}"` });
                }}
              />
            </div>
            {task.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.description}</p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="secondary" className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>
                {task.priority === "high" && <AlertCircle className="h-3 w-3 mr-1" />}
                {task.priority}
              </Badge>
              {task.dueDate && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {(() => {
                    // Parse as local date to avoid off-by-one from UTC conversion
                    const raw = task.dueDate.slice(0, 10); // "YYYY-MM-DD"
                    const d = new Date(raw + "T00:00:00");
                    return isNaN(d.getTime()) ? task.dueDate : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                  })()}
                </span>
              )}
              {task.tags?.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs h-5">{tag}</Badge>
              ))}
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
            onClick={stopProp(() => setDeleteOpen(true))}
            disabled={deleteMutation.isPending}
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
  const [createOpen, setCreateOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [tabFilter, setTabFilter] = useState<"all" | "open" | "completed">("all");

  const taskUrl = filterMode === "selected" && filterIds.length > 0
    ? `/api/tasks?profileIds=${filterIds.join(",")}`
    : "/api/tasks";
  const { data: tasks, isLoading, error, refetch } = useQuery<Task[]>({
    queryKey: ["/api/tasks", filterMode, filterIds],
    queryFn: () => apiRequest("GET", taskUrl).then(r => r.json()),
  });

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

  // Apply profile filter client-side
  const profileFilteredTasks = (tasks || []).filter(t => {
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const linked = t.linkedProfiles || [];
    return linked.some(id => filterIds.includes(id));
  });
  const activeTasks = profileFilteredTasks.filter(t => t.status !== "done");
  const completedTasks = profileFilteredTasks.filter(t => t.status === "done");

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-tasks">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>

            <MultiProfileFilter
              onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
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
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Active ({activeTasks.length})
              </h2>
              {activeTasks.length === 0 ? (
                <EmptyState icon={ListTodo} title="No active tasks" description="All tasks are completed or create a new one." />
              ) : (
                activeTasks.map(task => (
                  <SwipeableItem
                    key={task.id}
                    onSwipeLeft={async () => {
                      try {
                        await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: "done" });
                        invalidateTaskQueries();
                      } catch {}
                    }}
                    onSwipeRight={async () => {
                      try {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        const dateStr = tomorrow.toISOString().slice(0, 10);
                        await apiRequest("PATCH", `/api/tasks/${task.id}`, { dueDate: dateStr });
                        invalidateTaskQueries();
                      } catch {}
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
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Completed ({completedTasks.length})
              </h2>
              {completedTasks.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="No completed tasks" description="Complete a task to see it here." />
              ) : (
                completedTasks.map(task => (
                  <SwipeableItem
                    key={task.id}
                    leftLabel="↩ Reopen"
                    leftColor="#3b82f6"
                    onSwipeLeft={async () => {
                      try {
                        await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: "todo" });
                        invalidateTaskQueries();
                      } catch {}
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
