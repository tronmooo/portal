// shared/domain/priority.ts — the unified "things that need you" engine.
//
// The chat attention list was built from habits alone, so "Mark Bathroom
// done" crowded out an expired insurance policy and an overdue payment. This
// ranks every kind of item — overdue tasks, expiring documents, expired
// insurance, missed payments, upcoming bills, important events, habits,
// unresolved alerts — on one scale:
//   severity + urgency + financial impact + safety impact + overdue duration
// and phrases the suggested action in natural language.
//
// Pure. Pinned by tests/consistency-layer-priority.test.ts.

import { alertScore, alertSeverity, buildAlert, type AlertInput, type AlertKind, type AlertSeverity } from "./alerts";

export type PriorityKind =
  | "task" | "document" | "insurance" | "payment" | "bill" | "event" | "habit" | "alert" | "health";

export interface PriorityInput {
  key: string;
  kind: PriorityKind;
  title: string;
  daysUntil?: number | null;
  amount?: number | null;
  protectedValue?: number | null;
  safetyImpact?: 0 | 1 | 2 | 3 | null;
  priority?: "low" | "medium" | "high" | "urgent" | null;
  /** For habits: whether it still needs doing today. */
  outstanding?: boolean | null;
  /** True for a document that is an insurance policy. */
  isInsurance?: boolean | null;
  /** An explicit alert kind when the caller already knows it. */
  alertKind?: AlertKind | null;
  href?: string | null;
}

export interface PriorityItem extends PriorityInput {
  severity: AlertSeverity;
  score: number;
  /** "Log bathroom visit", "Record the auto loan payment" — never "Mark X done". */
  suggestion: string | null;
  headline: string;
}

function alertKindFor(p: PriorityInput): AlertKind {
  if (p.alertKind) return p.alertKind;
  const d = p.daysUntil ?? null;
  const past = d !== null && d < 0;
  switch (p.kind) {
    case "insurance": return past ? "insurance_expired" : "insurance_expiring";
    case "document": return p.isInsurance ? (past ? "insurance_expired" : "insurance_expiring") : past ? "document_expired" : "document_expiring";
    case "payment": return "payment_missed";
    case "bill": return past ? "bill_overdue" : "bill_due";
    case "task": return past ? "task_overdue" : "task_due";
    case "event": return "event_upcoming";
    case "habit": return "habit_due";
    case "health": return "health_out_of_range";
    default: return "custom";
  }
}

const MEANINGLESS_HABIT = /^(bathroom|toilet|restroom|pee|poop)$/i;
const VISIT_HABIT = /^(bathroom|toilet|restroom)$/i;

/** Natural-language action, or null when there is nothing meaningful to say. */
export function suggestionFor(p: PriorityInput): string | null {
  const t = p.title.trim();
  switch (p.kind) {
    case "habit": {
      if (p.outstanding === false) return null;
      if (VISIT_HABIT.test(t)) return `Log ${t.toLowerCase()} visit`;
      if (MEANINGLESS_HABIT.test(t)) return null;
      return `Log ${t}`;
    }
    case "task": return (p.daysUntil ?? 0) < 0 ? `Finish ${t}` : `Do ${t}`;
    case "bill": return `Pay ${t}`;
    case "payment": return `Record the ${t} payment`;
    case "insurance": return `Renew ${t}`;
    case "document": return p.isInsurance ? `Renew ${t}` : `Update ${t}`;
    case "event": return `Prepare for ${t}`;
    case "health": return `Review ${t}`;
    default: return `Open ${t}`;
  }
}

export function rankPriorities(inputs: readonly PriorityInput[]): PriorityItem[] {
  const items: PriorityItem[] = [];
  for (const p of inputs) {
    if (p.kind === "habit" && p.outstanding === false) continue;
    const alert: AlertInput = {
      kind: alertKindFor(p), entityKey: p.key, subject: p.title, daysUntil: p.daysUntil ?? null, amount: p.amount ?? null,
      protectedValue: p.protectedValue ?? null, safetyImpact: p.safetyImpact ?? null, priority: p.priority ?? null,
    };
    const severity = alertSeverity(alert);
    const suggestion = suggestionFor(p);
    // A habit with nothing meaningful to say is not worth a slot.
    if (p.kind === "habit" && suggestion === null) continue;
    items.push({ ...p, severity, score: alertScore(alert, severity), suggestion, headline: buildAlert(alert).title });
  }
  return items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** The top N, with habits never displacing a warning or critical item. */
export function thingsThatNeedYou(inputs: readonly PriorityInput[], max = 5): PriorityItem[] {
  const ranked = rankPriorities(inputs);
  const serious = ranked.filter((i) => i.severity === "critical" || i.severity === "warning");
  const rest = ranked.filter((i) => !(i.severity === "critical" || i.severity === "warning"));
  return [...serious, ...rest].slice(0, max);
}
