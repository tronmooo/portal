// ── Notification building, extracted from GET /api/notifications ────────────
// One shared implementation so both the REST route and the AI chat's
// dismiss_notifications tool see the SAME list with the SAME deterministic ids
// (doc-exp-<id>-<key>, task-overdue-<id>, bill-soon-<id>, reminder-<id>, …).
// Dismissal works by id: the bell UI and the AI tool both merge ids into the
// `dismissed_notifications` preference (a JSON array of id strings) and the
// client filters by set membership. Caching and the profile filter stay in the
// route — this module is pure "compute the list".
import type { IStorage } from "./storage";
import { getUserToday } from "@shared/timezone";

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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = getUserToday(notifTz);

  // PERF (2026-05-31): fetch every list this endpoint needs in parallel.
  const [documents, profiles, tasks, obligations, habits] = await Promise.all([
    storage.getDocuments(),
    storage.getProfiles(),
    storage.getTasks(),
    storage.getObligations(),
    storage.getHabits(),
  ]);

  // --- Document Expirations ---
  const expirationKeywords = ["expir", "exp date", "exp_date", "expdate", "valid until", "valid through", "valid_until", "valid_through", "expires", "expiration"];

  for (const doc of documents) {
    if (!doc.extractedData || typeof doc.extractedData !== "object") continue;
    const fields = doc.extractedData as Record<string, any>;
    for (const [key, value] of Object.entries(fields)) {
      if (!value || typeof value !== "string") continue;
      const keyLower = key.toLowerCase();
      const isExpirationField = expirationKeywords.some(kw => keyLower.includes(kw));
      if (!isExpirationField) continue;
      const expDate = parseDate(value);
      if (!expDate) continue;
      const diff = daysDiff(expDate, today);
      if (diff < 0) {
        notifications.push({
          id: `doc-exp-${doc.id}-${key}`,
          type: "document_expiring",
          severity: "critical",
          title: `Expired: ${doc.name}`,
          message: `${key} expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
          entityId: doc.id,
          entityType: "document",
          dueDate: value,
        });
      } else if (diff <= 7) {
        notifications.push({
          id: `doc-exp-${doc.id}-${key}`,
          type: "document_expiring",
          severity: "warning",
          title: `Expiring soon: ${doc.name}`,
          message: `${key} expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
          entityId: doc.id,
          entityType: "document",
          dueDate: value,
        });
      } else if (diff <= 30) {
        notifications.push({
          id: `doc-exp-${doc.id}-${key}`,
          type: "document_expiring",
          severity: "info",
          title: `Expiring: ${doc.name}`,
          message: `${key} expires in ${diff} days (${value})`,
          entityId: doc.id,
          entityType: "document",
          dueDate: value,
        });
      }
    }
  }

  // --- Also scan profile fields for expiration dates ---
  for (const profile of profiles) {
    if (!profile.fields || typeof profile.fields !== "object") continue;
    for (const [key, value] of Object.entries(profile.fields as Record<string, any>)) {
      if (!value || typeof value !== "string") continue;
      const keyLower = key.toLowerCase();
      const isExpirationField = expirationKeywords.some(kw => keyLower.includes(kw));
      if (!isExpirationField) continue;
      const expDate = parseDate(value);
      if (!expDate) continue;
      const diff = daysDiff(expDate, today);
      if (diff < 0) {
        notifications.push({
          id: `profile-exp-${profile.id}-${key}`,
          type: "document_expiring",
          severity: "critical",
          title: `Expired: ${profile.name} - ${key}`,
          message: `Expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
          entityId: profile.id,
          entityType: "profile",
          dueDate: value,
        });
      } else if (diff <= 7) {
        notifications.push({
          id: `profile-exp-${profile.id}-${key}`,
          type: "document_expiring",
          severity: "warning",
          title: `Expiring soon: ${profile.name} - ${key}`,
          message: `Expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
          entityId: profile.id,
          entityType: "profile",
          dueDate: value,
        });
      } else if (diff <= 30) {
        notifications.push({
          id: `profile-exp-${profile.id}-${key}`,
          type: "document_expiring",
          severity: "info",
          title: `Expiring: ${profile.name} - ${key}`,
          message: `Expires in ${diff} days (${value})`,
          entityId: profile.id,
          entityType: "profile",
          dueDate: value,
        });
      }
    }
  }

  // --- Task Due Dates ---
  for (const task of tasks) {
    if (task.status === "done" || !task.dueDate) continue;
    const due = parseDate(task.dueDate);
    if (!due) continue;
    const diff = daysDiff(due, today);
    if (diff < 0) {
      notifications.push({
        id: `task-overdue-${task.id}`,
        type: "task_overdue",
        severity: "critical",
        title: `Overdue: ${task.title}`,
        message: `Was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago`,
        entityId: task.id,
        entityType: "task",
        dueDate: task.dueDate,
      });
    } else if (diff === 0) {
      notifications.push({
        id: `task-today-${task.id}`,
        type: "task_due_today",
        severity: "warning",
        title: `${task.title} is due today`,
        message: `Priority: ${task.priority}`,
        entityId: task.id,
        entityType: "task",
        dueDate: task.dueDate,
      });
    } else if (diff <= 3) {
      notifications.push({
        id: `task-soon-${task.id}`,
        type: "task_due_today",
        severity: "info",
        title: `${task.title} due in ${diff} day${diff !== 1 ? "s" : ""}`,
        message: `Priority: ${task.priority}`,
        entityId: task.id,
        entityType: "task",
        dueDate: task.dueDate,
      });
    }
  }

  // --- Bills/Obligations ---
  for (const ob of obligations) {
    if (!ob.nextDueDate) continue;
    const due = parseDate(ob.nextDueDate);
    if (!due) continue;
    const diff = daysDiff(due, today);
    if (diff < 0) {
      notifications.push({
        id: `bill-overdue-${ob.id}`,
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
        id: `bill-soon-${ob.id}`,
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
        id: `bill-upcoming-${ob.id}`,
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
    // Streak risk: hasn't checked in today and has streak >= 3
    const checkedInToday = habit.checkins?.some(c => c.date === todayStr);
    if (!checkedInToday && habit.currentStreak >= 3) {
      notifications.push({
        id: `habit-risk-${habit.id}`,
        type: "habit_at_risk",
        severity: "warning",
        title: `Don't break your ${habit.name} streak!`,
        message: `${habit.currentStreak} day${habit.currentStreak !== 1 ? "s" : ""} and counting — check in today`,
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

  // --- Upcoming reminders (incl. recurring medication reminders) ---
  // Surface pending reminders in the bell so a scheduled dose/appointment is
  // visible BEFORE it fires — not only when the cron converts it into a task.
  // listReminders() returns only un-fired reminders, so nothing here is a
  // duplicate of an already-fired-and-tasked reminder.
  try {
    const reminders = await storage.listReminders().catch(() => [] as any[]);
    const nowMs = Date.now();
    const horizonMs = nowMs + 7 * 86400000; // next 7 days
    // Group by title so a recurring reminder ("twice daily for 10 days")
    // shows as ONE bell entry (next occurrence + how many upcoming) instead
    // of flooding the popup with 14 identical rows.
    const byTitle = new Map<string, { title: string; earliest: number; id: string; count: number }>();
    for (const rem of reminders) {
      const whenMs = rem.fireAt ? new Date(rem.fireAt).getTime() : NaN;
      if (isNaN(whenMs) || whenMs > horizonMs) continue;
      const key = (rem.title || "").trim().toLowerCase();
      const g = byTitle.get(key);
      if (!g) byTitle.set(key, { title: rem.title, earliest: whenMs, id: rem.id, count: 1 });
      else { g.count++; if (whenMs < g.earliest) { g.earliest = whenMs; g.id = rem.id; } }
    }
    for (const g of byTitle.values()) {
      const overdue = g.earliest < nowMs;
      const whenHuman = new Date(g.earliest).toLocaleString("en-US", {
        timeZone: notifTz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      const more = g.count > 1 ? ` · ${g.count} upcoming` : "";
      notifications.push({
        id: `reminder-${g.id}`,
        type: "reminder",
        severity: overdue ? "warning" : "info",
        title: g.title,
        message: (overdue ? "Overdue" : `Next: ${whenHuman}`) + more,
        entityId: g.id,
        entityType: "reminder",
        dueDate: new Date(g.earliest).toISOString(),
      });
    }
  } catch { /* reminders in the bell are best-effort */ }

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

  // Sort: critical first, then warning, then info
  filtered.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return filtered;
}
