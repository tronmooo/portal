// client/src/lib/calendar-mutations.ts — one action, routed to its own system.
//
// The calendar's detail panel offers the same seven actions for every kind of
// date (see shared/calendar-capabilities). What each action MEANS depends on
// which system owns the record: checking off a recurring event writes an
// `rd:done:` tag, checking off a bill posts to its occurrence endpoint, and a
// birthday has no per-occurrence storage at all.
//
// This module is the only place that mapping lives. The panel calls
// `applyCalendarAction` and never knows which API it hit.
//
// Every action invalidates through the cache bus so the calendar grid, the
// recurring manager, the dashboard and the notification bell all refresh from
// the same write — the "changes should immediately update the main calendar
// without requiring a refresh" requirement.

import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains, type Domain } from "@/lib/cache-bus";
import {
  markOccurrence,
  pruneOccurrenceTags,
  setSeriesFlag,
} from "@shared/recurring-dates";
import { addDaysISO } from "@shared/date-math";
import { can, canEditMoney, type CalendarAction, type CalendarMoneyAction } from "@shared/calendar-capabilities";
import type { CalendarSeries, CalendarOccurrence } from "@shared/calendar-occurrences";

/** Domains a calendar write can ripple into. Kept wide on purpose: a bill is a
 *  liability AND an obligation AND a dashboard number. */
const CALENDAR_DOMAINS: Domain[] = [
  "events", "obligations", "liabilities", "profiles", "tasks",
  "notifications", "dashboard",
];

export async function refreshCalendarSurfaces(): Promise<void> {
  await invalidateDomains(...CALENDAR_DOMAINS);
}

export class UnsupportedCalendarAction extends Error {
  constructor(action: CalendarAction, series: CalendarSeries) {
    super(`"${action}" is not available for a ${series.kind} stored on ${series.source.system}.`);
    this.name = "UnsupportedCalendarAction";
  }
}

/** The raw event row backing an event-sourced series (needed for its tags). */
export interface EventRowLookup {
  (eventId: string): any | undefined;
}

export interface ApplyActionInput {
  action: CalendarAction;
  series: CalendarSeries;
  /** The occurrence acted on. Required for per-occurrence actions. */
  occurrence?: CalendarOccurrence;
  /** New date, for `move`. */
  newDate?: string;
  /** Caller's tz-local today, for tag pruning. */
  todayISO: string;
  /** Resolves the live event row so tag edits are applied to current tags. */
  getEventRow?: EventRowLookup;
}

/**
 * Perform a calendar action against whichever system owns the record.
 *
 * Throws `UnsupportedCalendarAction` when the capability matrix says no — the
 * panel disables those controls, so reaching here means a caller bypassed it.
 */
export async function applyCalendarAction(input: ApplyActionInput): Promise<void> {
  const { action, series, occurrence, newDate, todayISO } = input;
  if (!can(series, action)) throw new UnsupportedCalendarAction(action, series);

  const { system, id } = series.source;

  switch (action) {
    // ── Per-occurrence state ────────────────────────────────────────────────
    case "complete":
    case "skip":
    case "deleteOccurrence": {
      if (!occurrence) throw new Error(`"${action}" needs an occurrence.`);
      const date = occurrence.date;
      // Deleting ONE occurrence of a recurring series is a skip: the series
      // must survive. For a one-off date it really is a delete.
      const isOneOff = !series.recurrence || series.recurrence === "none";
      if (action === "deleteOccurrence" && isOneOff) {
        // The series, not just the id: without it the profile branch falls back
        // to "birthday", so deleting a one-off licence expiration wiped the
        // person's date of birth and left the expiration — the same bug the
        // deleteSeries path was changed to fix.
        await deleteSourceRecord(system, id, series);
        break;
      }
      const mode = action === "complete" ? "done" : "skip";

      if (system === "event") {
        const row = input.getEventRow?.(id);
        const tags = pruneOccurrenceTags(markOccurrence(row?.tags ?? [], date, mode), todayISO);
        await apiRequest("PATCH", `/api/events/${id}`, { tags });
      } else if (system === "obligation" || system === "liability") {
        // Both are addressed by the same `<recordId>:<date>` occurrence id.
        await apiRequest("POST", `/api/obligation-occurrences/${id}:${date}/status`, {
          status: mode === "done" ? "done" : "skipped",
        });
      } else {
        throw new UnsupportedCalendarAction(action, series);
      }
      break;
    }

    // ── Move one occurrence ─────────────────────────────────────────────────
    case "move": {
      if (!occurrence) throw new Error("Move needs an occurrence.");
      if (!newDate) throw new Error("Move needs a target date.");
      const date = occurrence.date;

      if (system === "event") {
        const row = input.getEventRow?.(id);
        if (!series.recurrence || series.recurrence === "none") {
          // A one-off event just changes its date.
          await apiRequest("PATCH", `/api/events/${id}`, { date: newDate });
          break;
        }
        // A recurring occurrence moves by skipping the scheduled slot and
        // creating a one-off on the new date. The series keeps its schedule —
        // the same semantics the recurring manager already used.
        const tags = pruneOccurrenceTags(markOccurrence(row?.tags ?? [], date, "skip"), todayISO);
        await apiRequest("PATCH", `/api/events/${id}`, { tags });
        await apiRequest("POST", "/api/events", {
          title: series.title,
          date: newDate,
          allDay: true,
          category: row?.category ?? "personal",
          recurrence: "none",
          description: row?.description || undefined,
          linkedProfiles: row?.linkedProfiles || (series.source.profileId ? [series.source.profileId] : []),
          source: "manual",
        });
      } else if (system === "obligation" || system === "liability") {
        await apiRequest("POST", `/api/obligation-occurrences/${id}:${date}/reschedule`, {
          newDueAt: newDate,
        });
      } else {
        throw new UnsupportedCalendarAction(action, series);
      }
      break;
    }

    // ── End the series from a date forward ──────────────────────────────────
    case "deleteFuture": {
      if (!occurrence) throw new Error("Delete-future needs an occurrence.");
      // The series ends the day BEFORE the occurrence acted on, so that
      // occurrence and everything after it disappear while history survives.
      const end = addDaysISO(occurrence.date, -1);
      if (system === "event") {
        await apiRequest("PATCH", `/api/events/${id}`, { recurrenceEnd: end });
      } else if (system === "obligation") {
        await apiRequest("PATCH", `/api/obligations/${id}`, { recurrenceEnd: end });
      } else if (system === "liability") {
        await apiRequest("PATCH", `/api/profiles/${id}`, { fields: { recurrenceEnd: end } });
      } else if (system === "task") {
        await apiRequest("PATCH", `/api/tasks/${id}`, { tags: ["rpaused"] });
      } else {
        throw new UnsupportedCalendarAction(action, series);
      }
      break;
    }

    // ── Delete the whole series ─────────────────────────────────────────────
    case "deleteSeries": {
      await deleteSourceRecord(system, id, series);
      break;
    }

    case "edit":
      // Editing is navigation, not a mutation — the panel routes to
      // `series.source.href`. Nothing to do here.
      return;

    default:
      throw new UnsupportedCalendarAction(action, series);
  }

  await refreshCalendarSurfaces();
}

// ─── Per-occurrence money ────────────────────────────────────────────────────

export interface ApplyMoneyActionInput {
  action: CalendarMoneyAction;
  series: CalendarSeries;
  occurrence: CalendarOccurrence;
  /** Dollars. For `addCharge` a discount may be negative. */
  amount: number;
  /** `addCharge` only: usage | credits | fee | tax | discount | adjustment. */
  chargeKind?: string;
  /** `addCharge` only: what the charge was for. */
  label?: string;
}

/**
 * Change what ONE billing period costs.
 *
 * Every route here is addressed by `<liabilityId>/occurrences/<canonical date>`,
 * so the write cannot reach the definition or any other period — August's
 * usage charge lands on August and nowhere else. That containment is the
 * point, not an implementation detail.
 */
export async function applyCalendarMoneyAction(input: ApplyMoneyActionInput): Promise<void> {
  const { action, series, occurrence, amount } = input;
  if (!canEditMoney(series, action)) throw new UnsupportedCalendarAction(action as any, series);

  const base = `/api/liabilities/${series.source.id}/occurrences/${occurrence.date}`;
  switch (action) {
    case "addCharge":
      await apiRequest("POST", `${base}/charges`, {
        amount, kind: input.chargeKind || "usage", label: input.label,
      });
      break;
    case "setEstimate":
      await apiRequest("PATCH", base, { estimatedAmount: amount });
      break;
    case "setActual":
      await apiRequest("PATCH", base, { actualAmount: amount });
      break;
    default:
      throw new UnsupportedCalendarAction(action as any, series);
  }
  await refreshCalendarSurfaces();
}

/**
 * Remove the record a series comes from.
 *
 * A birthday has no record of its own — it is a FIELD on a profile — so
 * "delete series" clears that field rather than deleting the person.
 */
async function deleteSourceRecord(
  system: CalendarSeries["source"]["system"],
  id: string,
  series?: CalendarSeries,
): Promise<void> {
  switch (system) {
    case "event":
      await apiRequest("DELETE", `/api/events/${id}`);
      return;
    case "obligation":
      await apiRequest("DELETE", `/api/obligations/${id}`);
      return;
    case "task":
      await apiRequest("DELETE", `/api/tasks/${id}`);
      return;
    case "profile": {
      // Clear THE date field, never the profile. Deleting Joe because you
      // wanted his birthday off the calendar would be catastrophic.
      //
      // And clear the RIGHT one. A profile-sourced series used to be a birthday
      // or an anniversary and nothing else; it can now be any date a person
      // carries — a licence, a passport, a warranty. Guessing "birthday" for
      // all of them wiped the person's date of birth and left the expiration
      // exactly where it was.
      //
      // Deletion goes through `fieldsToDelete` (shared/profile-field-identity).
      // A dotted path targets EXACTLY that field in that group; a bare key is
      // the app's universal identity sweep. Sending the leaf name for a nested
      // date would have swept every same-named date in every other group, and
      // sending a `fields` patch for the group would have REPLACED the group,
      // taking every sibling with it.
      const field = series?.source?.field
        || (series?.kind === "anniversary" ? "anniversary" : "birthday");
      await apiRequest("PATCH", `/api/profiles/${id}`, { fieldsToDelete: [field] });
      return;
    }
    case "document": {
      // Clear the date, not the document. The document is the file; its
      // expiration is one field of what was read out of it, and removing that
      // date from the calendar must not destroy the record it came from.
      const field = series?.source?.field;
      if (!field) throw new Error("This date has no field to clear.");
      const doc = await apiRequest("GET", `/api/documents/${id}`).then((r) => r.json());
      const extractedData = { ...(doc?.extractedData || {}) };
      const path = field.split(".").filter(Boolean);
      let cursor: any = extractedData;
      for (let i = 0; i < path.length - 1; i++) {
        const next = cursor?.[path[i]];
        if (!next || typeof next !== "object") { cursor = null; break; }
        cursor[path[i]] = { ...next };
        cursor = cursor[path[i]];
      }
      if (cursor) delete cursor[path[path.length - 1]];
      await apiRequest("PATCH", `/api/documents/${id}`, { extractedData });
      return;
    }
    case "liability":
      // A liability's payment series is stopped, not the liability deleted.
      await apiRequest("PATCH", `/api/profiles/${id}`, { fields: { paused: true } });
      return;
    default:
      throw new Error(`Don't know how to delete a ${system} record.`);
  }
}
