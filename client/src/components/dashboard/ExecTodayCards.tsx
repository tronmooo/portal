// ── Executive tab: the Tasks and Habits card bodies ──────────────────────────
// Redesigned 2026-11-21 (owner request): "clearly distinguish between
// upcoming, due today, and completed tasks", "make it easy to see daily
// habits, completion status, progress, and remaining activities".
//
// Both are presentational: ExecutiveBriefing owns the queries and the
// mutations (the same ones the Tasks/Habits popups, chat and the pages write
// through), so a tap here updates every other surface through the cache bus.
// Nothing in this file fetches or writes on its own.
import { useState, type ReactNode } from "react";
import {
  Check, ChevronDown, ChevronRight, Flame, Pencil, Plus, RotateCcw, type LucideIcon,
} from "lucide-react";
import { ProgressRing } from "@/components/dashboard/visuals";
import { habitDayProgress } from "@shared/habit-progress";
import { isHabitDoneOn } from "@shared/habit-schedule";

// ── Shared bits ──────────────────────────────────────────────────────────────

const RED = "0 72% 56%";
const AMBER = "38 96% 50%";
const BLUE = "213 90% 60%";
const GREEN = "155 65% 42%";

function StatChip({ n, label, hs, testId, onClick }: {
  n: number; label: string; hs: string; testId: string; onClick?: () => void;
}) {
  const live = n > 0;
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className="flex-1 min-w-0 rounded-xl px-2 py-1.5 text-left transition-colors"
      style={{ background: live ? `hsl(${hs} / 0.12)` : "hsl(var(--muted) / 0.5)" }}>
      <span className="block text-[17px] font-extrabold tabular-nums leading-none"
        style={{ color: live ? `hsl(${hs})` : "hsl(var(--muted-foreground))" }}>{n}</span>
      <span className="block micro-label text-muted-foreground truncate mt-1">{label}</span>
    </button>
  );
}

function GroupLabel({ hs, children, count }: { hs: string; children: ReactNode; count: number }) {
  return (
    <p className="micro-label flex items-center gap-1.5 mb-1" style={{ color: `hsl(${hs})` }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${hs})` }} aria-hidden="true" />
      {children}
      <span className="text-muted-foreground font-medium">· {count}</span>
    </p>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export interface ExecTask {
  id: string; title: string; dueDate?: string | null; priority?: string | null; status?: string | null;
}

/** Rows listed on the card before the rest fold into "N more". */
export const TASK_CARD_LIMIT = 6;

export function TasksCardBody({
  overdue, dueToday, upcoming, doneToday, daysFromToday, formatDue,
  busyKeys, leavingKeys, onComplete, onReopen, onOpenTask, onOpenAll, onAdd, adding, emptyState,
}: {
  /** Open tasks past their due date, oldest first. */
  overdue: ExecTask[];
  /** Open tasks due today. */
  dueToday: ExecTask[];
  /** Open tasks due later, soonest first, then the undated ones. */
  upcoming: ExecTask[];
  /** Tasks completed today. */
  doneToday: ExecTask[];
  daysFromToday: (d: any) => number | null;
  /** "Fri, Nov 27" for a day offset. */
  formatDue: (daysUntil: number) => string;
  busyKeys: Set<string>;
  leavingKeys: Set<string>;
  onComplete: (t: ExecTask) => void;
  onReopen: (t: ExecTask) => void;
  /** Opens the task in the Tasks panel, expanded for editing. */
  onOpenTask: (t: ExecTask, tab: "today" | "upcoming") => void;
  onOpenAll: (tab: "today" | "upcoming") => void;
  /** Creates a task from one line of text. */
  onAdd: (title: string) => void;
  adding: boolean;
  /** Rendered when there is nothing open and nothing done today. */
  emptyState: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const submit = () => {
    const title = draft.trim();
    if (!title || adding) return;
    onAdd(title);
    setDraft("");
  };

  const openCount = overdue.length + dueToday.length + upcoming.length;
  let room = TASK_CARD_LIMIT;
  const take = (rows: ExecTask[]) => { const out = rows.slice(0, Math.max(0, room)); room -= out.length; return out; };
  const groups = [
    { key: "overdue", label: "Overdue", hs: RED, total: overdue.length, rows: take(overdue), tab: "today" as const },
    { key: "today", label: "Due today", hs: AMBER, total: dueToday.length, rows: take(dueToday), tab: "today" as const },
    { key: "upcoming", label: "Upcoming", hs: BLUE, total: upcoming.length, rows: take(upcoming), tab: "upcoming" as const },
  ].filter((g) => g.rows.length > 0);
  const hidden = openCount - groups.reduce((n, g) => n + g.rows.length, 0);

  const sub = (t: ExecTask, key: string): { text: string; late: boolean } => {
    const du = daysFromToday(t.dueDate);
    if (du == null) return { text: "No due date", late: false };
    if (du < 0) return { text: `Was due ${formatDue(du)} · ${Math.abs(du)}d late`, late: true };
    if (du === 0) return { text: "Due today", late: false };
    return { text: `Due ${formatDue(du)}${du === 1 ? " · tomorrow" : key === "upcoming" && du <= 7 ? ` · in ${du}d` : ""}`, late: false };
  };

  return (
    <div className="flex-1 flex flex-col" data-testid="exec-tasks-body">
      <div className="flex gap-1.5 mb-2.5">
        <StatChip n={overdue.length} label="Overdue" hs={RED} testId="exec-tasks-stat-overdue" onClick={() => onOpenAll("today")} />
        <StatChip n={dueToday.length} label="Due today" hs={AMBER} testId="exec-tasks-stat-today" onClick={() => onOpenAll("today")} />
        <StatChip n={upcoming.length} label="Upcoming" hs={BLUE} testId="exec-tasks-stat-upcoming" onClick={() => onOpenAll("upcoming")} />
        <StatChip n={doneToday.length} label="Done" hs={GREEN} testId="exec-tasks-stat-done" onClick={() => setShowDone((v) => !v)} />
      </div>

      {/* Quick add — one line, Enter to save. A date in the sentence
          ("…by Friday") is read the same way the Tasks panel reads it. */}
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/60 pl-2.5 pr-1 h-9 mb-2.5 focus-within:border-primary/60 transition-colors">
        <Plus className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…" aria-label="Add a task"
          className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
          data-testid="exec-task-add-input" enterKeyHint="done"
        />
        {draft.trim() && (
          <button type="submit" disabled={adding}
            className="h-7 rounded-lg px-2.5 text-[12px] font-semibold bg-primary text-primary-foreground disabled:opacity-60"
            data-testid="exec-task-add-submit">{adding ? "…" : "Add"}</button>
        )}
      </form>

      {openCount === 0 && doneToday.length === 0 ? emptyState : (
        <div className="space-y-2.5">
          {openCount === 0 && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground" data-testid="exec-tasks-all-done">
              <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" /> Everything done — nice work.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.key} data-testid={`exec-tasks-group-${g.key}`}>
              <GroupLabel hs={g.hs} count={g.total}>{g.label}</GroupLabel>
              <div className="space-y-1">
                {g.rows.map((t) => {
                  const key = `task:${t.id}`;
                  const busy = busyKeys.has(key);
                  const s = sub(t, g.key);
                  const high = t.priority === "high" || t.priority === "critical";
                  return (
                    <div key={t.id}
                      className={`bubble-row group flex items-center gap-2 pl-1.5 pr-1 py-1.5 ${leavingKeys.has(key) ? "row-leaving" : ""}`}
                      data-testid={`exec-task-row-${t.id}`}>
                      <button type="button" onClick={() => onComplete(t)} disabled={busy}
                        className="h-8 w-8 shrink-0 flex items-center justify-center rounded-full"
                        aria-label={`Complete ${t.title}`} data-testid={`exec-task-complete-${t.id}`}>
                        <span className={`h-[18px] w-[18px] rounded-full border-2 flex items-center justify-center transition-colors ${busy ? "animate-pulse border-emerald-500 bg-emerald-500/20" : "border-muted-foreground/45 group-hover:border-emerald-500"}`}
                          style={!busy ? { borderColor: g.key === "overdue" ? `hsl(${RED} / 0.7)` : undefined } : undefined} />
                      </button>
                      <button type="button" onClick={() => onOpenTask(t, g.tab)}
                        className="flex-1 min-w-0 text-left" data-testid={`exec-task-open-${t.id}`}>
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[13px] font-semibold leading-tight truncate">{t.title}</span>
                          {high && <span className="shrink-0 rounded-full px-1.5 py-px micro-label bg-red-500/12 text-red-600 dark:text-red-400">High</span>}
                        </span>
                        <span className={`block text-[11px] truncate mt-0.5 ${s.late ? "text-red-500" : "text-muted-foreground"}`}>{s.text}</span>
                      </button>
                      <button type="button" onClick={() => onOpenTask(t, g.tab)}
                        className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
                        aria-label={`Edit ${t.title}`} data-testid={`exec-task-edit-${t.id}`}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => onOpenAll("today")}
              className="w-full flex items-center gap-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
              data-testid="exec-tasks-more">
              {hidden} more open task{hidden === 1 ? "" : "s"} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}

          {doneToday.length > 0 && (
            <div data-testid="exec-tasks-group-done">
              <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}
                className="micro-label flex items-center gap-1.5 w-full text-left" style={{ color: `hsl(${GREEN})` }}
                data-testid="exec-tasks-done-toggle">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${GREEN})` }} aria-hidden="true" />
                Completed today <span className="text-muted-foreground font-medium">· {doneToday.length}</span>
                <ChevronDown className={`h-3 w-3 ml-auto text-muted-foreground transition-transform ${showDone ? "rotate-180" : ""}`} aria-hidden="true" />
              </button>
              {showDone && (
                <div className="space-y-1 mt-1">
                  {doneToday.map((t) => (
                    <div key={t.id} className="bubble-row flex items-center gap-2 pl-1.5 pr-1 py-1.5" data-testid={`exec-task-done-${t.id}`}>
                      <span className="h-8 w-8 shrink-0 flex items-center justify-center" aria-hidden="true">
                        <span className="h-[18px] w-[18px] rounded-full flex items-center justify-center text-white" style={{ background: `hsl(${GREEN})` }}>
                          <Check className="h-3 w-3" strokeWidth={3} />
                        </span>
                      </span>
                      <span className="flex-1 min-w-0 text-[13px] text-muted-foreground line-through truncate">{t.title}</span>
                      <button type="button" onClick={() => onReopen(t)} disabled={busyKeys.has(`task:${t.id}`)}
                        className="h-8 shrink-0 inline-flex items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        aria-label={`Reopen ${t.title}`} data-testid={`exec-task-reopen-${t.id}`}>
                        <RotateCcw className="h-3 w-3" aria-hidden="true" /> Undo
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Habits ───────────────────────────────────────────────────────────────────

/** Habits listed on the card before the rest fold into a "N more" link. */
export const HABIT_CARD_LIMIT = 6;

const SLOT_LABEL: Record<string, string> = {
  morning: "Morning", afternoon: "Afternoon", evening: "Evening", bedtime: "Bedtime",
};

export function HabitsCardBody({
  habitsDueToday, doneCount, notScheduled, bestStreak, todayStr, accent,
  busyKeys, iconFor, onCheckIn, onOpenAll, emptyState,
}: {
  /** Habits scheduled today, in a stable order (never sorted by completion). */
  habitsDueToday: any[];
  /** Habits complete today — from the shared day rollup. */
  doneCount: number;
  /** Habits the person has that are not scheduled today. */
  notScheduled: number;
  bestStreak: number;
  todayStr: string;
  accent: string;
  busyKeys: Set<string>;
  iconFor: (name: string) => LucideIcon;
  onCheckIn: (habit: any) => void;
  onOpenAll: () => void;
  /** Rendered when nothing is scheduled today. */
  emptyState: ReactNode;
}) {
  const total = habitsDueToday.length;
  if (total === 0) return <>{emptyState}</>;
  const left = Math.max(0, total - doneCount);
  const pct = Math.round((doneCount / total) * 100);
  const allDone = left === 0;

  return (
    <div className="flex-1 flex flex-col" data-testid="exec-habits-body">
      {/* Summary: how today stands, at a glance. */}
      <div className="flex items-center gap-3 mb-3">
        <ProgressRing value={doneCount} total={total} accent={allDone ? GREEN : accent} size={60} stroke={6} label={`${pct}%`} />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold leading-tight" data-testid="exec-habits-summary">
            {doneCount} of {total} done today
          </p>
          <p className="text-[12px] mt-0.5" data-testid="exec-habits-remaining"
            style={{ color: allDone ? `hsl(${GREEN})` : undefined }}>
            {allDone
              ? "All done for today"
              : <span className="text-muted-foreground"><span className="font-semibold text-foreground">{left}</span> left to do</span>}
          </p>
          <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden" role="progressbar"
            aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount} aria-label="Habits completed today">
            <div className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${pct}%`, background: `hsl(${allDone ? GREEN : accent})` }} />
          </div>
        </div>
        {bestStreak > 0 && (
          <div className="shrink-0 rounded-xl px-2 py-1.5 text-center" style={{ background: `hsl(${accent} / 0.12)` }}
            data-testid="exec-habits-streak" title="Best current streak">
            <span className="flex items-center justify-center gap-0.5 text-[15px] font-extrabold tabular-nums leading-none" style={{ color: `hsl(${accent})` }}>
              <Flame className="h-3.5 w-3.5" aria-hidden="true" />{bestStreak}
            </span>
            <span className="block micro-label text-muted-foreground mt-1">day streak</span>
          </div>
        )}
      </div>

      <div className="space-y-1">
        {habitsDueToday.slice(0, HABIT_CARD_LIMIT).map((h: any) => {
          const hp = habitDayProgress(h, todayStr);
          const done = isHabitDoneOn(h, todayStr);
          const busy = busyKeys.has(`habit:${h.id}`);
          const multi = hp.required > 1;
          const HIcon = iconFor(String(h.name || ""));
          const streak = Number(h.currentStreak ?? 0);
          const slot = SLOT_LABEL[String(h.timeOfDay || "")];
          const detail = [
            multi ? `${hp.completed} of ${hp.required} today` : done ? "Done today" : slot || "Today",
            streak > 1 ? `${streak}-day streak` : null,
          ].filter(Boolean).join(" · ");
          return (
            <div key={h.id} className="bubble-row flex items-center gap-2.5 pl-2 pr-1.5 py-1.5" data-testid={`exec-habit-row-${h.id}`}>
              <span className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: `hsl(${accent} / ${done ? 0.08 : 0.15})`, color: `hsl(${accent})`, opacity: done ? 0.7 : 1 }} aria-hidden="true">
                <HIcon className="h-3.5 w-3.5" strokeWidth={2.1} />
              </span>
              <button type="button" onClick={onOpenAll} className="flex-1 min-w-0 text-left" data-testid={`exec-habit-open-${h.id}`}>
                <span className={`block text-[13px] font-semibold leading-tight truncate ${done ? "text-muted-foreground" : ""}`}>{h.name}</span>
                <span className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[11px] text-muted-foreground truncate">{detail}</span>
                  {multi && (
                    <span className="flex gap-0.5 shrink-0" aria-hidden="true">
                      {Array.from({ length: Math.min(hp.required, 8) }).map((_, i) => (
                        <span key={i} className="h-1.5 w-3 rounded-full"
                          style={{ background: i < hp.completed ? `hsl(${accent})` : "hsl(var(--muted))" }} />
                      ))}
                    </span>
                  )}
                </span>
              </button>
              {/* The one control: tap to check in. A finished habit shows the
                  tick and opens the Habits panel (where a check-in is undone). */}
              <button type="button" disabled={busy}
                onClick={() => (done ? onOpenAll() : onCheckIn(h))}
                className={`h-9 shrink-0 inline-flex items-center justify-center gap-1 rounded-full text-[12px] font-bold transition-all active:scale-95 disabled:opacity-60 ${done ? "w-9 text-white" : "px-3 border-2"}`}
                style={done
                  ? { background: `hsl(${GREEN})` }
                  : { borderColor: `hsl(${accent} / 0.55)`, color: `hsl(${accent})` }}
                data-testid={`exec-habit-checkin-${h.id}`}
                aria-label={done ? `${h.name} — done today` : `Check in ${h.name}`}
                aria-pressed={done}>
                {done
                  ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" />
                  : busy ? "…" : multi ? <><Plus className="h-3.5 w-3.5" aria-hidden="true" />1</> : "Check in"}
              </button>
            </div>
          );
        })}
      </div>

      {(total > HABIT_CARD_LIMIT || notScheduled > 0) && (
        <button type="button" onClick={onOpenAll}
          className="w-full flex items-center gap-1 pt-2 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
          data-testid="exec-habits-more">
          {[
            total > HABIT_CARD_LIMIT ? `${total - HABIT_CARD_LIMIT} more habit${total - HABIT_CARD_LIMIT === 1 ? "" : "s"} today` : null,
            notScheduled > 0 ? `${notScheduled} not scheduled today` : null,
          ].filter(Boolean).join(" · ")}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
