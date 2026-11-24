// ── What the dashboard's AI summary is told, and held to ────────────────────
//
// The summary is a paragraph written by a model ABOUT the dashboard, shown on
// the dashboard. It may not disagree with the tiles beside it (Rule 1).
//
// 2026-11-24 (owner report): the summary said "no tasks, overdue items or
// events" while the same screen showed 7 tasks due, 1 late and an event today.
// The route counted `enhanced.tasks` / `enhanced.events` — keys the dashboard
// payload has never carried — so every count it handed the model was 0.
//
// Two rules here, both pure:
//   · `briefingFacts` counts with the SAME functions the tiles use
//     (`countTasksByDay` for Tasks Due / late; today's events as the Timeline
//     lists them), from lists the caller must supply — a missing list is a
//     thrown error, never a silent zero;
//   · `reconcileBriefing` refuses a paragraph that denies a non-zero count and
//     answers with the plain facts instead.
import { countTasksByDay, type CountableTask } from "./task-counts";

export interface BriefingFacts {
  /** Every open task — the "Tasks Due" tile. */
  openTasks: number;
  /** Open tasks whose due day has passed — the tile's "N late". */
  overdueTasks: number;
  dueToday: number;
  upcomingTasks: number;
  unscheduledTasks: number;
  completedToday: number;
  eventsToday: number;
  /** Titles of today's events, in the order given (at most 5). */
  eventTitlesToday: string[];
  billsDueThisWeek: number;
}

export interface BriefingInputs {
  tasks: readonly CountableTask[];
  todaysEvents: readonly { title?: string | null }[];
  /** Upcoming bills with `daysUntil` (the dashboard snapshot's `upcomingBills`). */
  upcomingBills: readonly { daysUntil?: number | null }[];
  todayISO: string;
  timezone?: string;
}

export function briefingFacts(input: BriefingInputs): BriefingFacts {
  // A list that did not load is not an empty list (Rule 7).
  if (!Array.isArray(input.tasks)) throw new Error("briefingFacts: tasks list is missing");
  if (!Array.isArray(input.todaysEvents)) throw new Error("briefingFacts: todaysEvents list is missing");
  if (!Array.isArray(input.upcomingBills)) throw new Error("briefingFacts: upcomingBills list is missing");
  const c = countTasksByDay(input.tasks, input.todayISO, input.timezone);
  return {
    openTasks: c.overdue + c.dueToday + c.upcoming + c.undated,
    overdueTasks: c.overdue,
    dueToday: c.dueToday,
    upcomingTasks: c.upcoming,
    unscheduledTasks: c.undated,
    completedToday: c.doneToday,
    eventsToday: input.todaysEvents.length,
    eventTitlesToday: input.todaysEvents.map((e) => String(e?.title ?? "").trim()).filter(Boolean).slice(0, 5),
    billsDueThisWeek: input.upcomingBills.filter((b) => typeof b?.daysUntil === "number" && b.daysUntil >= 0 && b.daysUntil <= 7).length,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The facts as a sentence or two — what is shown when the model's text cannot be used. */
export function factualBriefing(f: BriefingFacts): string {
  const parts: string[] = [];
  if (f.openTasks > 0) {
    const detail: string[] = [];
    if (f.overdueTasks > 0) detail.push(`${f.overdueTasks} late`);
    if (f.dueToday > 0) detail.push(`${f.dueToday} due today`);
    parts.push(`You have ${plural(f.openTasks, "open task")}${detail.length ? ` (${detail.join(", ")})` : ""}.`);
  } else {
    parts.push("You have no open tasks.");
  }
  if (f.eventsToday > 0) {
    const names = f.eventTitlesToday.length ? `: ${f.eventTitlesToday.join(", ")}` : "";
    parts.push(`${plural(f.eventsToday, "event")} today${names}.`);
  } else {
    parts.push("Nothing is on the calendar today.");
  }
  if (f.billsDueThisWeek > 0) parts.push(`${plural(f.billsDueThisWeek, "bill")} due in the next 7 days.`);
  if (f.overdueTasks > 0) parts.push("Start with the late task.");
  return parts.join(" ");
}

// A denial: "no", "zero", "nothing", "don't have any", "free of" … followed
// closely by the thing denied.
const NEG = String.raw`\b(?:no|zero|0|nothing|none|without|free of|clear of|(?:don'?t|do not|doesn'?t|does not) have any|aren'?t any|are not any|isn'?t any)\b`;
// Between the denial and its noun: same sentence, no number and no "but" —
// "No bills this week, but 7 tasks" denies bills, not tasks.
const near = (noun: string) => new RegExp(`${NEG}(?:(?!\\bbut\\b)[^.!?\\n\\d]){0,40}?\\b(?:${noun})\\b`, "i");
const DENIES_TASKS = near("tasks?|to-?dos?");
const DENIES_OVERDUE = near("overdue|late|past[- ]due");
const DENIES_EVENTS = near("events?|appointments?|meetings?");
const NOTHING_TODAY = /\bnothing (?:is )?(?:scheduled|planned|on (?:the|your) (?:calendar|schedule)|due)\b|\b(?:calendar|schedule|day) is (?:clear|empty|open|free)\b/i;

/** Which non-zero facts a paragraph denies (empty when it is consistent). */
export function briefingContradictions(text: string, f: BriefingFacts): string[] {
  const t = String(text || "");
  const out: string[] = [];
  if (f.openTasks > 0 && DENIES_TASKS.test(t)) out.push("tasks");
  if (f.overdueTasks > 0 && DENIES_OVERDUE.test(t)) out.push("overdue");
  if (f.eventsToday > 0 && (DENIES_EVENTS.test(t) || NOTHING_TODAY.test(t))) out.push("events");
  return out;
}

/**
 * The paragraph to show: the model's when it agrees with the counts, the plain
 * facts when it is empty or denies one of them.
 */
export function reconcileBriefing(text: string, f: BriefingFacts): { summary: string; replaced: boolean; contradictions: string[] } {
  const trimmed = String(text || "").trim();
  const contradictions = trimmed ? briefingContradictions(trimmed, f) : [];
  if (!trimmed || contradictions.length > 0) return { summary: factualBriefing(f), replaced: true, contradictions };
  return { summary: trimmed, replaced: false, contradictions };
}

/** A short stamp of the facts, for a cache key: a summary is reused only while they hold. */
export function briefingFingerprint(f: BriefingFacts): string {
  return [f.openTasks, f.overdueTasks, f.dueToday, f.upcomingTasks, f.unscheduledTasks, f.completedToday, f.eventsToday, f.billsDueThisWeek].join(".");
}
