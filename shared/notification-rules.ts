// shared/notification-rules.ts — what a notification SAYS and how loud it is.
//
// Two rules the bell and notification-service share (QA 2026-09-18 F-51/F-53):
//
//   • A dated notice names the THING, not the field it was read from.
//     "expirationDate expired 109 days ago (2026-06-01)" leaked a storage key;
//     it reads "Homeowners Insurance expired 109 days ago (Jun 1, 2026)".
//   • Severity is per notification, from what it is: an expired policy is
//     critical, an overdue errand is a warning, something due next week is
//     information. Every task that slipped a day used to sit under CRITICAL
//     with a red rail, next to a lapsed insurance policy.

import { humanizeFieldName } from "./field-label";
import { dateRuleAlertWords, type DateRuleType } from "./date-rules";

export type NotificationSeverity = "critical" | "warning" | "info";

/** "2026-06-01" → "Jun 1, 2026". Anything else is returned untouched. */
export function formatNoticeDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Overdue by more than this, a high-priority task stops being a mere warning. */
export const TASK_OVERDUE_CRITICAL_DAYS = 14;

/** How loud an overdue task is: a warning, unless it is urgent AND long past. */
export function overdueTaskSeverity(daysOverdue: number, priority?: string | null): NotificationSeverity {
  const p = String(priority || "").toLowerCase();
  if ((p === "high" || p === "urgent") && daysOverdue >= TASK_OVERDUE_CRITICAL_DAYS) return "critical";
  return "warning";
}

/** How loud a date rule is at `diff` days from today (negative = past). */
export function dateRuleSeverity(diff: number): NotificationSeverity {
  if (diff < 0) return "critical";
  if (diff <= 7) return "warning";
  return "info";
}

export interface DateRuleNoticeInput {
  ruleType: DateRuleType;
  /** True for a document's date; false for a date on a profile field. */
  isDocument: boolean;
  /** The document's name, or the profile's name. */
  entityName: string;
  /** The field key the date was read from (profiles only). */
  fieldKey?: string;
  /** Calendar days from today; negative when past. */
  diff: number;
  /** ISO date of the rule. */
  date: string;
}

/**
 * Title + message for a dated notice. The subject is the document's own
 * name, or — for a profile field — the person plus the field's human label
 * ("Dana · Passport Expiration"), never the raw key.
 */
export function dateRuleNotice(input: DateRuleNoticeInput): { title: string; message: string; severity: NotificationSeverity } {
  const [pastTitle, soonTitle, laterTitle, futureVerb, pastVerb] = dateRuleAlertWords(input.ruleType);
  const fieldLabel = input.fieldKey ? humanizeFieldName(String(input.fieldKey).split(".").pop() || input.fieldKey) : "";
  const subject = input.isDocument || !fieldLabel ? input.entityName : `${input.entityName} · ${fieldLabel}`;
  const messageSubject = input.isDocument || !fieldLabel ? input.entityName : fieldLabel;
  const when = formatNoticeDate(input.date);
  const days = Math.abs(input.diff);
  const plural = days !== 1 ? "s" : "";
  const severity = dateRuleSeverity(input.diff);
  if (input.diff < 0) {
    return { severity, title: `${pastTitle}: ${subject}`, message: `${messageSubject} ${pastVerb} ${days} day${plural} ago (${when})` };
  }
  if (input.diff <= 7) {
    return {
      severity, title: `${soonTitle}: ${subject}`,
      message: `${messageSubject} ${futureVerb} ${input.diff === 0 ? "today" : `in ${input.diff} day${plural}`} (${when})`,
    };
  }
  return { severity, title: `${laterTitle}: ${subject}`, message: `${messageSubject} ${futureVerb} in ${input.diff} days (${when})` };
}
