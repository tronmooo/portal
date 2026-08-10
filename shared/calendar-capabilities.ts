// shared/calendar-capabilities.ts — what can be done to an occurrence, and how.
//
// The calendar presents ONE detail panel with ONE action list for every kind of
// date. But the systems behind those dates are not equally capable: a calendar
// event stores per-occurrence state in its tags, an obligation has real
// occurrence rows, and a birthday is a single date field on a profile with
// nowhere to record "skip the 2029 one".
//
// Pretending otherwise would mean buttons that silently do nothing. Instead the
// panel always renders the same actions in the same order, and this module says
// which are live, which are disabled, and — when disabled — where the user
// should go instead. Same design and interaction model everywhere, no lies.
//
// Pure, dependency-free. Pinned by tests/calendar-capabilities.test.ts.

import { isPaymentKind, type CalendarSeries, type OccurrenceKind, type SourceSystem } from "./calendar-occurrences";

/** Every action the standardized detail panel offers, in render order. */
export const CALENDAR_ACTIONS = [
  "edit",
  "move",
  "complete",
  "skip",
  "deleteOccurrence",
  "deleteFuture",
  "deleteSeries",
] as const;
export type CalendarAction = (typeof CALENDAR_ACTIONS)[number];

export const ACTION_LABELS: Record<CalendarAction, string> = {
  edit: "Edit",
  move: "Move date",
  complete: "Check off",
  skip: "Skip this occurrence",
  deleteOccurrence: "Delete this occurrence",
  deleteFuture: "Delete future occurrences",
  deleteSeries: "Delete entire series",
};

/**
 * What the primary action is CALLED for this kind of date.
 *
 * User report: "'Done' does not make sense for every category… One universal
 * Done button is causing category behavior to blur together." A bill is paid,
 * a task is completed, and a birthday is neither — it simply arrives.
 */
export function actionLabelFor(action: CalendarAction, kind: OccurrenceKind): string {
  if (action === "complete") {
    if (isPaymentKind(kind)) return "Mark paid";
    if (kind === "task" || kind === "habit") return "Complete";
    return ACTION_LABELS.complete;
  }
  if (action === "edit") {
    if (kind === "birthday" || kind === "anniversary") return "Edit date";
    if (isPaymentKind(kind)) return "Edit schedule";
    return ACTION_LABELS.edit;
  }
  if (action === "deleteSeries") {
    if (kind === "birthday" || kind === "anniversary") return "Remove from calendar";
    return ACTION_LABELS.deleteSeries;
  }
  if (action === "move" && kind === "task") return "Reschedule";
  return ACTION_LABELS[action];
}

/**
 * Is there a meaningful per-occurrence "primary" action for this kind — i.e.
 * should a row show a quick-action button at all?
 *
 * Birthdays and anniversaries get none: "Do not place a giant Done button on
 * birthdays." They are not tasks to complete, and there is nothing to pay.
 */
export function hasPrimaryAction(series: CalendarSeries): boolean {
  if (series.kind === "birthday" || series.kind === "anniversary") return false;
  return can(series, "complete");
}

export interface ActionCapability {
  action: CalendarAction;
  enabled: boolean;
  /** Shown when disabled — always says where the user CAN do this instead. */
  reason?: string;
}

/**
 * Systems that can record state against an individual occurrence.
 *
 *   event      — rd:done:/rd:skip: tags on the event row
 *   obligation — real occurrence rows (/api/obligation-occurrences)
 *   liability  — an occurrences map on the liability profile
 *   income     — an occurrences map on the income row (the same shape)
 *
 * A profile's birthday field, a task and a document expiry have
 * no per-occurrence storage, so those actions are disabled rather than faked.
 */
const PER_OCCURRENCE_SYSTEMS = new Set<SourceSystem>(["event", "obligation", "liability", "income"]);

/** Where to manage a date whose system doesn't support an action. */
const MANAGE_AT: Record<SourceSystem, string> = {
  profile: "the profile",
  event: "the calendar",
  obligation: "its bill",
  liability: "its liability page",
  income: "the Finance tab",
  task: "the task",
  habit: "the habit",
  document: "the document",
  goal: "the goal",
};

/**
 * The action list for one series — always all seven, in the same order, with
 * `enabled` set per source system.
 *
 * Rules:
 *   • A non-recurring date has no "series" to end, so deleteFuture and
 *     deleteSeries collapse into deleteOccurrence.
 *   • Per-occurrence actions need per-occurrence storage.
 *   • Birthdays and anniversaries are edited on the profile — a birthday
 *     cannot be "skipped", the person still has one.
 *   • Everything can be edited and deleted at its source.
 */
export function capabilitiesFor(series: CalendarSeries): ActionCapability[] {
  const system = series.source.system;
  const recurring = !!series.recurrence && series.recurrence !== "none";
  const perOccurrence = PER_OCCURRENCE_SYSTEMS.has(system);
  const where = MANAGE_AT[system] || "its source";
  const isSingleton = series.kind === "birthday" || series.kind === "anniversary";

  const cap = (action: CalendarAction, enabled: boolean, reason?: string): ActionCapability =>
    enabled ? { action, enabled } : { action, enabled, reason };

  return CALENDAR_ACTIONS.map((action) => {
    switch (action) {
      case "edit":
        // Always available: it opens the source record.
        return cap("edit", true);

      case "move":
        if (isSingleton) {
          return cap("move", false, `A ${series.kind} follows the date on ${where} — change it there.`);
        }
        if (!perOccurrence) {
          return cap("move", false, `Reschedule this on ${where}.`);
        }
        return cap("move", true);

      case "complete":
        if (isSingleton) {
          return cap("complete", false, `A ${series.kind} recurs every year — there is nothing to check off.`);
        }
        if (!perOccurrence) return cap("complete", false, `Mark this done on ${where}.`);
        return cap("complete", true);

      case "skip":
      case "deleteOccurrence":
        if (isSingleton) {
          return cap(action, false, `A ${series.kind} comes from ${where} — remove the date there to stop it.`);
        }
        if (!recurring) {
          return action === "deleteOccurrence"
            ? cap("deleteOccurrence", true)
            : cap("skip", false, "This date happens once — delete it instead.");
        }
        if (!perOccurrence) {
          return cap(action, false, `Individual occurrences are managed on ${where}.`);
        }
        return cap(action, true);

      case "deleteFuture":
        if (!recurring) {
          return cap("deleteFuture", false, "This date happens once — there are no future occurrences.");
        }
        if (isSingleton) {
          return cap("deleteFuture", false, `Clear the date on ${where} to stop this ${series.kind}.`);
        }
        return cap("deleteFuture", true);

      case "deleteSeries":
        return cap("deleteSeries", true);

      default:
        return cap(action, false);
    }
  });
}

/** Convenience: is one action live for this series? */
export function can(series: CalendarSeries, action: CalendarAction): boolean {
  return capabilitiesFor(series).find((c) => c.action === action)?.enabled ?? false;
}

/** The explanation for a disabled action, or undefined when it's enabled. */
export function reasonFor(series: CalendarSeries, action: CalendarAction): string | undefined {
  const c = capabilitiesFor(series).find((x) => x.action === action);
  return c && !c.enabled ? c.reason : undefined;
}
