// client/src/lib/action-cards.ts — what a chat action card SAYS and where it GOES.
//
// Extracted from pages/chat.tsx so there is exactly one answer to "what did
// this action do, and where does tapping it take me?" — and so that answer can
// be tested without mounting the chat page.
//
// Two rules this module exists to enforce (QA reqs 1 + 2):
//
//   1. The card names the object that was ACTUALLY CREATED. A note is a note,
//      even though notes are stored as artifact rows. The storage table is not
//      the user's vocabulary, and a "Create Artifact" card under a request that
//      said "make a note" is the app disagreeing with itself.
//
//   2. Navigation uses the CANONICAL id the mutation returned — `_entityId` for
//      the record itself, `_ownerProfileId` for the profile it belongs to. It
//      never consults the currently-selected profile, the last profile in the
//      conversation, or a name lookup. If the action was Sarah's, the card goes
//      to Sarah.

export const ACTION_LABELS: Record<string, string> = {
  create_task: "Create Task",
  complete_task: "Complete Task",
  delete_task: "Delete Task",
  create_habit: "Create Habit",
  checkin_habit: "Checkin Habit",
  uncomplete_habit: "Undo Habit",
  delete_habit: "Delete Habit",
  create_goal: "Create Goal",
  create_event: "Create Event",
  complete_event: "Complete Event",
  log_entry: "Log Entry",
  create_tracker: "Create Tracker",
  delete_tracker_entry: "Delete Entry",
  update_tracker_entry: "Update Entry",
  journal_entry: "Journal Entry",
  log_expense: "Log Expense",
  create_profile: "Create Profile",
  update_profile: "Update Profile",
  create_obligation: "Add Bill",
  pay_obligation: "Pay Bill",
  save_memory: "Remember",
  retrieve: "Retrieve",
  create_artifact: "Create Artifact",
  create_note: "Create Note",
};

export function actionLabel(type: string, data?: any) {
  // The card names the ENTITY that was written, not the table it lives in.
  // Assets/vehicles/properties are profile rows, so create_profile(type:"asset")
  // is "Create Asset" — the card and the assistant text must agree on what
  // happened, and "Create Profile" for a truck reads like a different action.
  if ((type === "create_profile" || type === "update_profile") && data?.type) {
    const kind = String(data.type).toLowerCase();
    const noun = kind === "vehicle" || kind === "property" || kind === "asset" || kind === "investment"
      ? "Asset"
      : kind === "person" ? "Person"
      : kind === "pet" ? "Pet"
      : kind === "subscription" ? "Subscription"
      : null;
    if (noun) return `${type.startsWith("create") ? "Create" : "Update"} ${noun}`;
  }
  return ACTION_LABELS[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Deep-link for a chat action card — tapping the card opens the page where
// the entity lives (2026-07-15 user request: "when I press the profile it
// should bring me to the profile — every chat command should do that").
// Profile-row entities (people, pets, vehicles, assets, liabilities) go to
// their detail page; tracker entries open their tracker on /trackers; list
// entities land on their module page.
export function actionRoute(type: string, data: any): string | null {
  const id = data?._entityId;
  switch (type) {
    case "create_profile": case "update_profile": case "create_liability": case "revalue_asset":
      return id ? `/profiles/${id}` : "/profiles";
    case "create_tracker":
      return id ? `/trackers?tracker=${id}` : "/trackers";
    case "log_entry": case "log_tracker_entry": case "add_tracker_entry": case "update_tracker_entry": case "delete_tracker_entry":
      return data?._trackerId ? `/trackers?tracker=${data._trackerId}` : "/trackers";
    case "create_task": case "complete_task": return "/tasks";
    case "create_event": case "complete_event": return "/calendar";
    case "log_expense": case "log_income": case "log_paycheck": case "set_budget": return "/finance";
    case "create_obligation": case "pay_obligation": case "add_liability_payment": return "/obligations";
    case "create_habit": case "checkin_habit": case "uncomplete_habit": case "delete_habit": return "/habits";
    case "create_note": {
      // The note's own profile, from the mutation result — never the profile
      // that happens to be selected in the UI (QA req 1 + 2).
      const owner = data?._ownerProfileId;
      return owner ? `/profiles/${owner}/notes` : "/artifacts";
    }
    case "journal_entry": return "/journal";
    case "create_goal": return "/goals";
    case "save_memory": return null;
    default: return null;
  }
}

