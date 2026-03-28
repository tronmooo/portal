import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Flame, Plus, Check, Trophy, Droplets, Brain, BookOpen, Smartphone, Zap, ArrowLeft, Trash2, Pencil } from "lucide-react";
import { Link } from "wouter";
import type { Habit, HabitFrequency } from "@shared/schema";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

const ICON_MAP: Record<string, any> = { Droplets, Brain, BookOpen, Smartphone, Zap, Flame };
const ICON_OPTIONS = ["Flame", "Droplets", "Brain", "BookOpen", "Smartphone", "Zap"] as const;
const COLOR_OPTIONS = [
  "#4F98A3", "#6DAA45", "#BB653B", "#A86FDF", "#5591C7", "#D19900", "#E85D75", "#01696F",
];
const FREQUENCY_OPTIONS = ["daily", "weekly", "custom"] as const;

function HabitEditDialog({
  habit,
  open,
  onClose,
}: {
  habit: Habit;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(habit.name);
  const [frequency, setFrequency] = useState<HabitFrequency>(habit.frequency);
  const [icon, setIcon] = useState(habit.icon || "Flame");
  const [color, setColor] = useState(habit.color || "#4F98A3");

  const updateMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `/api/habits/${habit.id}`, {
        name: name.trim(),
        frequency,
        icon,
        color,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      toast({ title: "Habit updated" });
      onClose();
    },
    onError: () => toast({ title: "Failed to update habit", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid={`dialog-edit-habit-${habit.id}`}>
        <DialogHeader>
          <DialogTitle className="text-sm">Edit Habit</DialogTitle>
          <DialogDescription className="text-xs">Update habit name, frequency, and appearance</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 py-1"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) updateMutation.mutate(); }}
        >
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Habit name"
              required
              data-testid="input-edit-habit-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Frequency</Label>
            <Select value={frequency} onValueChange={setFrequency}>
              <SelectTrigger data-testid="select-edit-habit-frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCY_OPTIONS.map((f) => (
                  <SelectItem key={f} value={f} className="capitalize">{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Icon</Label>
            <div className="flex gap-2 flex-wrap">
              {ICON_OPTIONS.map((ic) => {
                const Ic = ICON_MAP[ic] || Flame;
                return (
                  <button
                    key={ic}
                    type="button"
                    className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-all ${
                      icon === ic ? "border-primary bg-primary/10" : "border-border hover:border-foreground/30"
                    }`}
                    onClick={() => setIcon(ic)}
                    data-testid={`button-icon-${ic}`}
                  >
                    <Ic className="h-4 w-4" style={{ color: icon === ic ? color : undefined }} />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Color</Label>
            <div className="flex gap-2 flex-wrap">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    color === c ? "border-foreground scale-110" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                  data-testid={`button-color-${c}`}
                />
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!name.trim() || updateMutation.isPending} data-testid="button-save-habit-edit">
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HabitCard({ habit }: { habit: Habit }) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const checkedToday = habit.checkins.some((c) => c.date === today);
  const Icon = ICON_MAP[habit.icon || ""] || Flame;

  const checkinMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/habits"] }),
    onError: () => toast({ title: "Failed to check in", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/habits/${habit.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      toast({ title: "Habit deleted" });
    },
    onError: () => toast({ title: "Failed to delete habit", variant: "destructive" }),
  });

  // Build last 14 days grid
  const last14: { date: string; done: boolean }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dd = new Date(Date.now() - i * 86400000);
    const dateStr = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(dd.getDate()).padStart(2, "0")}`;
    last14.push({ date: dateStr, done: habit.checkins.some((c) => c.date === dateStr) });
  }

  return (
    <>
      <Card className="relative overflow-hidden" data-testid={`card-habit-${habit.id}`}>
        <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: habit.color || "#4F98A3" }} />
        <CardHeader className="pb-2 pl-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Icon className="h-4 w-4 shrink-0" style={{ color: habit.color || "#4F98A3" }} />
              <CardTitle className="text-sm font-medium truncate">{habit.name}</CardTitle>
            </div>
            <div className="flex items-center gap-1 shrink-0">
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
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => setEditOpen(true)}
                aria-label={`Edit ${habit.name}`}
                data-testid={`button-edit-habit-${habit.id}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${habit.name}`}
                    data-testid={`button-delete-habit-${habit.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete "{habit.name}"?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete this habit and all its check-in history. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => deleteMutation.mutate()}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? "Deleting..." : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
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

      {editOpen && (
        <HabitEditDialog habit={habit} open={editOpen} onClose={() => setEditOpen(false)} />
      )}
    </>
  );
}

export default function HabitsPage() {
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: habits = [], isLoading } = useQuery<Habit[]>({
    queryKey: ["/api/habits"],
    queryFn: () => apiRequest("GET", "/api/habits").then((r) => r.json()),
  });

  const handleCreate = () => {
    if (!newName.trim()) {
      toast({ title: "Name required", description: "Enter a habit name", variant: "destructive" });
      return;
    }
    createMutation.mutate(newName.trim());
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/habits", { name, frequency: "daily" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      setNewName("");
      setShowCreate(false);
    },
    onError: () => toast({ title: "Failed to create habit", variant: "destructive" }),
  });

  // Summary stats
  const todayD = new Date();
  const today = `${todayD.getFullYear()}-${String(todayD.getMonth() + 1).padStart(2, "0")}-${String(todayD.getDate()).padStart(2, "0")}`;
  const completedToday = habits.filter((h) => h.checkins.some((c) => c.date === today)).length;
  const totalActive = habits.length;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button
                className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
                aria-label="Back to Dashboard"
                data-testid="button-back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-lg font-semibold">Habits</h1>
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
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
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
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />)}
        </div>
      ) : habits.length === 0 ? (
        <div className="text-center py-12">
          <Flame className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">No habits yet</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Start building positive routines by creating your first habit.
          </p>
          <Button size="sm" onClick={() => setShowCreate(true)} data-testid="button-create-habit-empty">
            <Plus className="h-3.5 w-3.5 mr-1" /> Create Your First Habit
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {habits.map((habit) => (
            <HabitCard key={habit.id} habit={habit} />
          ))}
        </div>
      )}
    </div>
  );
}
