/**
 * Live sweep of EVERY chat tool — one natural-language command per tool in
 * TOOL_DEFINITIONS, sent through the same streaming endpoint the app uses
 * (POST /api/chat?stream=1), against the smoke account.
 *
 * For each tool it records, from the real response:
 *   · invoked   — the expected tool appears in the stream's tool_start frames
 *   · backend   — its tool_result frame is ok, and (writes) the envelope's
 *                 read-after-write verification says the record exists
 *   · display   — what the chat page is given to render: a typed action the
 *                 page has a card for, or a chart / table / report / document
 *                 preview / scope directive, plus a non-empty reply
 *   · timing    — ms to the ack frame, to the first visible progress (tool
 *                 label or text), and to the final frame
 *
 * A tool with no step fails the run before anything is sent, so a new tool
 * cannot be added without a command that exercises it.
 *
 * Costs Anthropic credits; NOT part of CI. Run on demand:
 *   npx tsx scripts/verify-all-chat-tools.ts                    # everything
 *   npx tsx scripts/verify-all-chat-tools.ts --only=navigate,search
 *   npx tsx scripts/verify-all-chat-tools.ts --out=/tmp/sweep   # results dir
 *   npx tsx scripts/verify-all-chat-tools.ts --steps=steps.json # your own steps
 *       ([{ "tool": "delete_task", "message": "Delete the task {T} Chore", "confirm": "yes" }];
 *        {T} is replaced by the run's tag, "tool": "" marks a fixture step)
 * Everything the run creates is deleted afterwards (any row whose id was not
 * in the account before the run started).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { api, getSmokeToken } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";
import { TOOL_DEFINITIONS, TOOL_ACTION_MAP, READ_ONLY_TOOLS } from "../server/ai-engine";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const OUT_DIR = arg("out") || path.join(os.tmpdir(), "chat-tool-sweep");
// Short alphabetic tag: every record the sweep names carries it, so a command
// can never match one of the account's own fixture rows.
const T = arg("tag") || `Zq${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4)}`;

/** What the chat page must be handed for this tool's outcome to be visible. */
type Display = "card" | "chart" | "table" | "report" | "document" | "scope" | "navigate" | "reply";

type Step = {
  /** The tool this step exists to exercise ("" for a fixture-only step). */
  tool: string;
  message: string;
  /** Sent as a follow-up turn (with history) when the first turn asks to confirm. */
  confirm?: string;
  display?: Display;
  /** Sibling tools that legitimately do the same job for this phrasing. */
  also?: string[];
};

const s = (tool: string, message: string, extra: Partial<Step> = {}): Step => ({ tool, message, ...extra });
const YES = "yes";

const STEPS: Step[] = [
  // ── Profiles, assets, ownership ──
  s("create_profile", `Create a person profile named ${T} Alice`),
  s("update_profile", `Set ${T} Alice's phone number to 555-0100`),
  s("get_profile_data", `Show me everything on ${T} Alice's profile`),
  s("search", `Search all of my records for the word ${T} and list every match`),
  s("refresh_ai_summary", `Refresh the AI summary for ${T} Alice`),
  s("", `Create a person profile named ${T} Alicia`),
  s("merge_profiles", `Merge the profile ${T} Alicia into ${T} Alice`,
    { confirm: `Yes, I confirm — go ahead with the pending profile merge of ${T} Alicia into ${T} Alice.` }),
  s("", `Add a vehicle asset called ${T} Truck, a 2015 Ford F-150 worth $18,000`),
  s("", `Add a vehicle asset called ${T} Van worth $5,000`),
  s("revalue_asset", `Re-estimate the current market value of my ${T} Truck`),
  s("link_asset_owner", `${T} Truck belongs to ${T} Alice — make her the owner`),
  s("split_ownership", `Split ownership of ${T} Truck 50/50 between me and ${T} Alice`),
  s("get_asset_rollup", `Give me the asset rollup for ${T} Truck, including anything nested under it`),
  s("create_liability", `Add an auto loan called ${T} Loan with a balance of $9,000 at 5% APR and a $250 monthly payment`),
  s("update_liability", `Change ${T} Loan's interest rate to 4.5%`),
  s("link_liability_asset", `${T} Loan is the loan on ${T} Truck — link the loan to that asset`),
  s("get_liability_summary", `Summarize all my debts and liabilities`),
  s("get_loan_schedule", `Show me the amortization schedule for ${T} Loan`),
  s("add_liability_payment", `I made a $250 payment on ${T} Loan today`),
  s("update_liability_payment", `Change that last ${T} Loan payment amount to $260`),
  s("delete_liability_payment", `Delete the last payment I recorded on ${T} Loan`, { confirm: YES }),
  // Only loans with a generated schedule have one to mark; for the rest the
  // payment is recorded on the balance, which is the same outcome for the user.
  s("mark_loan_payment", `Mark this month's ${T} Loan payment as paid`, { also: ["add_liability_payment"] }),
  s("unlink_asset_from_liability", `Unlink ${T} Truck from ${T} Loan`, { confirm: YES }),
  s("link_asset_to_liability", `${T} Loan is secured by ${T} Truck — attach the truck to that loan as collateral`, { also: ["link_liability_asset"] }),
  s("move_liability_to_asset", `Move ${T} Loan from ${T} Truck to ${T} Van`),
  s("link_liability_owner", `${T} Loan is ${T} Alice's loan — set her as the borrower`),
  s("get_relationships", `What is ${T} Alice connected to? Show her relationships`),

  // ── Tasks ──
  s("create_task", `Add a task called ${T} Task due tomorrow`),
  s("update_task", `Change the ${T} Task task's priority to high`),
  s("query_tasks", `List my tasks due this week`),
  s("get_summary", `How many tasks do I have?`),
  s("explain_dashboard_item", `Why is ${T} Task showing on my dashboard?`),
  s("get_entity_history", `What's the change history of the task ${T} Task?`),
  s("complete_task", `Mark ${T} Task as done`),
  s("", `Add a task called ${T} Chore`),
  s("delete_task", `Delete the task ${T} Chore`, { confirm: YES }),
  s("restore_task", `Restore the ${T} Chore task I just deleted`),
  s("", `Add three tasks: ${T} Bulk one, ${T} Bulk two and ${T} Bulk three`),
  s("bulk_complete_tasks", `Bulk-complete every task whose title contains ${T} Bulk`, { confirm: YES, also: ["complete_task"] }),
  s("", `Add three tasks: ${T} Wipe one, ${T} Wipe two and ${T} Wipe three`),
  s("preview_bulk_action", `Delete all my tasks containing ${T} Wipe`),
  s("execute_bulk_action", `Yes, I confirm — go ahead with the pending bulk delete of my ${T} Wipe tasks from the preview.`),
  s("", `Add a task called ${T} Undo me`),
  s("undo_last_action", `Undo my last action`, { confirm: YES }),
  s("recall_actions", `What did I just do? Show my recent actions`),

  // ── Habits ──
  s("create_habit", `Create a daily habit called ${T} Stretch`),
  s("checkin_habit", `Mark the ${T} Stretch habit done for today`),
  s("uncomplete_habit", `Undo today's ${T} Stretch check-in — I didn't actually do it`),
  s("update_habit", `Change the ${T} Stretch habit to weekly`),
  s("delete_habit", `Delete the ${T} Stretch habit`, { confirm: YES }),
  s("restore_habit", `Restore the ${T} Stretch habit I just deleted`),

  // ── Trackers and medication ──
  s("create_tracker", `Create a tracker called ${T} Pushups to track reps`),
  s("log_tracker_entry", `Log 25 reps on my ${T} Pushups tracker`),
  s("update_tracker_entry", `Change my last ${T} Pushups entry to 30 reps`),
  s("delete_tracker_entry", `Delete my last ${T} Pushups entry`, { confirm: YES }),
  s("update_tracker", `Rename the ${T} Pushups tracker to ${T} Pushups Daily`),
  s("delete_tracker", `Delete the ${T} Pushups Daily tracker`, { confirm: YES }),
  s("", `Create a medication tracker called ${T} Lisinopril, 10mg twice daily`),
  s("log_medication_dose", `I took my ${T} Lisinopril this morning`),
  s("skip_medication_dose", `I skipped tonight's ${T} Lisinopril dose, felt nauseous`),
  s("get_missed_doses", `What ${T} Lisinopril doses did I miss this week?`),
  s("get_dose_history", `Show my ${T} Lisinopril dose history`),
  s("schedule_medication_refills", `Schedule refills for ${T} Lisinopril: 60 pills per fill, 2 refills, starting today, 2 pills a day`),

  // ── Money ──
  s("create_expense", `Log a $13.37 expense called ${T} Coffee`),
  s("update_expense", `Change the ${T} Coffee expense to $14.50`),
  s("query_expenses", `List my expenses from this month`),
  s("spending_analytics", `Analyze my spending this month by category`),
  s("refund_expense", `I got a full refund for the ${T} Coffee expense`),
  s("", `Log a $900 expense called ${T} Laptop`),
  s("convert_expense_to_asset", `Convert the ${T} Laptop expense into an asset`),
  s("delete_expense", `Delete the ${T} Coffee expense`, { confirm: YES }),
  s("log_income", `Add income of $137 from ${T} Freelance`),
  s("update_income", `Change the ${T} Freelance income to $150`),
  s("get_cashflow", `What's my cash flow this month?`),
  s("delete_income", `Delete the ${T} Freelance income`, { confirm: YES }),
  s("log_expected_paycheck", `I'm expecting a $2,000 paycheck from ${T} Employer on the 20th of this month`),
  s("confirm_paycheck_received", `Confirm that my expected paycheck from ${T} Employer was received today`),
  s("delete_paycheck", `Delete the ${T} Employer paycheck`, { confirm: YES }),
  s("create_budget", `Create a budget of $123 for education this month`),
  s("update_budget", `Update my education budget for this month to $150`, { also: ["set_budget"] }),
  s("set_budget", `Set my transport budget to $321 for this month`, { also: ["create_budget"] }),
  s("get_budget_summary", `How am I doing against my budgets this month?`),
  s("delete_budget", `Delete my transport budget for this month`, { confirm: YES }),
  s("copy_budgets_previous_month", `Copy last month's budgets into this month`),
  s("query_net_worth_history", `How has my net worth changed over the last 6 months?`),
  s("create_account", `Add a checking account called ${T} Checking with a balance of $1,200`),
  s("update_account_balance", `Update ${T} Checking's balance to $1,350`),
  s("get_accounts", `List my accounts and their balances`),
  s("get_financial_summary", `Give me the overall financial summary from my connected bank data`, { also: ["get_account_balances"] }),
  s("get_account_balances", `What are the balances of my connected bank accounts?`),
  s("search_financial_transactions", `Search my connected bank transactions for Starbucks`),
  s("get_spending_breakdown", `Break down my connected bank spending by category for the last 30 days`),
  s("refresh_financial_data", `Refresh my connected bank data now — yes, I confirm`),

  // ── Bills ──
  s("create_obligation", `Add a monthly bill called ${T} Internet for $42 due on the 15th`),
  s("update_obligation", `Change the ${T} Internet bill to $45 a month`),
  s("sync_date_rules_for_entity", `Re-sync the date rules for the ${T} Internet bill`),
  s("add_liability_charge", `Add a $12 charge to this month's ${T} Internet bill`),
  s("set_liability_amount", `This month's ${T} Internet bill came to $51.20`),
  s("pay_obligation", `Pay the ${T} Internet bill`),
  s("undo_last_payment", `Undo the last payment on the ${T} Internet bill`, { confirm: YES }),
  s("delete_obligation", `Delete the ${T} Internet bill`, { confirm: YES }),

  // ── Calendar ──
  s("create_event", `Add a calendar event called ${T} Dentist for tomorrow at 3pm`),
  s("update_event", `Move the ${T} Dentist event to 4pm`),
  s("query_calendar", `What's on my calendar this week?`),
  s("complete_event", `Mark the ${T} Dentist event as completed`),
  s("delete_event", `Delete the ${T} Dentist event`, { confirm: YES }),
  s("sync_calendar", `Sync my calendar`),

  // ── Journal, notes, artifacts, memory ──
  s("journal_entry", `Journal entry: ${T} felt great today, productive morning`),
  s("append_journal_entry", `Add to today's journal: ${T} also went for a long walk`),
  s("update_journal", `Change today's journal entry mood to okay`),
  s("delete_journal", `Delete my journal entry for today`, { confirm: YES }),
  s("create_note", `Make a note called ${T} Note: living room paint color is OC-17`),
  s("search_notes", `Find my note about the living room paint color`),
  s("update_note", `Update the ${T} Note note to say the paint color is OC-45`),
  s("delete_note", `Delete my note titled ${T} Note`, { confirm: YES }),
  s("create_artifact", `Create a checklist called ${T} Packing with items: passport, charger, socks`),
  s("toggle_artifact_item", `Check off passport on the ${T} Packing checklist`),
  s("update_artifact", `Add toothbrush to the ${T} Packing checklist`),
  s("duplicate_artifact", `Duplicate the ${T} Packing checklist`),
  s("delete_artifact", `Delete my checklist titled ${T} Packing — the original one`, { confirm: YES }),
  s("save_memory", `Remember that my ${T} locker code is 4421`),
  // Saved memories ride in the model's context, so it may simply answer.
  s("recall_memory", `Use your saved memories to look up what you know about my ${T} locker`),
  s("update_memory", `Update that memory: my ${T} locker code is now 9876`),
  s("delete_memory", `Forget my ${T} locker code`, { confirm: YES }),

  // ── Documents ──
  s("create_document", `Create a document record called ${T} Warranty for my fridge warranty`),
  s("search_documents", `Search my documents for anything about a warranty and list the matches`, { also: ["retrieve_document"] }),
  s("retrieve_document", `What does my ${T} Warranty document say? Read me its details`, { also: ["search_documents"] }),
  s("open_document", `Open my ${T} Warranty document`, { display: "document" }),
  s("link_document", `Link the ${T} Warranty document to ${T} Alice`),
  s("manage_document", `Rename the ${T} Warranty document to ${T} Warranty 2026`),
  s("upload_document", `I want to upload a document — set that up for me`),

  // ── Goals and custom domains ──
  s("create_goal", `Create a savings goal called ${T} Fund to save $1000`),
  s("get_goal_progress", `How am I doing on my ${T} Fund goal?`),
  s("update_goal", `Raise the ${T} Fund goal target to $1500`),
  s("link_entities", `Link the task ${T} Task and the goal ${T} Fund as related entities`),
  s("get_related", `Using the entity links, what records are related to the goal ${T} Fund?`, { also: ["get_relationships"] }),
  s("delete_goal", `Delete the ${T} Fund goal`, { confirm: YES }),
  s("create_domain", `Create a custom domain called ${T} Garden with fields plant name and planted date`),
  s("update_domain", `Add a watering schedule field to the ${T} Garden domain`),
  s("delete_domain", `Delete the ${T} Garden domain`, { confirm: YES }),

  // ── Notifications ──
  s("create_notification", `Create an urgent notification: ${T} insurance renewal needs attention`),
  s("mark_notifications_read", `Mark the ${T} insurance renewal notification as read`),
  s("dismiss_notifications", `Dismiss the ${T} insurance renewal notification`),
  s("set_notification_preferences", `Mute info notifications`),
  s("", `Unmute all my notifications`),

  // ── Things the page renders or does, rather than writes ──
  s("generate_chart", `Show me a bar chart of my expenses by category`, { display: "chart" }),
  s("generate_table", `Make a table of all my tasks with title and due date`, { display: "table" }),
  s("generate_report", `Give me a weekly report`, { display: "report" }),
  s("navigate", `Go to the trackers page`, { display: "navigate" }),
  s("set_dashboard_scope", `Show me ${T} Alice's dashboard only`, { display: "scope" }),
  s("", `Switch the dashboard back to Everyone`, { display: "scope" }),
  s("configure_dashboard_sections", `Show the Weekly Summary section on my dashboard`),
  s("", `Hide the Weekly Summary section on my dashboard again`),

  // ── System diagnostics ──
  s("find_orphans", `Check my data for orphaned records`),
  s("find_duplicates", `Do I have any duplicate expenses?`),
  s("validate_profile_isolation", `Validate that each profile's data is isolated correctly`),
  s("validate_dashboard_counts", `Validate that my dashboard counts match the underlying records`),
  s("refresh_dashboard", `Refresh my dashboard — the counts look stale`),
  s("repair_relations", `Repair any broken relations in my data — yes, I confirm`),
  s("repair_profile_types", `Check for profiles with the wrong type and repair them`),

  // ── Last: the destructive profile delete ──
  s("delete_profile", `Delete the profile ${T} Van`, { confirm: `Yes, I confirm — permanently delete the profile ${T} Van.` }),
];

// The action types the chat page renders a card for (client/src/pages/chat.tsx).
function cardTypes(): Set<string> {
  const src = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/chat.tsx"), "utf8");
  const m = src.match(/\.filter\(a => \[([\s\S]*?)\]\.includes\(a\.type\)\)/);
  if (!m) throw new Error("could not find the action-card type list in chat.tsx");
  return new Set(Array.from(m[1].matchAll(/'([a-z_]+)'/g)).map((x) => x[1]));
}

type TurnResult = {
  status: number;
  ackMs: number | null;
  firstProgressMs: number | null;
  totalMs: number;
  toolsStarted: string[];
  toolResults: Array<{ tool: string; ok: boolean; error?: string }>;
  final: any;
  error?: string;
};

let lastStart = 0;
async function chatTurn(message: string, history?: Array<{ role: string; content: string }>): Promise<TurnResult> {
  // 20 chat calls a minute per user.
  const wait = lastStart + 3300 - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; ; attempt++) {
    lastStart = Date.now();
    const t0 = Date.now();
    const out: TurnResult = { status: 0, ackMs: null, firstProgressMs: null, totalMs: 0, toolsStarted: [], toolResults: [], final: null };
    const res = await fetch(`${API_BASE}/chat?stream=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${await getSmokeToken()}`,
        "X-Timezone": "America/New_York",
      },
      body: JSON.stringify(history ? { message, history } : { message }),
    });
    out.status = res.status;
    if (res.status === 429 && attempt < 3) { await sleep(8000 * (attempt + 1)); continue; }
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.includes("text/event-stream") || !res.body) {
      const text = await res.text();
      try { out.final = JSON.parse(text); } catch { out.error = text.slice(0, 300); }
      if (!res.ok) out.error = out.error || JSON.stringify(out.final).slice(0, 300);
      out.totalMs = Date.now() - t0;
      return out;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const progress = () => { if (out.firstProgressMs == null) out.firstProgressMs = Date.now() - t0; };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        let parsed: any;
        try { parsed = JSON.parse(data.join("\n")); } catch { continue; }
        if (event === "ack") out.ackMs = Date.now() - t0;
        else if (event === "assistant_delta") progress();
        else if (event === "tool_start") { progress(); out.toolsStarted.push(String(parsed?.tool || "")); }
        else if (event === "tool_result") out.toolResults.push({ tool: String(parsed?.tool || ""), ok: !!parsed?.ok, error: parsed?.error });
        else if (event === "final") out.final = parsed;
        else if (event === "error") out.error = `${parsed?.status || 500}: ${parsed?.error || "stream error"}`;
      }
    }
    out.totalMs = Date.now() - t0;
    if (!out.final && !out.error) out.error = "stream ended without a final frame";
    return out;
  }
}

function trimFinal(final: any): any {
  if (!final || typeof final !== "object") return final;
  const strip = (p: any) => (p && typeof p === "object" && typeof p.data === "string" && p.data.length > 200 ? { ...p, data: `[${p.data.length} chars]` } : p);
  return {
    ...final,
    documentPreview: strip(final.documentPreview),
    documentPreviews: Array.isArray(final.documentPreviews) ? final.documentPreviews.map(strip) : final.documentPreviews,
  };
}

async function rows(ep: string): Promise<any[]> {
  const r = await api("GET", ep);
  const d: any = r.data;
  return Array.isArray(d) ? d : (d?.items || d?.budgets || d?.goals || []);
}

const CLEANUP_ENDPOINTS = ["/incomes", "/paychecks", "/memories", "/tasks", "/habits", "/events", "/expenses",
  "/obligations", "/artifacts", "/goals", "/trackers", "/journal", "/documents", "/profiles"];
const month = new Date().toISOString().slice(0, 7);

(async () => {
  const toolNames = (TOOL_DEFINITIONS as any[]).map((t) => t.name as string);
  const covered = new Set(STEPS.map((x) => x.tool).filter(Boolean));
  const uncovered = toolNames.filter((n) => !covered.has(n));
  const unknown = [...covered].filter((n) => !toolNames.includes(n));
  if (uncovered.length || unknown.length) {
    console.error(`Sweep is out of step with the registry.\n  tools with no step: ${uncovered.join(", ") || "-"}\n  steps for tools that do not exist: ${unknown.join(", ") || "-"}`);
    process.exit(2);
  }
  const cards = cardTypes();
  const only = arg("only")?.split(",");
  const custom: Step[] | null = arg("steps")
    ? JSON.parse(fs.readFileSync(arg("steps")!, "utf8").replace(/\{T\}/g, T))
    : null;
  const steps = custom || (only ? STEPS.filter((x) => only.includes(x.tool)) : STEPS);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFile = path.join(OUT_DIR, "results.jsonl");
  fs.writeFileSync(logFile, "");

  const version = (await api("GET", "/version")).data?.sha;
  console.log(`\n── Chat tool sweep (${T}) — ${steps.length} step(s), ${toolNames.length} tools, ${API_BASE} @ ${String(version).slice(0, 8)} ──\n`);

  // Everything present before the run is off limits to cleanup.
  const before: Record<string, Set<string>> = {};
  for (const ep of [...CLEANUP_ENDPOINTS, `/budgets?month=${month}`]) {
    try { before[ep] = new Set((await rows(ep)).map((r) => String(r.id))); } catch { before[ep] = new Set(); }
  }

  for (const step of steps) {
    let turn: TurnResult;
    let confirmed = false;
    try {
      turn = await chatTurn(step.message);
      const reply1 = String(turn.final?.reply || "");
      const ran = step.tool ? turn.toolsStarted.includes(step.tool) : true;
      // Answer "are you sure?" only when the question is about a record this
      // run made. A blind yes once agreed to delete a look-alike fixture row
      // the assistant offered in place of one that no longer existed.
      const asksAboutOurs = reply1.includes(T) || !step.message.includes(T);
      if (!ran && step.confirm && asksAboutOurs && /\?|confirm|are you sure|go ahead|proceed/i.test(reply1)) {
        const second = await chatTurn(step.confirm, [{ role: "user", content: step.message }, { role: "assistant", content: reply1 }]);
        confirmed = true;
        turn = { ...second, toolsStarted: [...turn.toolsStarted, ...second.toolsStarted], toolResults: [...turn.toolResults, ...second.toolResults], totalMs: turn.totalMs + second.totalMs, ackMs: turn.ackMs, firstProgressMs: turn.firstProgressMs };
      } else if (step.tool === "merge_profiles" && step.confirm) {
        // The first turn is the preview; the confirm turn performs the merge.
        const second = await chatTurn(step.confirm, [{ role: "user", content: step.message }, { role: "assistant", content: reply1 }]);
        confirmed = true;
        turn = { ...second, toolsStarted: [...turn.toolsStarted, ...second.toolsStarted], toolResults: [...turn.toolResults, ...second.toolResults], totalMs: turn.totalMs + second.totalMs, ackMs: turn.ackMs, firstProgressMs: turn.firstProgressMs };
      }
    } catch (e: any) {
      turn = { status: 0, ackMs: null, firstProgressMs: null, totalMs: 0, toolsStarted: [], toolResults: [], final: null, error: String(e?.message || e) };
    }

    const final = turn.final || {};
    const reply = String(final.reply || "");
    const actions: any[] = Array.isArray(final.actions) ? final.actions : [];
    const results: any[] = Array.isArray(final.results) ? final.results : [];
    const invoked = step.tool ? turn.toolsStarted.includes(step.tool) : null;
    const toolOk = step.tool ? turn.toolResults.some((r) => r.tool === step.tool && r.ok) : null;
    // The job was done by a sibling tool, or by a deterministic lane that
    // answers without the model (no tool frames at all, the outcome is shown).
    const sibling = (step.also || []).find((t) => turn.toolResults.some((r) => r.tool === t && r.ok)) || null;
    const lane = !!step.tool && turn.toolsStarted.length === 0 && turn.status === 200 && (final?.meta?.timings?.tools?.length ?? 0) === 0 && actions.length > 0;
    const toolErr = turn.toolResults.filter((r) => !r.ok).map((r) => `${r.tool}: ${r.error || "failed"}`);
    const isWrite = !!step.tool && !READ_ONLY_TOOLS.has(step.tool);
    const expectedAction = isWrite ? TOOL_ACTION_MAP[step.tool] : null;
    const siblingAction = sibling && !READ_ONLY_TOOLS.has(sibling) ? TOOL_ACTION_MAP[sibling] : null;
    const display: Display = step.display || (isWrite && expectedAction && cards.has(expectedAction) ? "card" : "reply");
    const verification = results.map((r) => r?.verification).filter(Boolean);
    const shown =
      display === "card" ? actions.some((a) => a?.type === expectedAction || (siblingAction && a?.type === siblingAction))
      : display === "chart" ? (final.charts?.length ?? 0) > 0
      : display === "table" ? (final.tables?.length ?? 0) > 0
      : display === "report" ? !!final.report
      : display === "document" ? !!final.documentPreview || (final.documentPreviews?.length ?? 0) > 0
      : display === "scope" ? !!final.scope
      : display === "navigate" ? results.some((r) => r?.navigateTo)
      : reply.trim().length > 0;

    const rec = {
      tool: step.tool || "(fixture)",
      message: step.message,
      confirmed,
      status: turn.status,
      error: turn.error,
      invoked,
      toolOk,
      via: invoked && toolOk ? "tool" : sibling ? `sibling:${sibling}` : lane ? "lane" : null,
      toolErrors: toolErr,
      toolsStarted: turn.toolsStarted,
      kind: step.tool ? (isWrite ? "write" : "read") : "fixture",
      display,
      shown,
      hasReply: reply.trim().length > 0,
      actionTypes: actions.map((a) => a?.type),
      mutations: Array.isArray(final.mutations) ? final.mutations.length : 0,
      verification,
      ackMs: turn.ackMs,
      firstProgressMs: turn.firstProgressMs,
      totalMs: turn.totalMs,
      serverMs: final?.meta?.timings?.engineMs ?? null,
      reply: reply.slice(0, 400),
      final: trimFinal(final),
    };
    fs.appendFileSync(logFile, JSON.stringify(rec) + "\n");
    const ok = turn.status === 200 && !turn.error && rec.hasReply && (step.tool ? !!rec.via && shown : true);
    console.log(`${ok ? "PASS" : "FAIL"} ${rec.tool.padEnd(30)} ${String(turn.totalMs).padStart(6)}ms first=${String(turn.firstProgressMs ?? "-").padStart(5)}ms tools=[${turn.toolsStarted.join(",")}]${rec.via && rec.via !== "tool" ? ` via ${rec.via}` : ""} ${ok ? "" : `invoked=${invoked} toolOk=${toolOk} shown(${display})=${shown} ${turn.error || toolErr.join("; ") || reply.slice(0, 140).replace(/\n/g, " ")}`}`);
  }

  // ── Cleanup: delete every row that did not exist before the run ──
  let removed = 0;
  for (const ep of CLEANUP_ENDPOINTS) {
    try {
      for (const row of await rows(ep)) {
        if (before[ep].has(String(row.id))) continue;
        const r = await api("DELETE", `${ep}/${row.id}`);
        if (r.ok) removed++; else console.log(`cleanup: DELETE ${ep}/${row.id} → ${r.status}`);
      }
    } catch (e: any) { console.log(`cleanup: ${ep} ${e?.message || e}`); }
  }
  try {
    for (const b of await rows(`/budgets?month=${month}`)) {
      if (before[`/budgets?month=${month}`].has(String(b.id))) continue;
      const r = await api("DELETE", `/budgets/${b.id}?month=${month}`);
      if (r.ok) removed++;
    }
  } catch { /* budgets are best effort */ }
  console.log(`\ncleanup: removed ${removed} row(s) created by the sweep. Results: ${logFile}\n`);
})();
