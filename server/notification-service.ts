// ── Notification building, extracted from GET /api/notifications ────────────
// One shared implementation so both the REST route and the AI chat's
// dismiss_notifications tool see the SAME list with the SAME deterministic ids
// (doc-exp-<id>-<key>, task-overdue-<id>, bill-soon-<id>, reminder-<id>, …).
// Dismissal works by id: the bell UI and the AI tool both merge ids into the
// `dismissed_notifications` preference (a JSON array of id strings) and the
// client filters by set membership. Caching and the profile filter stay in the
// route — this module is pure "compute the list".
import type { IStorage } from "./storage";
import { getUserToday, parseLocalDate } from "@shared/timezone";
import { parseRecurringMeta, nextOccurrence, missedOccurrences, kindDef } from "@shared/recurring-dates";
import { isHabitDueOn, isHabitDoneOn } from "@shared/habit-schedule";
import { habitDayProgress } from "@shared/habit-progress";
import { rulesFromAll, daysBetweenISO, isAlertDateRule, dateRuleAlertWords } from "@shared/date-rules";
import { isActiveObligation } from "@shared/obligation-windows";

export interface AppNotification {
  id: string;
  type: "document_expiring" | "task_overdue" | "task_due_today" | "bill_due" | "habit_at_risk" | "streak_milestone" | "reminder" | "custom";
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  entityId?: string;
  entityType?: string;
  dueDate?: string;
  dismissed?: boolean;
  /** Custom rows only: whether mark_notifications_read has stamped it. */
  read?: boolean;
}

/** Preference key holding the dismissed-notification ids (JSON string array). */
export const DISMISSED_NOTIFICATIONS_PREF = "dismissed_notifications";

/** Preference key holding notification filters: {muted_severities?, muted_types?}. */
export const NOTIFICATION_PREFS_PREF = "notification_prefs";

export interface NotificationPrefs {
  muted_severities?: string[];
  muted_types?: string[];
}

export async function readNotificationPrefs(storage: IStorage): Promise<NotificationPrefs> {
  try {
    const raw = await storage.getPreference(NOTIFICATION_PREFS_PREF);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Helper: try to parse various date formats into a Date object
function parseDate(val: string): Date | null {
  if (!val || typeof val !== "string") return null;
  const trimmed = val.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }
  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const d = new Date(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  // MM-DD-YYYY
  const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dashMatch) {
    const d = new Date(Number(dashMatch[3]), Number(dashMatch[1]) - 1, Number(dashMatch[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  // Try native parsing as last resort
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

function daysDiff(dateA: Date, dateB: Date): number {
  const a = new Date(dateA); a.setHours(0, 0, 0, 0);
  const b = new Date(dateB); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/**
 * Compute the current notification list (deduped, severity-sorted) for the
 * user the storage instance is scoped to. `notifTz` drives "today".
 */
export async function buildNotifications(storage: IStorage, notifTz: string): Promise<AppNotification[]> {
  const notifications: AppNotification[] = [];
  // "Today" in the USER's zone (notifTz), not the server clock: at 5 PM
  // Pacific the server's UTC day had already rolled, so a task due today read
  // "was due 1 day ago" and tomorrow's bill read "due today".
  const todayStr = getUserToday(notifTz);
  const today = parseLocalDate(todayStr);
  today.setHours(0, 0, 0, 0);

  // PERF (2026-05-31): fetch every list this endpoint needs in parallel.
  const [documents, profiles, tasks, obligations, habits] = await Promise.all([
    storage.getDocuments(),
    storage.getProfiles(),
    storage.getTasks(),
    storage.getObligations(),
    storage.getHabits(),
  ]);

  // --- Dates that run out: documents AND profiles, from the ONE Date Rule engine ---
  //
  // This block used to carry its own list of ten expiry key spellings and read
  // documents' `extractedData` and profiles' `fields` against it. Every
  // insurance definition in the app names its only date `renewal_date`, a
  // membership its `contract_end_date`, a life policy its `term_end_date` —
  // none contain "expir", so a policy renewing in two days, or lapsed three
  // days ago, showed on the calendar and under Important Dates and never in
  // the bell, while a passport document with `expirationDate` did. The rule
  // engine classifies every spelling and every value format the calendar does,
  // so the bell now sees exactly what the calendar sees for these types.
  //
  // What counts is `isAlertDateRule` (shared/date-rules) — the one answer the
  // dashboard's insight cards read too.
  for (const rule of rulesFromAll({ profiles, documents })) {
    if (!rule.active || !isAlertDateRule(rule)) continue;
    const isDoc = rule.sourceEntityType === "document";
    const words = dateRuleAlertWords(rule.ruleType);
    const diff = daysBetweenISO(todayStr, rule.date);
    if (diff > 30) continue;
    // The PATH, so a nested date keeps a stable id; for a top-level field it is
    // the key the old scan used, so existing dismissals still apply.
    const key = rule.sourcePath || rule.sourceField;
    const name = rule.subtitle || rule.label;
    const [pastTitle, soonTitle, laterTitle, futureVerb, pastVerb] = words;
    const base = {
      // The DATE is part of the id (D244): a dismissal is of one fact — this
      // expiry, this due day — never of every later one. Correct the date, or
      // let the next occurrence arrive, and the notice is new again.
      id: `${isDoc ? "doc" : "profile"}-exp-${rule.sourceEntityId}-${key}-${rule.date}`,
      type: "document_expiring" as const,
      entityId: rule.sourceEntityId,
      entityType: isDoc ? "document" : "profile",
      dueDate: rule.rawValue || rule.date,
    };
    const shown = rule.rawValue || rule.date;
    if (diff < 0) {
      notifications.push({
        ...base,
        severity: "critical",
        title: isDoc ? `${pastTitle}: ${name}` : `${pastTitle}: ${name} - ${key}`,
        message: `${key} ${pastVerb} ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${shown})`,
      });
    } else if (diff <= 7) {
      notifications.push({
        ...base,
        severity: "warning",
        title: isDoc ? `${soonTitle}: ${name}` : `${soonTitle}: ${name} - ${key}`,
        message: `${key} ${futureVerb} ${diff === 0 ? "today" : `in ${diff} day${diff !== 1 ? "s" : ""}`} (${shown})`,
      });
    } else {
      notifications.push({
        ...base,
        severity: "info",
        title: isDoc ? `${laterTitle}: ${name}` : `${laterTitle}: ${name} - ${key}`,
        message: `${key} ${futureVerb} in ${diff} days (${shown})`,
      });
    }
  }

  // --- Task Due Dates ---
  // A task carries a clock time now, so a timed task says its hour: "Mow the
  // lawn is due today · 9:00 AM". This is the notification the retired reminder
  // entity used to exist for.
  const atTime = (t: any) => {
    const hhmm = String(t?.dueTime || "");
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return "";
    const [h, m] = hhmm.split(":").map(Number);
    const ampm = h < 12 ? "AM" : "PM";
    return ` \u00B7 ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
  };
  for (const task of tasks) {
    if (task.status === "done" || !task.dueDate) continue;
    const due = parseDate(task.dueDate);
    if (!due) continue;
    const diff = daysDiff(due, today);
    if (diff < 0) {
      notifications.push({
        id: `task-overdue-${task.id}-${String(task.dueDate).slice(0, 10)}`,
        type: "task_overdue",
        severity: "critical",
        title: `Overdue: ${task.title}`,
        message: `Was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago${atTime(task)}`,
        entityId: task.id,
        entityType: "task",
        dueDate: task.dueDate,
      });
    } else if (diff === 0) {
      notifications.push({
        id: `task-today-${task.id}-${String(task.dueDate).slice(0, 10)}`,
        type: "task_due_today",
        severity: "warning",
        title: `${task.title} is due today`,
        message: `Priority: ${task.priority}${atTime(task)}`,
        entityId: task.id,
        entityType: "task",
        dueDate: task.dueDate,
      });
    } else if (diff <= 3) {
      notifications.push({
        id: `task-soon-${task.id}-${String(task.dueDate).slice(0, 10)}`,
        type: "task_due_today",
        severity: "info",
        title: `${task.title} due in ${diff} day${diff !== 1 ? "s" : ""}`,
        message: `Priority: ${task.priority}${atTime(task)}`,
        entityId: task.id,
        entityType: "task",
        dueDate: task.dueDate,
      });
    }
  }

  // --- Bills/Obligations ---
  for (const ob of obligations) {
    if (!ob.nextDueDate) continue;
    // A paused or cancelled bill is not due (D222) — the bills list already
    // hides it; the bell kept warning about it.
    if (!isActiveObligation(ob as any)) continue;
    const due = parseDate(ob.nextDueDate);
    if (!due) continue;
    const diff = daysDiff(due, today);
    if (diff < 0) {
      notifications.push({
        id: `bill-overdue-${ob.id}-${String(ob.nextDueDate).slice(0, 10)}`,
        type: "bill_due",
        severity: "critical",
        title: `Overdue bill: ${ob.name}`,
        message: `$${ob.amount.toFixed(2)} was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago`,
        entityId: ob.id,
        entityType: "obligation",
        dueDate: ob.nextDueDate,
      });
    } else if (diff <= 3) {
      notifications.push({
        id: `bill-soon-${ob.id}-${String(ob.nextDueDate).slice(0, 10)}`,
        type: "bill_due",
        severity: "warning",
        title: `Bill due soon: ${ob.name}`,
        message: `$${ob.amount.toFixed(2)} due in ${diff} day${diff !== 1 ? "s" : ""}${diff === 0 ? " (today)" : ""}`,
        entityId: ob.id,
        entityType: "obligation",
        dueDate: ob.nextDueDate,
      });
    } else if (diff <= 7 && !ob.autopay) {
      notifications.push({
        id: `bill-upcoming-${ob.id}-${String(ob.nextDueDate).slice(0, 10)}`,
        type: "bill_due",
        severity: "info",
        title: `Upcoming bill: ${ob.name}`,
        message: `$${ob.amount.toFixed(2)} due in ${diff} days (no autopay)`,
        entityId: ob.id,
        entityType: "obligation",
        dueDate: ob.nextDueDate,
      });
    }
  }

  // --- Habit Streak Risk & Milestones ---
  const streakMilestones = [7, 14, 30, 60, 90, 100, 365];
  for (const habit of habits) {
    // Streak risk: hasn't checked in today and has streak >= 3.
    // Both halves come from shared/habit-schedule so this agrees with the
    // dashboard: `isHabitDoneOn` honors targetPerDay (a "3× daily" habit isn't
    // done after one check-in), and a habit that isn't scheduled today can't be
    // at risk today.
    // (Milestones below are not day-scheduled, so this only gates the risk.)
    const dueToday = isHabitDueOn(habit, todayStr);
    const checkedInToday = isHabitDoneOn(habit, todayStr);
    if (dueToday && !checkedInToday && habit.currentStreak >= 3) {
      // A habit needing several completions a day is usually PART-done when
      // this fires. "Check in today" on a habit already at 2 of 3 reads as if
      // nothing had been recorded; say what is actually left.
      const p = habitDayProgress(habit as any, todayStr);
      notifications.push({
        id: `habit-risk-${habit.id}-${todayStr}`,
        type: "habit_at_risk",
        severity: "warning",
        title: `Don't break your ${habit.name} streak!`,
        message: p.required > 1
          ? `${habit.currentStreak} day${habit.currentStreak !== 1 ? "s" : ""} and counting — ${p.completed} of ${p.required} done, ${p.remaining} to go`
          : `${habit.currentStreak} day${habit.currentStreak !== 1 ? "s" : ""} and counting — check in today`,
        entityId: habit.id,
        entityType: "habit",
      });
    }
    // Streak milestones
    if (streakMilestones.includes(habit.currentStreak)) {
      notifications.push({
        id: `habit-milestone-${habit.id}-${habit.currentStreak}`,
        type: "streak_milestone",
        severity: "info",
        title: `Milestone! ${habit.currentStreak}-day ${habit.name} streak \u{1F389}`,
        message: `You've kept your ${habit.name} habit for ${habit.currentStreak} days straight!`,
        entityId: habit.id,
        entityType: "habit",
      });
    }
  }

  // (Removed 2026-08-09: an "Upcoming reminders" pass that read the reminders
  // table. Reminders were retired — a scheduled dose or appointment is a TASK
  // with a due date and a clock time, and the Task Due Dates pass above already
  // surfaces it, so this second source would now double every one of them.)

  // --- Recurring Dates (shared/recurring-dates) ---
  // Managed recurring dates (anniversaries, renewals, maintenance, custom
  // bills…) surface in the bell two ways:
  //   1. an upcoming occurrence inside its configured reminder lead time
  //   2. a MISSED completion-required occurrence (checked-off/skipped dates
  //      never fire — per-occurrence state lives in the event's tags)
  try {
    const events = await storage.getEvents().catch(() => [] as any[]);
    for (const ev of events) {
      const meta = parseRecurringMeta((ev as any).tags);
      if (!meta.isRecurringDate || meta.archived || meta.paused) continue;
      const evLike = { date: ev.date, recurrence: ev.recurrence, recurrenceEnd: ev.recurrenceEnd, tags: (ev as any).tags };
      if (meta.remindDays != null) {
        const next = nextOccurrence(evLike, todayStr);
        if (next) {
          const nextD = parseDate(next);
          const daysUntil = nextD ? daysDiff(nextD, today) : NaN;
          if (Number.isFinite(daysUntil) && daysUntil >= 0 && daysUntil <= meta.remindDays) {
            const kindLabel = kindDef(meta.kind).label;
            notifications.push({
              id: `rdate-${ev.id}-${next}`,
              type: "reminder",
              severity: daysUntil === 0 ? "warning" : "info",
              title: ev.title,
              message: daysUntil === 0 ? `${kindLabel} is today` : `${kindLabel} in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${next})`,
              entityId: ev.id,
              entityType: "event",
              dueDate: next,
            });
          }
        }
      }
      for (const missed of missedOccurrences(evLike, todayStr).slice(0, 3)) {
        notifications.push({
          id: `rdate-missed-${ev.id}-${missed}`,
          type: "reminder",
          severity: "warning",
          title: `Missed: ${ev.title}`,
          message: `The ${missed} occurrence hasn't been checked off — mark it done or skip it in Recurring Dates.`,
          entityId: ev.id,
          entityType: "event",
          dueDate: missed,
        });
      }
    }
  } catch { /* recurring-date bell entries are best-effort */ }

  // Deduplicate: keep only the most severe notification per entityId
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const seenEntities = new Map<string, number>();
  const deduped: AppNotification[] = [];
  for (const notif of notifications) {
    const dedupeKey = notif.entityId && notif.entityType
      ? `${notif.entityType}:${notif.entityId}`
      : notif.id;
    const existing = seenEntities.get(dedupeKey);
    if (existing !== undefined) {
      // Keep the more severe one (lower order = more severe)
      if (severityOrder[notif.severity] < severityOrder[deduped[existing].severity]) {
        deduped[existing] = notif;
      }
    } else {
      seenEntities.set(dedupeKey, deduped.length);
      deduped.push(notif);
    }
  }

  // --- Persisted custom rows (chat's create_notification) ---
  // Namespaced ids ('custom:<uuid>') can never collide with the computed ids
  // above; dismissal for these rows is a dismissed_at stamp, not the pref.
  try {
    const custom = await storage.listUserNotifications();
    for (const row of custom) {
      const sev = (["critical", "warning", "info"].includes(row.severity) ? row.severity : "info") as AppNotification["severity"];
      deduped.push({
        id: `custom:${row.id}`,
        type: "custom",
        severity: sev,
        title: row.title,
        message: row.message,
        entityId: row.entityId || undefined,
        entityType: row.entityType || undefined,
        read: !!row.readAt,
      });
    }
  } catch { /* custom rows are best-effort (table may not exist locally) */ }

  // --- User notification preferences: muted severities/types drop out ---
  const prefs = await readNotificationPrefs(storage);
  const mutedSev = new Set((prefs.muted_severities || []).map((s) => String(s).toLowerCase()));
  const mutedTypes = new Set((prefs.muted_types || []).map((s) => String(s).toLowerCase()));
  const filtered = (mutedSev.size > 0 || mutedTypes.size > 0)
    ? deduped.filter((n) => !mutedSev.has(n.severity) && !mutedTypes.has(n.type))
    : deduped;

  // --- Dismissed ids drop out here, for EVERY reader ---
  // The bell and the dashboard each re-applied the `dismissed_notifications`
  // preference client-side, and nothing else did: the assistant read the
  // same list and told the user a notification they had just dismissed was
  // "currently active". One filter, at the source, so the bell, the briefing,
  // the chat and the dismiss tool agree on what is showing. (Custom rows are
  // stamped dismissed_at in their own table and never enter the list.)
  const dismissed = await readDismissedNotificationIds(storage);
  const visible = dismissed.size > 0 ? filtered.filter((n) => !dismissed.has(n.id)) : filtered;

  // Sort: critical first, then warning, then info
  visible.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return visible;
}

/** The ids the user has dismissed from the bell (JSON string array pref). */
export async function readDismissedNotificationIds(storage: IStorage): Promise<Set<string>> {
  try {
    const raw = await storage.getPreference(DISMISSED_NOTIFICATIONS_PREF);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
