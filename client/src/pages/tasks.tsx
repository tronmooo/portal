import React from "react";
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
  ArrowLeft,
} from "lucide-react";
import { Link } from "wouter";
import type { Task } from "@shared/schema";

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
            {task.dueDate && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {isNaN(new Date(task.dueDate).getTime()) ? task.dueDate : new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TasksPage() {
  const { data: tasks, isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
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

  const activeTasks = React.useMemo(() => (tasks || []).filter((t) => t.status !== "done"), [tasks]);
  const completedTasks = React.useMemo(() => (tasks || []).filter((t) => t.status === "done"), [tasks]);

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full" data-testid="page-tasks">
      <div>
        <div className="flex items-center gap-3 mb-4">
          <Link href="/dashboard">
            <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back to dashboard">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <h1 className="text-xl font-semibold" data-testid="text-tasks-title">Tasks</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {activeTasks.length} active, {completedTasks.length} completed
        </p>
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
