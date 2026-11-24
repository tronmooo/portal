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
 *
 * A profile's birthday field and a document expiry have no per-occurrence
 * storage, so those actions are disabled rather than faked. A task has its
 * own (see `taskHasOccurrenceState`).
 */
const PER_OCCURRENCE_SYSTEMS = new Set<SourceSystem>(["event", "obligation", "liability"]);

/**
 * A task row that carries its own occurrence state.
 *
 * A repeating task records skips and one-occurrence moves in its tags
 * (shared/recurrence: rskip:/rmove:/rfrom:), and a one-time task simply IS its
 * one occurrence. The exception is a series INFERRED from several plain rows
 * (shared/series-detect): there is no rule to write a mark on, so those are
 * still managed on the task itself.
 */
function taskHasOccurrenceState(series: CalendarSeries): boolean {
  return series.source.system === "task" && !series.materializedFrom;
}

/** Where to manage a date whose system doesn't support an action. */
const MANAGE_AT: Record<SourceSystem, string> = {
  profile: "the profile",
  event: "the calendar",
  obligation: "its bill",
  liability: "its liability page",
  task: "the task",
  habit: "the habit",
  document: "the document",
  goal: "the goal",
  income: "your income in Finance",
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
  const perOccurrence = PER_OCCURRENCE_SYSTEMS.has(system) || taskHasOccurrenceState(series);
  const where = MANAGE_AT[system] || "its source";
  const isSingleton = series.kind === "birthday" || series.kind === "anniversary";

  const cap = (action: CalendarAction, enabled: boolean, reason?: string): ActionCapability =>
    enabled ? { action, enabled } : { action, enabled, reason };

  // An asset's lifecycle dates are worked out from the asset (shared/
  // asset-lifecycle.ts): the only action is opening it. Never a delete that
  // could reach the asset.
  if (series.id.startsWith("lifecycle:")) {
    return CALENDAR_ACTIONS.map((action) => action === "edit"
      ? cap("edit", true)
      : cap(action, false, "Worked out from the asset — it moves when the asset's value or details change."));
  }
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
        if (system === "income") {
          return cap(action, false, `Manage this on ${where}.`);
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
        if (system === "income") {
          return cap("deleteFuture", false, `Manage this on ${where}.`);
        }
        if (!recurring) {
          return cap("deleteFuture", false, "This date happens once — there are no future occurrences.");
        }
        if (isSingleton) {
          return cap("deleteFuture", false, `Clear the date on ${where} to stop this ${series.kind}.`);
        }
        return cap("deleteFuture", true);

      case "deleteSeries":
        // Income is READ-ONLY on the calendar. A paycheck is a finance record
        // and has no calendar endpoint; offering Delete here sent a request to
        // /api/events/<incomeId>, which 404s — the action appeared to work and
        // did nothing.
        if (system === "income") {
          return cap("deleteSeries", false, `Manage this on ${where}.`);
        }
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

// ─── Per-occurrence MONEY actions ────────────────────────────────────────────
//
// Kept separate from CALENDAR_ACTIONS on purpose. The seven above are about a
// date; these three are about the AMOUNT of one billing period, and they only
// mean anything for a liability whose amount genuinely moves.
//
// The distinction they encode is the product requirement itself: changing what
// ONE month costs must never be the same operation as changing the series.
// `setEstimate` and `addCharge` touch a single occurrence's forecast;
// `setActual` posts that occurrence as history. None of them can reach the
// definition, so no edit here can rewrite a month that already happened.

export const MONEY_ACTIONS = ["addCharge", "setEstimate", "setActual"] as const;
export type CalendarMoneyAction = (typeof MONEY_ACTIONS)[number];

export const MONEY_ACTION_LABELS: Record<CalendarMoneyAction, string> = {
  addCharge: "Add a usage charge",
  setEstimate: "Change the estimate",
  setActual: "Record the actual amount",
};

export interface MoneyActionCapability {
  action: CalendarMoneyAction;
  enabled: boolean;
  reason?: string;
}

/** Billing models whose occurrences carry their own, editable amount. */
const PER_OCCURRENCE_MONEY = new Set(["variable", "usage_based", "one_time"]);

/**
 * Which per-occurrence money edits are live for this series.
 *
 * Only a liability-backed series can carry per-occurrence money (that is where
 * the occurrence override map lives), and only a variable / usage-based /
 * one-time one has a per-period amount to edit. A fixed $86.50 phone bill and
 * an amortizing loan payment are defined by the series, so editing them
 * one month at a time would be a lie — those get a reason instead of a button.
 */
export function moneyCapabilitiesFor(series: CalendarSeries): MoneyActionCapability[] {
  const system = series.source.system;
  const model = String(series.billingModel ?? "");

  const cap = (action: CalendarMoneyAction, enabled: boolean, reason?: string): MoneyActionCapability =>
    enabled ? { action, enabled } : { action, enabled, reason };

  return MONEY_ACTIONS.map((action) => {
    if (system !== "liability") {
      return cap(action, false, "Per-period amounts are tracked on the liability that owns this bill.");
    }
    if (!PER_OCCURRENCE_MONEY.has(model)) {
      return cap(
        action, false,
        model === "installment"
          ? "This is a scheduled loan payment — change the payment on the loan itself."
          : "This bill is the same amount every cycle. Switch it to a variable or usage-based bill to track per-month amounts.",
      );
    }
    return cap(action, true);
  });
}

/** Convenience: is one money action live for this series? */
export function canEditMoney(series: CalendarSeries, action: CalendarMoneyAction): boolean {
  return moneyCapabilitiesFor(series).find((c) => c.action === action)?.enabled ?? false;
}

/** True when this series shows a per-period money block at all. */
export function hasPerOccurrenceMoney(series: CalendarSeries): boolean {
  return canEditMoney(series, "addCharge");
}


// ─── What ONE occurrence offers ──────────────────────────────────────────────
//
// The detail screen no longer prints all seven actions and greys out the ones
// that do not apply (a birthday showed five dead buttons whose reasons lived
// in a hover tooltip a phone never shows). It asks this instead: for THIS
// occurrence, in the state it is in, what can be done — and what does each
// choice touch. Anything not returned is simply not on the screen.

export type OccurrenceMenuAction =
  | "complete" | "skip" | "move" | "restore" | "editFuture" | "deleteOccurrence";

export interface OccurrenceMenuItem {
  action: OccurrenceMenuAction;
  label: string;
  /** One line saying how far the action reaches. Always present. */
  hint: string;
  destructive?: boolean;
}

/**
 * The actions for one occurrence, in the order they are shown.
 *
 * `isOpen` is true for the series' next occurrence that is neither done nor
 * skipped. It matters for a task: a repeating task stores ONE open row, so
 * only that occurrence can be completed — a later one can still be skipped or
 * moved ahead of time.
 */
export function occurrenceMenuFor(
  series: CalendarSeries,
  occurrence: { status: string; date: string; moved?: boolean },
  opts: { isOpen: boolean },
): OccurrenceMenuItem[] {
  const out: OccurrenceMenuItem[] = [];
  const recurring = !!series.recurrence && series.recurrence !== "none";
  const system = series.source.system;
  const settled = occurrence.status === "done" || occurrence.status === "skipped";

  if (settled) {
    // Only systems that can take a mark back offer it: an event clears its
    // tag, a task drops its skip. A paid bill is reversed on the bill itself.
    const canRestore =
      (system === "event" && can(series, "skip")) ||
      (system === "task" && occurrence.status === "skipped" && can(series, "skip"));
    if (canRestore) {
      out.push({
        action: "restore",
        label: occurrence.status === "done" ? "Mark not done" : "Bring back",
        hint: occurrence.status === "done" ? "Reopen just this date" : "Put this date back on the schedule",
      });
    }
    return out;
  }

  if (can(series, "complete") && (system !== "task" || opts.isOpen)) {
    out.push({
      action: "complete",
      label: system === "task" || series.kind === "habit" ? "Mark complete"
        : isPaymentKind(series.kind) ? "Mark paid" : "Check off",
      hint: recurring ? "Just this date — the next one stays scheduled" : "Mark this as done",
    });
  }
  if (can(series, "skip")) {
    out.push({ action: "skip", label: "Skip this occurrence", hint: "Keep future schedule" });
  }
  if (can(series, "move")) {
    out.push({
      action: "move",
      label: "Change date",
      hint: recurring ? "Move just this occurrence" : "Move to another day",
    });
  }
  if (recurring && (system === "event" || system === "task") && can(series, "deleteFuture")
    && series.kind !== "birthday" && series.kind !== "anniversary" && !series.materializedFrom) {
    out.push({
      action: "editFuture",
      label: "Edit future occurrences",
      hint: "Update the schedule from this date forward",
    });
  }
  if (can(series, "deleteOccurrence")) {
    out.push({
      action: "deleteOccurrence",
      label: recurring ? "Delete this occurrence" : "Delete",
      hint: recurring ? "Remove only this date" : "Remove this date",
      destructive: true,
    });
  }
  return out;
}

/**
 * Can this series be edited IN PLACE (name, schedule, reminders), or does
 * Edit open the record it comes from?
 *
 * A calendar event and a task own their schedule, so they are edited here. A
 * bill's schedule is the liability's, a birthday from a profile is the
 * profile's date of birth, a document expiry is the document's: those open
 * their source (Rule 1 — one source per value).
 */
export function editsInPlace(series: CalendarSeries): boolean {
  if (series.materializedFrom) return false;
  return series.source.system === "event" || series.source.system === "task";
}
