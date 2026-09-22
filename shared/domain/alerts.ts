// shared/domain/alerts.ts — severity-based, consolidated alerts.
//
// Four severity vocabularies existed (critical/warning/info, the insights
// engine's warning/negative/info/positive, the findings' five, and attention
// tiers), and a serious issue — a lapsed home-insurance policy on a
// high-value property — could appear as several near-identical rows beside
// an ordinary reminder. This module gives every alert one of four levels,
// scores it by what is at stake, and collapses the rows that describe the
// same underlying problem into one alert with clear actions.
//
// Pure. Pinned by tests/consistency-layer-alerts.test.ts.

import type { NotificationSeverity } from "../notification-rules";

export type AlertSeverity = "informational" | "upcoming" | "warning" | "critical";

export const ALERT_SEVERITY_RANK: Record<AlertSeverity, number> = { informational: 0, upcoming: 1, warning: 2, critical: 3 };

export type AlertKind =
  | "insurance_expired" | "insurance_expiring" | "document_expired" | "document_expiring"
  | "bill_overdue" | "bill_due" | "payment_missed" | "task_overdue" | "task_due"
  | "event_upcoming" | "habit_due" | "reminder" | "health_out_of_range" | "custom";

export interface AlertInput {
  kind: AlertKind;
  /** `${entityType}:${entityId}` — every row about the same thing shares it. */
  entityKey: string;
  /** What the alert is about ("Home insurance", "Mow the lawn"). */
  subject: string;
  /** Negative = overdue by N days; 0 = today; positive = days out. */
  daysUntil?: number | null;
  amount?: number | null;
  /** Value of the asset the alert protects (a home under a lapsed policy). */
  protectedValue?: number | null;
  /** 0 none · 1 minor · 2 significant · 3 safety/legal. */
  safetyImpact?: 0 | 1 | 2 | 3 | null;
  priority?: "low" | "medium" | "high" | "urgent" | null;
}

export interface AlertAction { kind: "upload" | "update" | "resolve" | "pay" | "complete" | "open" | "snooze"; label: string }

export interface Alert extends AlertInput {
  severity: AlertSeverity;
  title: string;
  score: number;
  actions: AlertAction[];
  /** Rows this alert consolidates, including itself. */
  count: number;
}

const HIGH_VALUE = 100_000;

/** The severity of one alert, from what it is. */
export function alertSeverity(a: AlertInput): AlertSeverity {
  const d = a.daysUntil ?? null;
  const overdue = d !== null && d < 0;
  switch (a.kind) {
    case "insurance_expired":
    case "payment_missed":
      return "critical";
    case "document_expired":
      return (a.protectedValue ?? 0) >= HIGH_VALUE || (a.safetyImpact ?? 0) >= 2 ? "critical" : "warning";
    case "bill_overdue":
      return (a.amount ?? 0) >= 500 || (d !== null && d <= -14) ? "critical" : "warning";
    case "task_overdue":
      return (a.priority === "high" || a.priority === "urgent") && d !== null && d <= -14 ? "critical" : "warning";
    case "health_out_of_range":
      return (a.safetyImpact ?? 0) >= 3 ? "critical" : "warning";
    case "insurance_expiring":
    case "document_expiring":
      return d !== null && d <= 7 ? "warning" : "upcoming";
    case "bill_due":
    case "task_due":
    case "event_upcoming":
      if (overdue) return "warning";
      return d !== null && d <= 7 ? "upcoming" : "informational";
    case "habit_due":
    case "reminder":
      return overdue ? "upcoming" : "informational";
    default:
      return overdue ? "warning" : "informational";
  }
}

/** Ranking: severity, then how overdue, then financial and safety stakes. */
export function alertScore(a: AlertInput, severity: AlertSeverity = alertSeverity(a)): number {
  const d = a.daysUntil ?? null;
  let score = ALERT_SEVERITY_RANK[severity] * 100;
  if (d !== null) {
    if (d < 0) score += Math.min(60, Math.abs(d)); // overdue duration
    else score += Math.max(0, 30 - d);             // urgency
  }
  const money = Math.max(a.amount ?? 0, a.protectedValue ?? 0);
  score += Math.min(40, Math.log10(Math.max(1, money)) * 8);
  score += (a.safetyImpact ?? 0) * 15;
  return Math.round(score);
}

export function alertActions(kind: AlertKind): AlertAction[] {
  switch (kind) {
    case "insurance_expired":
    case "insurance_expiring":
      return [{ kind: "upload", label: "Upload renewal" }, { kind: "update", label: "Update policy" }, { kind: "resolve", label: "Mark resolved" }];
    case "document_expired":
    case "document_expiring":
      return [{ kind: "upload", label: "Upload new version" }, { kind: "update", label: "Update dates" }, { kind: "resolve", label: "Mark resolved" }];
    case "bill_overdue":
    case "bill_due":
    case "payment_missed":
      return [{ kind: "pay", label: "Record payment" }, { kind: "open", label: "Open bill" }];
    case "task_overdue":
    case "task_due":
      return [{ kind: "complete", label: "Mark complete" }, { kind: "snooze", label: "Reschedule" }];
    case "habit_due":
      return [{ kind: "complete", label: "Log it" }];
    case "health_out_of_range":
      return [{ kind: "open", label: "See reading" }];
    default:
      return [{ kind: "open", label: "Open" }];
  }
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** "Home insurance expired 113 days ago" / "Mow the lawn is overdue by 2 days". */
export function alertTitle(a: AlertInput): string {
  const d = a.daysUntil ?? null;
  const ago = d !== null && d < 0 ? `${Math.abs(d)} day${plural(Math.abs(d))} ago` : null;
  const inDays = d !== null && d > 0 ? `in ${d} day${plural(d)}` : d === 0 ? "today" : null;
  switch (a.kind) {
    case "insurance_expired":
    case "document_expired":
      return ago ? `${a.subject} expired ${ago}` : `${a.subject} has expired`;
    case "insurance_expiring":
    case "document_expiring":
      return inDays ? `${a.subject} expires ${inDays}` : `${a.subject} is expiring`;
    case "bill_overdue":
      return ago ? `${a.subject} is overdue by ${Math.abs(d!)} day${plural(Math.abs(d!))}` : `${a.subject} is overdue`;
    case "payment_missed":
      return `${a.subject} payment was missed`;
    case "bill_due":
      return inDays ? `${a.subject} is due ${inDays}` : `${a.subject} is due`;
    case "task_overdue":
      return ago ? `${a.subject} is overdue by ${Math.abs(d!)} day${plural(Math.abs(d!))}` : `${a.subject} is overdue`;
    case "task_due":
      return inDays ? `${a.subject} is due ${inDays}` : `${a.subject} is due`;
    case "event_upcoming":
      return inDays ? `${a.subject} is ${inDays}` : a.subject;
    case "habit_due":
      return `Log ${a.subject}`;
    case "health_out_of_range":
      return `${a.subject} is out of range`;
    default:
      return a.subject;
  }
}

/** Build one alert from its input. */
export function buildAlert(a: AlertInput): Alert {
  const severity = alertSeverity(a);
  return { ...a, severity, title: alertTitle(a), score: alertScore(a, severity), actions: alertActions(a.kind), count: 1 };
}

/**
 * One alert per underlying issue: rows sharing an entityKey collapse onto the
 * most severe (then highest-scoring) one, and the result is ranked.
 */
export function consolidateAlerts(inputs: readonly AlertInput[]): Alert[] {
  const byKey = new Map<string, Alert>();
  for (const input of inputs) {
    const alert = buildAlert(input);
    const key = alert.entityKey || `${alert.kind}:${alert.subject}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, alert); continue; }
    const winner = ALERT_SEVERITY_RANK[alert.severity] > ALERT_SEVERITY_RANK[prev.severity]
      || (alert.severity === prev.severity && alert.score > prev.score) ? alert : prev;
    byKey.set(key, { ...winner, count: prev.count + 1 });
  }
  return [...byKey.values()].sort((x, y) => y.score - x.score);
}

/** Map to the bell's three-level vocabulary without a second table. */
export function toNotificationSeverity(s: AlertSeverity): NotificationSeverity {
  return s === "critical" ? "critical" : s === "warning" ? "warning" : "info";
}
