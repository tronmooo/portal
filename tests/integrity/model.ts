// The dependency model: every kind of record, where it is stored, every door
// that changes it, every figure computed from it and every screen that shows it.
//
// WHY (owner, 2026-11-27: "Map every data type to every section, component,
// calculation, and dependent record it affects … Create a dependency map and
// coverage matrix"): docs/WORKFLOW_MATRIX.md lists the DOORS (routes, tools,
// screens) by domain. It does not say what a write through a door must then
// change — which totals, which calendar dates, which other rows — and so
// cannot say whether a test checked the consequences or only the answer.
//
// What is hand-written here is what the code cannot tell us: the dependencies
// (`derived`, `dependents`, `screens`). The DOORS are still read from the code
// (scripts/workflow-inventory.ts) and assigned by the matchers below, so a new
// route or chat tool that fits no data type fails tests/integrity-model.test.ts.
//
// Used by scripts/gen-integrity-map.ts (docs/INTEGRITY_MAP.md) and the report.

export const OPERATIONS = ["create", "edit", "delete", "restore", "archive", "duplicate", "reschedule", "transfer", "cancel", "complete"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Door = "ui" | "api" | "chat";

export const OPERATION_MEANING: Record<Operation, string> = {
  create: "add a record",
  edit: "change a stored value",
  delete: "delete (to Trash where the record has one)",
  restore: "bring back from Trash / a kept version",
  archive: "archive, purge or end for good",
  duplicate: "make an independent copy",
  reschedule: "move a date, one occurrence or the series' rule",
  transfer: "change the owner, the parent or a link to another record",
  cancel: "undo, skip, pause, reverse, dismiss",
  complete: "complete, pay, check in, confirm, tick",
};

export interface Derived {
  /** The figure, in the words a screen uses. */
  name: string;
  /** The ONE module that computes it (Rule 1). */
  source: string;
  /** Where it is served or drawn. */
  shownOn: string[];
}

export interface EntityModel {
  key: string;
  label: string;
  /** Postgres tables (or preference keys, written `preferences:<key>`). */
  stores: string[];
  /** First match wins across MODEL, so order entities from specific to general. */
  routes: RegExp[];
  tools: RegExp[];
  derived: Derived[];
  /** What else changes or must be cleaned up when a record of this kind is written or deleted. */
  dependents: string[];
  /** Screens (client routes) that show it. */
  screens: string[];
  /** Stored as a profile row: created, edited and deleted through the profile
   *  routes and the profile chat tools as well as its own. */
  profileBacked?: boolean;
  /** Not a user workflow: left out of the coverage matrix. */
  system?: boolean;
}

const D = (name: string, source: string, ...shownOn: string[]): Derived => ({ name, source, shownOn });

export const MODEL: EntityModel[] = [
  {
    key: "liabilityPayment", label: "Loan / card payment",
    stores: ["liability_payments", "expenses (interest & fees, tag payment-cost:<id>)", "profiles.fields.balance"],
    routes: [/^\/api\/liability-payments/, /^\/api\/liabilities\/:[^/]+\/payments/, /^\/api\/loans\/payment/],
    tools: [/liability_payment/, /^undo_last_payment$/, /^mark_loan_payment$/],
    derived: [
      D("principal / interest split (interest once a month)", "server/liability-payments.ts planDebtPayment · shared/liability-calc.ts interestChargedInMonth", "/profiles/:id (liability Payments tab)", "chat receipt"),
      D("balance after the payment", "shared/payment-receipt.ts", "liability header", "/linked?tab=liabilities", "chat receipt"),
      D("this month's spending (interest only, A4)", "shared/autopay.ts debtPaymentExpenseAmount", "/finance", "/dashboard Money card"),
      D("debt principal paid this month", "server/supabase-storage.ts finance snapshot", "/finance"),
      D("\"this cycle is paid\"", "shared/loan-facts.ts lastPaymentCoversCycle", "Bills & Payments", "/calendar"),
    ],
    dependents: ["reversing a payment restores the balance and deletes its interest expense", "a payment Auto Pay recorded becomes 'missed' when reversed (A3)", "net worth (debt total) follows the balance"],
    screens: ["/profiles/:id/:tab", "/finance", "/dashboard", "/calendar", "/chat"],
  },
  {
    profileBacked: true, key: "bill", label: "Bill / recurring obligation (and Auto Pay)",
    stores: ["profiles (type liability, a recurring type_key)", "liability_payments", "expenses (tag payment:<id>)", "profiles.fields occurrence stamps"],
    routes: [/^\/api\/obligations/, /^\/api\/obligation-occurrences/, /^\/api\/liabilities\/:[^/]+\/(occurrences|autopay|pause|resume|schedule)/, /^\/api\/autopay/],
    tools: [/obligation/, /^add_liability_charge$/, /^set_liability_amount$/],
    derived: [
      D("next due date (an elapsed date is assumed paid)", "shared/bills-timeline.ts rollBillsForward / nextBillDate", "/obligations", "/finance Bills & Payments", "/dashboard Money card", "notification bell"),
      D("calendar occurrences", "shared/liability-schedule.ts deriveScheduleFields → generateSchedule", "/calendar", "Executive Timeline"),
      D("what Auto Pay records now", "shared/autopay.ts autopayDueOccurrence", "cron due scan", "POST /api/autopay/run"),
      D("payment status (assumed / confirmed / missed)", "shared/autopay.ts occurrencePaymentStatus", "liability Payments tab", "/finance"),
      D("monthly obligation total", "server finance snapshot", "/finance", "/dashboard"),
      D("needs-attention alert (missed, due soon unless quiet Auto Pay)", "shared/date-rules.ts · shared/autopay.ts isQuietAutoPayBill", "/dashboard Needs Attention", "bell"),
    ],
    dependents: ["paying writes one payment and one expense; undo removes both", "skipping marks ONE date; the series keeps its schedule", "a bill never becomes a task (A7)", "deleting the bill removes it from the calendar and the obligations list"],
    screens: ["/obligations", "/finance", "/dashboard", "/calendar", "/profiles/:id/:tab", "/linked"],
  },
  {
    profileBacked: true, key: "liability", label: "Debt (loan, card, mortgage)",
    stores: ["profiles (type liability + type_key; legacy type loan)", "liability_profile_links", "liability_asset_links"],
    routes: [/^\/api\/liabilities/, /^\/api\/loans/, /^\/api\/liability-(profile|asset)-links/, /^\/api\/profiles\/:[^/]+\/liability-owners/, /^\/api\/relationships\/move-liability/, /^\/api\/parties\/:[^/]+\/liabilities/],
    tools: [/liability/, /loan/],
    derived: [
      D("balance (canonical key)", "shared/liability-fields.ts readBalance · shared/profile-field-canon.ts", "everywhere a debt is shown"),
      D("APR as a percent with its unit", "shared/liability-fields.ts readInterestRatePct / storedRateFields", "liability header", "forms"),
      D("next due date from the payment day", "shared/loan-facts.ts nextLoanDueDate · shared/temporal-status.ts", "/linked?tab=liabilities", "liability header", "/calendar"),
      D("payoff outlook / amortization", "shared/liability-calc.ts buildAmortization", "liability Schedule & Cost of Ownership tabs"),
      D("payments left", "shared/loan-facts.ts loanStoredTermMonths", "liability Overview"),
      D("net worth — debt side, by ownership share", "shared/net-worth.ts computeNetWorth · shared/asset-value.ts isNetWorthLiabilityProfile", "/dashboard", "/finance", "chat home tile"),
    ],
    dependents: ["one debt = one record: no separate payment bill (L1)", "shares per owner (liability_profile_links) drive each person's debt", "deleting a debt removes its payments, links and calendar dates"],
    screens: ["/linked?tab=liabilities", "/profiles/:id/:tab", "/finance", "/dashboard", "/calendar"],
  },
  {
    profileBacked: true, key: "asset", label: "Asset (owned thing) and its lifecycle",
    stores: ["profiles (vehicle / property / asset / investment)", "asset_party_links", "ownership_history", "profiles.fields valuation + lifecycleAssumptions"],
    routes: [/^\/api\/assets/, /^\/api\/valuations/, /^\/api\/asset-party-links/, /^\/api\/ownership-history/, /^\/api\/parties/, /^\/api\/profiles\/:[^/]+\/(valuation|owners|lookup-value|find-value|tree)/],
    tools: [/asset/, /ownership/, /^revalue/],
    derived: [
      D("current value", "shared/asset-value.ts resolveAssetValue · shared/valuation/context.ts currentAssetValue", "asset header", "Value card", "/linked?tab=assets"),
      D("net worth — asset side, by ownership share, nested items once", "shared/net-worth.ts computeNetWorth", "/dashboard", "/finance", "chat home tile"),
      D("accumulated & next-12-month depreciation, projection", "shared/asset-lifecycle.ts computeAssetLifecycle", "Value card", "value graph"),
      D("salvage value (the engine's, or the user's own)", "shared/asset-salvage.ts · shared/asset-lifecycle.ts", "Value card"),
      D("optimal disposal point (never the salvage value)", "shared/disposal-model.ts decideDisposal", "Value card", "value graph", "/calendar"),
      D("recommendation (keep / sell / replace)", "shared/asset-lifecycle.ts", "/dashboard Needs Attention", "/linked?tab=assets pill", "/calendar"),
      D("cost of ownership / repair-vs-replace", "shared/asset-lifecycle.ts attributeAssetExpenses", "asset Financials tab"),
      D("rollup of nested assets", "shared/asset-rollup.ts", "asset Contained tab"),
    ],
    dependents: ["a nested asset's value is NOT added into its parent (LC3)", "an expense naming parent and child belongs to the deepest", "ownership shares must total 100%; a deleted owner's share returns to the others", "deleting an asset deletes its characteristic values"],
    screens: ["/linked?tab=assets", "/profiles/:id/:tab", "/dashboard", "/finance", "/calendar"],
  },
  {
    profileBacked: true, key: "account", label: "Financial account (cash, card, brokerage)",
    stores: ["profiles (type account)", "financial_accounts", "net_worth_snapshots"],
    routes: [/^\/api\/accounts/, /^\/api\/net-worth/, /^\/api\/cron\/snapshot-net-worth/],
    tools: [/account/, /net_worth/],
    derived: [
      D("balance is the value (never estimated, Rule 10)", "server/valuation/service.ts isValuableProfile", "account page"),
      D("asset or debt by account kind", "shared/asset-value.ts isAssetProfile / isLiabilityProfile", "net worth", "/finance"),
      D("net worth history", "server net-worth snapshot cron", "/finance", "/dashboard"),
    ],
    dependents: ["a balance change moves net worth by the same amount"],
    screens: ["/linked?tab=assets", "/finance", "/profiles/:id/:tab", "/dashboard"],
  },
  {
    key: "bankLedger", label: "Connected bank data & statement import",
    stores: ["financial_connections", "financial_transactions", "financial_transfer_links", "finance_imports", "financial_transaction_overrides"],
    routes: [/^\/api\/finance(\/|$)/, /^\/api\/finance-import/, /^\/api\/import\/bank-csv/, /^\/api\/anomalies/],
    tools: [/financial/, /^refresh_financial_data$/, /^search_financial_transactions$/],
    derived: [
      D("a bank transaction confirms an assumed payment, never a second expense (A5)", "server/autopay.ts reconcileBankTransaction", "/finance"),
      D("cash flow, income and spending from the ledger", "server/finance-routes.ts", "/finance"),
    ],
    dependents: ["an import can be undone as one batch", "a transfer between own accounts is neither income nor spending"],
    screens: ["/finance"],
  },
  {
    key: "expense", label: "Expense",
    stores: ["expenses"],
    routes: [/^\/api\/expenses/, /^\/api\/receipt-extract/],
    tools: [/expense/, /^spending_analytics$/, /^get_spending_breakdown$/],
    derived: [
      D("this month's spending (dated on or before today)", "server/supabase-storage.ts finance snapshot · shared/domain/financial-period", "/finance", "/dashboard Money card", "chat home tile"),
      D("spending by category (budget keys)", "shared/budget-ledger.ts budgetCategoryKey", "/finance", "budgets"),
      D("budget remaining", "server/routes.ts dashboard-bootstrap budgetSummary", "/finance", "/dashboard"),
      D("an asset's cost of ownership", "shared/asset-lifecycle.ts attributeAssetExpenses", "asset Financials tab"),
      D("a profile's related spending", "server/supabase-storage.ts getProfileDetail", "profile Financials tab"),
    ],
    dependents: ["a payment's expense is deleted with the payment", "deleting an expense of an Auto Pay payment marks it missed (A3)", "restore brings the same row back"],
    screens: ["/finance", "/dashboard", "/profiles/:id/:tab", "/chat"],
  },
  {
    key: "income", label: "Income, paychecks and cash flow",
    stores: ["incomes", "preferences:paychecks / cashflow"],
    routes: [/^\/api\/incomes/, /^\/api\/paychecks/, /^\/api\/cashflow/],
    tools: [/income/, /paycheck/, /cashflow/],
    derived: [D("monthly / recurring income", "server finance snapshot", "/finance", "/dashboard")],
    dependents: ["a possible duplicate is a question (409), not a second row"],
    screens: ["/finance"],
  },
  {
    key: "budget", label: "Budget",
    stores: ["preferences:budget:<month>"],
    routes: [/^\/api\/budgets/],
    tools: [/budget/],
    derived: [D("budget total, spent, remaining", "shared/budget-ledger.ts · dashboard-bootstrap budgetSummary", "/finance", "/dashboard")],
    dependents: ["a deleted person's per-person budgets are removed from every month"],
    screens: ["/finance"],
  },
  {
    key: "task", label: "Task",
    stores: ["tasks", "entity_links"],
    routes: [/^\/api\/tasks/],
    tools: [/task/],
    derived: [
      D("calendar item (only when it has a due date)", "shared/calendar-adapters.ts · server getCalendarTimeline", "/calendar", "Executive Timeline"),
      D("counts by day (due, late, done)", "shared task counts (countTasksByDay)", "/dashboard", "chat home", "AI summary"),
      D("occurrence done / skipped / moved", "shared/recurrence.ts · shared/task-occurrences.ts isTaskOccurrenceDone", "/tasks", "/calendar"),
      D("next occurrence of a repeating task", "shared/recurrence.ts nextRecurringTaskSpawn", "/tasks"),
    ],
    dependents: ["completing a repeating task makes exactly one next occurrence", "a skip marks one date; later dates stay (O1)", "a deleted owner is removed from linkedProfiles"],
    screens: ["/tasks", "/calendar", "/dashboard", "/chat", "/profiles/:id/:tab"],
  },
  {
    key: "event", label: "Calendar event",
    stores: ["events"],
    routes: [/^\/api\/events/, /^\/api\/calendar/, /^\/api\/date-rules/],
    tools: [/event/, /calendar/, /date_rules/],
    derived: [
      D("occurrences of a series", "shared/calendar-occurrences.ts", "/calendar", "Executive Timeline", "/dashboard today's events"),
      D("span carried when the start moves", "shared/event-span.ts carryEventSpan", "/calendar"),
      D("occurrence history", "shared/occurrence-history.ts", "calendar item detail"),
      D("owner label on a dated item", "shared/birthday-event.ts ownerLabelForDatedItem", "/calendar", "/dashboard"),
    ],
    dependents: ["deleting a series removes every occurrence", "a profile created later re-owns that person's birthday events"],
    screens: ["/calendar", "/dashboard", "/chat"],
  },
  {
    key: "habit", label: "Habit and check-ins",
    stores: ["habits", "habit_checkins", "trackers (linked tracker)"],
    routes: [/^\/api\/habits/],
    tools: [/habit/],
    derived: [
      D("current / longest streak", "server habit streak (from check-ins)", "/habits", "/dashboard", "/wellness"),
      D("completion rate", "server /api/stats", "/dashboard"),
    ],
    dependents: ["one check-in per day", "deleting a habit deletes its linked tracker (schema: trackers.linked_habit_id)", "restore keeps the check-ins"],
    screens: ["/habits", "/dashboard", "/wellness", "/calendar"],
  },
  {
    key: "goal", label: "Goal",
    stores: ["goals", "entity_links"],
    routes: [/^\/api\/goals/],
    tools: [/goal/],
    derived: [D("progress toward the target", "client goal progress", "/goals", "/dashboard")],
    dependents: ["a goal linked to a tracker or habit reads its progress from it"],
    screens: ["/goals", "/dashboard"],
  },
  {
    key: "trackerEntry", label: "Tracker entry (a logged reading)",
    stores: ["tracker_entries"],
    routes: [/^\/api\/tracker-entries/, /^\/api\/trackers\/:[^/]+\/entries/, /^\/api\/trackers\/smart-entry/],
    tools: [/tracker_entry/, /dose/, /medication/],
    derived: [
      D("derived pace / speed / calories, re-derived on edit", "shared/entry-rederive.ts rederiveEditedEntry", "tracker history", "tracker card"),
      D("a period's total or last reading", "shared/wellness-period.ts summarize", "/wellness", "chat home tiles"),
      D("one food = one entry", "shared/food-split.ts splitSeparateFoods", "Nutrition tracker"),
    ],
    dependents: ["entries go with their tracker"],
    screens: ["/trackers", "/wellness", "/chat", "/profiles/:id/:tab"],
  },
  {
    key: "tracker", label: "Tracker",
    stores: ["trackers"],
    routes: [/^\/api\/trackers/, /^\/api\/wellness/, /^\/api\/wellness-widgets/, /^\/api\/cleanup\/tracker-entries/],
    tools: [/tracker/],
    derived: [
      D("one tracker per owner + name", "server/supabase-storage.ts createTracker", "/trackers"),
      D("Wellness tiles, trends, widgets", "shared/wellness-period.ts · shared/wellness-widgets.ts", "/wellness"),
    ],
    dependents: ["deleting a tracker deletes its entries", "a deleted owner's trackers go with them"],
    screens: ["/trackers", "/wellness", "/profiles/:id/:tab"],
  },
  {
    key: "document", label: "Document (uploaded file)",
    stores: ["documents", "storage bucket"],
    routes: [/^\/api\/documents/, /^\/api\/upload/, /^\/api\/smart-fill/, /^\/api\/cleanup\/migrate-documents-to-storage/],
    tools: [/document/],
    derived: [
      D("expiration alert (from the dated fields, superseded by a newer document)", "shared/date-rules.ts isAlertDateRule / markSupersededDocumentRules", "/dashboard Needs Attention", "bell", "/calendar"),
      D("alert id shared by the row and its alert", "shared/alert-ids.ts dateAlertId", "bell", "dismissed list"),
    ],
    dependents: ["delete → Trash → restore or purge", "a deleted document raises no alert"],
    screens: ["/artifacts", "/documents/:id", "/dashboard", "/profiles/:id/:tab"],
  },
  {
    key: "note", label: "Note",
    stores: ["artifacts (type note)", "preferences:versions:note:<id>"],
    routes: [/^\/api\/notes/, /^\/api\/captures/, /^\/api\/workspace\/notes/],
    tools: [/_note$/, /_notes$/],
    derived: [D("version history (one per sitting)", "shared/content-versions.ts keepVersion", "Notes workspace"), D("category / favourite", "note tags · pinned", "Notes workspace", "/artifacts")],
    dependents: ["deleting a note empties its versions", "the same text saved twice is one note"],
    screens: ["/workspace/notes", "/artifacts", "/chat"],
  },
  {
    key: "journal", label: "Journal entry",
    stores: ["journal_entries", "preferences:versions:journal:<id>"],
    routes: [/^\/api\/journal/, /^\/api\/workspace\/journal/],
    tools: [/journal/],
    derived: [
      D("mood (picked or detected)", "shared/mood-detect.ts detectMoodFromText", "/journal", "/wellness"),
      D("title", "server/content-title.ts", "/journal"),
      D("energy / stress trends", "shared/journal-feelings.ts", "Journal workspace Trends"),
      D("journal streak", "server /api/stats", "/dashboard"),
    ],
    dependents: ["several entries a day; a save never overwrites another entry (J1)"],
    screens: ["/journal", "/workspace/journal", "/wellness", "/chat"],
  },
  {
    key: "artifact", label: "Artifact (checklist, report, document, sheet)",
    stores: ["artifacts", "chat_artifacts", "preferences:versions:document:<id>"],
    routes: [/^\/api\/artifacts/, /^\/api\/chat-artifacts/, /^\/api\/public\/artifacts/, /^\/api\/workspace\/(document|versions)/],
    tools: [/artifact/, /^generate_(chart|table|report)$/],
    derived: [D("counts by kind (one filter pipeline)", "client/src/pages/artifacts.tsx", "/artifacts"), D("public view-only copy", "server share route", "/share/:token")],
    dependents: ["a duplicate is independent of its original", "turning sharing off kills the link"],
    screens: ["/artifacts", "/editor/:id", "/workspace/word", "/share/:token", "/chat"],
  },
  {
    key: "detail", label: "Characteristic (record detail)",
    stores: ["preferences:detail_definitions", "preferences:details:<type>:<id>"],
    routes: [/^\/api\/details/],
    tools: [/record_detail/, /records_by_detail/],
    derived: [D("flags and report filters (one comparison)", "shared/record-details.ts matchesDetail / evaluateDetailRules", "/details", "record pages")],
    dependents: ["one definition per name across records", "deleting a record deletes its values", "deleting a definition deletes every value under it"],
    screens: ["/details", "/profiles/:id/:tab", "/documents/:id"],
  },
  {
    key: "dashboard", label: "Dashboards, alerts and preferences",
    stores: ["preferences (exec_card_prefs, wellness_card_prefs, dismissed_notifications, alert snoozes, workspace_ai_access)", "user_notifications"],
    routes: [/^\/api\/notifications/, /^\/api\/preferences/, /^\/api\/exec-widgets/, /^\/api\/dashboard/, /^\/api\/stats/, /^\/api\/insights/, /^\/api\/weekly-review/, /^\/api\/ai-digest/, /^\/api\/activity/, /^\/api\/onboarding/, /^\/api\/audit-log/],
    tools: [/dashboard/, /notification/],
    derived: [
      D("Next Important", "shared/next-important.ts pickNextImportant", "/dashboard"),
      D("briefing facts the AI summary is held to", "shared/dashboard-briefing.ts", "/dashboard"),
      D("dismissed alerts (one store, restorable)", "shared/alert-ids.ts · useDismissedAlerts", "bell", "/dashboard"),
    ],
    dependents: ["a layout is one preference row; opening Customize writes nothing"],
    screens: ["/dashboard", "/wellness", "/settings"],
  },
  {
    key: "memory", label: "AI memory",
    stores: ["memories", "preferences:ai_memory:<app>"],
    routes: [/^\/api\/memories/, /^\/api\/workspace\/memory/],
    tools: [/memory/],
    derived: [],
    dependents: ["a memory belongs to its assistant; forgetting wins over a reply in flight (WA13)"],
    screens: ["/chat", "/workspace/journal", "/workspace/notes", "/settings"],
  },
  {
    key: "profile", label: "Person, pet or provider profile",
    stores: ["profiles", "entity_links", "domains / domain_entries"],
    routes: [/^\/api\/profiles/, /^\/api\/profile-types/, /^\/api\/profile-bootstrap/, /^\/api\/relationships/, /^\/api\/entity-links/, /^\/api\/enrich/],
    tools: [/profile/, /relationship/, /domain/, /^link_entities$/, /^get_related$/, /^get_entity_history$/, /^find_(duplicates|orphans)$/, /^repair_/, /^refresh_ai_summary$/],
    derived: [
      D("profile scope (who a list is for)", "shared/profile-filter.ts · shared/scope.ts", "every list"),
      D("age from the birthday", "client/src/lib/profile-fields.ts", "profile Info"),
      D("AI summary (stale when its fingerprint changes)", "shared/profile-summary-fingerprint.ts", "profile page"),
    ],
    dependents: ["deleting a person: sole-owned records go, shared ones drop the owner, ownership shares return, budgets and characteristic values are removed", "a failed cascade keeps the profile (Rule 9)", "a name in chat is not permission to create a profile (Rule 13)"],
    screens: ["/profiles", "/profiles/:id/info", "/profiles/:id/:tab"],
  },
  {
    key: "chat", label: "AI chat & search",
    stores: ["ai_chat_runs", "ai_action_log", "ai_bulk_plans"],
    routes: [/^\/api\/chat/, /^\/api\/ai(\/|-)/, /^\/api\/search/],
    tools: [/^search$/, /^get_summary$/, /^navigate$/, /^recall_actions$/, /^undo_last_action$/, /bulk_action/],
    derived: [D("the confirmation line is read back from the saved record", "server/ai-engine.ts verifyProfileWrite · shared/payment-receipt.ts", "/chat")],
    dependents: ["a read-only turn writes nothing", "undo reverses the last recorded action"],
    screens: ["/chat"],
  },
  {
    key: "access", label: "Account, sign-in, export / import",
    stores: ["auth.users", "auth_rate_limits", "every table (export / delete all)"],
    routes: [/^\/api\/auth/, /^\/api\/export/, /^\/api\/import/, /^\/api\/data/],
    tools: [],
    derived: [],
    dependents: ["DELETE /api/data/all removes every row of the account"],
    screens: ["/settings", "/reset-password"],
  },
  {
    key: "system", label: "System (cron, diagnostics, warm-up)", system: true,
    stores: [], routes: [/^\/api\/(cron|warmup|version|diagnostics|client-errors|cleanup|admin)/], tools: [], derived: [], dependents: [], screens: [],
  },
];

export function entityOfRoute(path: string): EntityModel | null {
  return MODEL.find((e) => e.routes.some((re) => re.test(path))) ?? null;
}
export function entityOfTool(name: string): EntityModel | null {
  return MODEL.find((e) => e.tools.some((re) => re.test(name))) ?? null;
}

/** POST routes that answer or propose and store nothing the person owns (W5, WA3). */
const READONLY_POST = /\/workspace\/(document|notes|journal)\/|\/finance-import\/(preview|prompt)|\/smart-fill\/|\/receipt-extract|\/ai-transform|\/ai\/summary|\/search\/ai|\/wellness\/insights|\/lookup-value|\/calendar\/export|\/send-email|\/auth\/|\/client-errors|\/audit-log|\/weekly-review/;

/** The profile routes and tools that are also the doors of every profile-backed record. */
export const PROFILE_DOORS: Record<"create" | "edit" | "delete", { routes: string[]; tools: string[] }> = {
  create: { routes: ["POST /api/profiles"], tools: ["create_profile"] },
  edit: { routes: ["PATCH /api/profiles/:id"], tools: ["update_profile"] },
  delete: { routes: ["DELETE /api/profiles/:id"], tools: ["delete_profile"] },
};

/** What a route does, from its method and path. */
export function operationOfRoute(method: string, path: string): Operation | "read" {
  if (method === "GET") return "read";
  if (method === "POST" && READONLY_POST.test(path)) return "read";
  const p = path.toLowerCase();
  if (/\/restore(\/|$)|\/unarchive/.test(p)) return "restore";
  if (/\/duplicate|\/copy$/.test(p)) return "duplicate";
  if (/\/purge|\/archive|\/series-flag|\/data\/all|\/disconnect/.test(p)) return "archive";
  if (/\/share$/.test(p)) return method === "DELETE" ? "cancel" : "transfer";
  if (/\/skip|\/pause|\/resume|\/undo|\/last-payment|\/checkin\/:|\/dismiss|\/cancel|\/signout|\/status$|\/conversation$/.test(p)) return "cancel";
  if (/\/occurrence$|\/reschedule|\/schedule$|\/series-settings|\/occurrences\/:[^/]+$|\/sync$|\/materialize/.test(p)) return method === "DELETE" ? "delete" : "reschedule";
  if (/\/pay$|\/payments$|\/checkin$|\/toggle\/|\/confirm|\/mark$|\/autopay\/run|\/reconcile|\/complete/.test(p) && method !== "DELETE") return "complete";
  if (/owners$|\/move-|\/link$|\/unlink$|party-links|profile-links|asset-links|entity-links|\/transfers\//.test(p)) return method === "DELETE" ? "cancel" : "transfer";
  if (method === "DELETE") return "delete";
  if (method === "PATCH" || method === "PUT") return "edit";
  if (/\/adjust$|\/rescale|\/autopay$|\/charges$|\/photo$|\/remember$/.test(p)) return "edit";
  return "create";
}

/** What a chat tool does, from its name. `null` = it only reads. */
export function operationOfTool(name: string): Operation | null {
  if (/^(get_|query_|search|read_|recall_|find_|generate_|explain_|validate_|retrieve_|open_|navigate$|preview_)/.test(name)) return null;
  if (/^restore_/.test(name)) return "restore";
  if (/^duplicate_|^copy_/.test(name)) return "duplicate";
  if (/^(undo_|uncomplete_|skip_|refund_|dismiss_|unlink_)/.test(name)) return "cancel";
  if (/^(complete_|bulk_complete|checkin_|pay_|mark_|confirm_|toggle_)/.test(name)) return "complete";
  if (/^(link_|move_|split_|merge_|convert_)/.test(name)) return "transfer";
  if (/^(schedule_|sync_)/.test(name)) return "reschedule";
  if (/^delete_/.test(name)) return "delete";
  if (/^(update_|revalue_|configure_|set_|refresh_|repair_|manage_|execute_)/.test(name)) return "edit";
  return "create";
}

/** A scenario's `covers` key, in the matrix's terms. */
const ENTITY_ALIAS: Record<string, string> = { alert: "dashboard" };
const OP_ALIAS: Record<string, Operation> = {
  pay: "complete", checkin: "complete", autopay: "complete",
  unpay: "cancel", uncheck: "cancel", skip: "cancel", pause: "cancel", unshare: "cancel", dismiss: "cancel",
  nest: "transfer", link: "transfer", share: "transfer",
  salvage: "edit", purge: "archive", restoreVersion: "restore",
};
/** Keys that name a cross-cutting property, not a record operation. */
export const CROSS_CUTTING: Record<string, string> = {
  "isolation.read": "another account cannot read this account's records",
  "isolation.write": "another account cannot change or delete them",
  "isolation.database": "row-level security holds in the database itself",
  "chat.readonly": "a question or a withdrawn request writes nothing",
  "screens.open": "every main screen opens on desktop and phone",
};
export interface CoverKey { entity: string; op: Operation; door: Door }
export function parseCoverKey(key: string): CoverKey | "cross-cutting" | null {
  if (key in CROSS_CUTTING) return "cross-cutting";
  const [e, o, d] = key.split(".");
  const entity = ENTITY_ALIAS[e] ?? e;
  const op = (OP_ALIAS[o] ?? o) as Operation;
  if (!MODEL.some((m) => m.key === entity) || !OPERATIONS.includes(op) || !["ui", "api", "chat"].includes(d)) return null;
  return { entity, op, door: d as Door };
}
