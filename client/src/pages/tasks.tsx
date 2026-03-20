import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ListTodo,
  Calendar,
  AlertCircle,
  Plus,
  Filter,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import type { Task } from "@shared/schema";
import { useState } from "react";

const priorityColor: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "bg-red-500/10 text-red-600 dark:text-red-400",
};

function TaskItem({ task }: { task: Task }) {
  const queryClient = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const newStatus = task.status === "done" ? "todo" : "done";
      const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: newStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  return (
    <Card
      data-testid={`card-task-${task.id}`}
      className={`transition-colors ${task.status === "done" ? "opacity-60" : ""}`}
    >
      <CardContent className="p-4 flex items-start gap-3">
        <Checkbox
          checked={task.status === "done"}
          onCheckedChange={() => toggleMutation.mutate()}
          className="mt-0.5"
          data-testid={`checkbox-task-${task.id}`}
        />
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}
            data-testid={`text-task-title-${task.id}`}
          >
            {task.title}
          </p>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{task.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="secondary" className={`text-xs ${priorityColor[task.priority]}`}>
              {task.priority === "high" && <AlertCircle className="h-3 w-3 mr-1" />}
              {task.priority}
            </Badge>
            {task.dueDate && (() => {
              const today = new Date().toISOString().slice(0, 10);
              const isOverdue = task.status !== "done" && task.dueDate < today;
              const isToday = task.dueDate === today;
              return (
                <span className={`text-xs flex items-center gap-1 ${isOverdue ? "text-red-500 font-medium" : isToday ? "text-amber-500" : "text-muted-foreground"}`}>
                  <Calendar className="h-3 w-3" />
                  {isOverdue ? "Overdue: " : isToday ? "Today: " : ""}
                  {isNaN(new Date(task.dueDate).getTime()) ? task.dueDate : new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              );
            })()}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TasksPage() {
  const [filter, setFilter] = useState<"all" | "high" | "overdue" | "today">("all");
  const [newTitle, setNewTitle] = useState("");
  const queryClient = useQueryClient();

  const { data: tasks, isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const createMutation = useMutation({
    mutationFn: (title: string) => apiRequest("POST", "/api/tasks", { title, priority: "medium" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/tasks"] }); setNewTitle(""); },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 rounded-lg skeleton-shimmer" />
        ))}
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  let activeTasks = (tasks || []).filter((t) => t.status !== "done");
  const completedTasks = (tasks || []).filter((t) => t.status === "done");
  const overdueCount = activeTasks.filter(t => t.dueDate && t.dueDate < today).length;

  // Apply filter
  if (filter === "high") activeTasks = activeTasks.filter(t => t.priority === "high");
  else if (filter === "overdue") activeTasks = activeTasks.filter(t => t.dueDate && t.dueDate < today);
  else if (filter === "today") activeTasks = activeTasks.filter(t => t.dueDate === today);

  return (
    <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full" data-testid="page-tasks">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold" data-testid="text-tasks-title">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {activeTasks.length} active, {completedTasks.length} completed
            {overdueCount > 0 && <span className="text-red-500 ml-1">({overdueCount} overdue)</span>}
          </p>
        </div>
      </div>

      {/* Quick create */}
      <div className="flex gap-2">
        <Input
          placeholder="Add a task..."
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === "Enter" && newTitle.trim() && createMutation.mutate(newTitle.trim())}
          data-testid="input-task-title"
        />
        <Button
          size="sm"
          disabled={!newTitle.trim() || createMutation.isPending}
          onClick={() => newTitle.trim() && createMutation.mutate(newTitle.trim())}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex gap-2 flex-wrap">
        {([
          ["all", "All"],
          ["high", "High Priority"],
          ["overdue", "Overdue"],
          ["today", "Due Today"],
        ] as const).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? "default" : "outline"}
            onClick={() => setFilter(key)}
            className="h-7 text-xs"
          >
            {label}
          </Button>
        ))}
      </div>

      {(!tasks || tasks.length === 0) ? (
        <div className="text-center py-16">
          <ListTodo className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No tasks yet. Create one via chat.</p>
          <p className="text-xs text-muted-foreground mt-1">Try: "remind me to call the dentist"</p>
        </div>
      ) : (
        <>
          {activeTasks.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Active ({activeTasks.length})
              </h2>
              {activeTasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          )}
          {completedTasks.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Completed ({completedTasks.length})
              </h2>
              {completedTasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
