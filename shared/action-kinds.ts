// shared/action-kinds.ts — the app's vocabulary of suggested actions.
// =============================================================================
//
// A suggested action already knows its destination, its operation and its
// target kind, but none of those are words a person uses. "calendar / UPDATE /
// profile" is how the engine thinks; "Create recurring calendar rule" is what
// the rail should say. This module is the one place that translation lives, so
// the panel, the tests and any future surface all name the same thing the same
// way.
//
// The vocabulary is the list the user wrote out (2026-08-27). Every name in it
// is either PRODUCED by the planner or explicitly BLOCKED with a reason — see
// `ACTION_KIND_STATUS` below and tests/action-kinds.test.ts, which asserts that
// no name is silently missing.
//
// Pure and deterministic: same inputs in, same name out.

import type { DateRuleType } from "./date-rules";

export type ActionKind =
  | "create_tracker"
  | "append_tracker"
  | "create_task"
  | "create_calendar_event"
  | "create_recurring_calendar_rule"
  | "create_deadline"
  | "create_expiration"
  | "create_renewal"
  | "create_recurring_obligation"
  | "create_one_time_obligation"
  | "create_payment_due"
  | "create_recurring_payment"
  | "create_expense"
  | "create_recurring_expense"
  | "create_income"
  | "create_recurring_income"
  | "record_payment"
  | "update_balance"
  | "create_subscription"
  | "update_subscription"
  | "update_asset"
  | "update_liability"
  | "update_profile"
  | "create_contact_info"
  | "update_contact_info"
  | "create_note"
  | "create_journal_entry"
  | "create_habit"
  | "create_warranty_deadline"
  | "create_maintenance_reminder"
  | "create_maintenance_schedule"
  | "create_document_expiration_reminder"
  | "link_document"
  | "link_records"
  | "reference_only"
  | "no_destination";

/** What the rail prints above each card. */
export const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  create_tracker: "Create tracker",
  append_tracker: "Append value to existing tracker",
  create_task: "Create task",
  create_calendar_event: "Create calendar event",
  create_recurring_calendar_rule: "Create recurring calendar rule",
  create_deadline: "Create deadline",
  create_expiration: "Create expiration",
  create_renewal: "Create renewal",
  create_recurring_obligation: "Create recurring obligation",
  create_one_time_obligation: "Create one-time obligation",
  create_payment_due: "Create payment due",
  create_recurring_payment: "Create recurring payment",
  create_expense: "Create expense",
  create_recurring_expense: "Create recurring expense",
  create_income: "Create income",
  create_recurring_income: "Create recurring income",
  record_payment: "Record payment",
  update_balance: "Update balance",
  create_subscription: "Create subscription",
  update_subscription: "Update existing subscription",
  update_asset: "Update existing asset",
  update_liability: "Update existing liability",
  update_profile: "Update profile information",
  create_contact_info: "Create contact information",
  update_contact_info: "Update contact information",
  create_note: "Create note",
  create_journal_entry: "Create journal entry",
  create_habit: "Create habit",
  create_warranty_deadline: "Create warranty/return deadline",
  create_maintenance_reminder: "Create service/maintenance reminder",
  create_maintenance_schedule: "Create recurring service/maintenance schedule",
  create_document_expiration_reminder: "Create document expiration reminder",
  link_document: "File document under a record",
  link_records: "Link two records",
  reference_only: "Keep on the document only",
  no_destination: "No compatible record",
};

/**
 * Which names extraction can actually produce, and why the rest cannot.
 *
 * The blocked three all mint a LIABILITY: in this app a bill is a liability
 * profile (supabase-storage.createObligation ends in createProfile({ type:
 * "liability" })), and document extraction never creates an asset or a
 * liability — the user's own rule, and the reason those records are already
 * linked to the document rather than made from it.
 */
export const ACTION_KIND_STATUS: Record<ActionKind, { produced: boolean; reason?: string }> = {
  create_recurring_obligation: {
    produced: false,
    reason: "A recurring bill is stored as a liability profile, and a document never creates one. Attach it to an existing bill, or take the repeating task instead.",
  },
  create_one_time_obligation: {
    produced: false,
    reason: "A one-off bill is stored as a liability profile, and a document never creates one. Attach it to an existing bill instead.",
  },
  create_recurring_payment: {
    produced: false,
    reason: "A new recurring payment has no home without a bill behind it. Attach it to an existing bill or liability and it updates that instead.",
  },
  create_contact_info: {
    produced: false,
    reason: "This app has no contact record — contact details are fields on the record they belong to, so they arrive as a profile update.",
  },
  create_subscription: {
    produced: false,
    reason: "A subscription is a liability-family record here (ObligationKind \"subscription\" ends in a liability profile), so a document never creates one. Attach the charge to the subscription you already have and it updates that instead.",
  },
  create_tracker: { produced: true },
  append_tracker: { produced: true },
  create_task: { produced: true },
  create_calendar_event: { produced: true },
  create_recurring_calendar_rule: { produced: true },
  create_deadline: { produced: true },
  create_expiration: { produced: true },
  create_renewal: { produced: true },
  create_payment_due: { produced: true },
  create_expense: { produced: true },
  create_recurring_expense: { produced: true },
  create_income: { produced: true },
  create_recurring_income: { produced: true },
  record_payment: { produced: true },
  update_balance: { produced: true },
  update_subscription: { produced: true },
  update_asset: { produced: true },
  update_liability: { produced: true },
  update_profile: { produced: true },
  update_contact_info: { produced: true },
  create_note: { produced: true },
  create_journal_entry: { produced: true },
  create_habit: { produced: true },
  create_warranty_deadline: { produced: true },
  create_maintenance_reminder: { produced: true },
  create_maintenance_schedule: { produced: true },
  create_document_expiration_reminder: { produced: true },
  link_document: { produced: true },
  link_records: { produced: true },
  reference_only: { produced: true },
  no_destination: { produced: true },
};

/** The word a date rule goes by on screen. */
export const DATE_RULE_WORD: Record<DateRuleType, string> = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  expiration: "Expiration",
  renewal: "Renewal",
  payment: "Payment due",
  income: "Income",
  due: "Due date",
  appointment: "Appointment",
  deadline: "Deadline",
  reminder: "Reminder",
  event: "Event",
  start: "Start date",
  end: "End date",
  cancellation: "Cancellation",
  maintenance: "Service reminder",
  informational: "Date",
};

export interface ActionKindInput {
  destination: string;
  operation: string;
  targetKind?: string;
  /** The profile's own type, when the target is a profile. */
  profileType?: string;
  ruleType?: DateRuleType | string;
  /** "none" | "yearly" | … — anything but "none" makes the name recurring. */
  recurrence?: string;
  /** Set by the period-deadline pass: a return window, warranty or trial. */
  periodKind?: string;
  savable?: boolean;
  documentExpiration?: boolean;
  /** The field keys this action writes — `Object.keys(payload.fields)`. */
  fieldKeys?: string[];
}

/** Phone, email, address and the rest — the fields that ARE contact details. */
const CONTACT_FIELD = /(phone|mobile|email|fax|website|\burl\b|address|street|city|state|zip|postal|contact)/i;

const ASSET_TYPES = new Set(["vehicle", "property", "asset", "account", "investment"]);
const LIABILITY_TYPES = new Set(["liability", "loan"]);

/**
 * Name one proposed action.
 *
 * Order of authority: an explicit refusal, then the destination, then — inside
 * the calendar, which carries most of the vocabulary — the date rule type and
 * whether it repeats.
 */
export function classifyActionKind(a: ActionKindInput): ActionKind {
  if (a.savable === false) {
    if (a.destination === "obligation" || a.targetKind === "obligation") {
      return a.recurrence && a.recurrence !== "none"
        ? "create_recurring_obligation"
        : "create_one_time_obligation";
    }
    return "no_destination";
  }

  switch (a.destination) {
    case "tracker":
    case "profile_tracker":
      if (a.destination === "profile_tracker" && a.operation === "UPDATE") return "update_balance";
      return a.operation === "CREATE" ? "create_tracker" : "append_tracker";

    case "task": {
      // "Service it again in six months" is a maintenance schedule that happens
      // to be stored as a repeating task. The rule type comes from the same
      // classifier every date goes through.
      const repeats = Boolean(a.recurrence && a.recurrence !== "none");
      if (a.ruleType === "maintenance") {
        return repeats ? "create_maintenance_schedule" : "create_maintenance_reminder";
      }
      if (a.ruleType === "renewal") return "create_renewal";
      if (a.ruleType === "deadline") return "create_deadline";
      return "create_task";
    }

    case "expense":
      return a.recurrence && a.recurrence !== "none" ? "create_recurring_expense" : "create_expense";

    case "income":
      return a.recurrence && a.recurrence !== "none" ? "create_recurring_income" : "create_income";

    case "liability_payment":
      return "record_payment";

    case "note":
      return "create_note";

    case "journal":
      return "create_journal_entry";

    case "habit":
      return "create_habit";

    case "document_attach":
      return "link_document";

    case "relationship_link":
      return "link_records";

    case "reference":
    case "ignore":
      return "reference_only";

    case "unsupported":
      return "no_destination";

    case "obligation":
      return "update_subscription";

    case "profile":
    case "entity_field":
    case "entity_record":
    case "structured_append": {
      if (a.operation === "CREATE") {
        return a.profileType === "subscription" ? "create_subscription" : "update_profile";
      }
      // This app has no contact RECORD — contact details are fields on the
      // record they belong to. So "update contact information" is a real,
      // reachable action and "create contact information" is not; the status
      // table says as much.
      if (a.fieldKeys?.length && a.fieldKeys.every((k) => CONTACT_FIELD.test(k))) {
        return "update_contact_info";
      }
      if (a.profileType === "subscription") return "update_subscription";
      if (a.profileType && ASSET_TYPES.has(a.profileType)) return "update_asset";
      if (a.profileType && LIABILITY_TYPES.has(a.profileType)) return "update_liability";
      return "update_profile";
    }

    case "calendar": {
      const recurring = Boolean(a.recurrence && a.recurrence !== "none");
      if (a.periodKind) return "create_warranty_deadline";
      switch (a.ruleType) {
        case "maintenance":
          return recurring ? "create_maintenance_schedule" : "create_maintenance_reminder";
        case "expiration":
          return a.documentExpiration ? "create_document_expiration_reminder" : "create_expiration";
        case "renewal":
          return "create_renewal";
        case "payment":
        case "due":
          return "create_payment_due";
        case "deadline":
          return "create_deadline";
        default:
          return recurring ? "create_recurring_calendar_rule" : "create_calendar_event";
      }
    }

    default:
      return "no_destination";
  }
}

/** The human name for one proposed action. */
export function actionKindLabel(a: ActionKindInput): string {
  return ACTION_KIND_LABEL[classifyActionKind(a)];
}
