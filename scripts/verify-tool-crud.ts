/**
 * Live per-TOOL CRUD verification for the AI chat — the "test every addition"
 * loop of the 2026-07 CRUD-parity effort. For each newly added tool: seed a
 * fixture via REST, send a natural-language command to the REAL /api/chat,
 * then GET + marker-match to prove the write landed. Cleans up by TAG.
 *
 * Complements (does not replace) scripts/verify-dashboard-commands.ts and
 * tests/audit/verify-ai.ts. Uses the smoke account; costs Anthropic credits.
 * NOT part of default CI — run on demand:
 *   npx tsx scripts/verify-tool-crud.ts                 # all batches
 *   npx tsx scripts/verify-tool-crud.ts --batch=A       # one batch
 *   npx tsx scripts/verify-tool-crud.ts --only=delete_income
 *   npx tsx scripts/verify-tool-crud.ts --sha=<commit>  # wait for deploy first
 * Throttled ~3.6s per chat call to stay under the 20/min chat rate limit.
 */
import { api } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `CRUD_${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const prevMonth = (() => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
})();

type Step = {
  batch: string;
  tool: string;
  message: string;
  /** Seed fixture rows this step acts on. Runs once, before the chat call. */
  seed?: () => Promise<void>;
  /** Return true when the intended effect is observable via the API. */
  verify: () => Promise<boolean>;
  /** More explicit phrasing to retry with when the first phrasing fails routing. */
  retryMessage?: string;
  /** Optional additional assertion on the assistant's reply text. */
  verifyReply?: (reply: string) => boolean;
};

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  return Array.isArray(r.data) ? r.data : (r.data?.items || []);
}

/** Seed writes must actually land — retry once on 429, throw on other errors
 *  so a step fails loudly at seed time instead of mysteriously at verify. */
async function seedPost(path: string, body: any): Promise<any> {
  let r = await api("POST", path, body);
  if (r.status === 429) { await sleep(6500); r = await api("POST", path, body); }
  if (!r.ok) throw new Error(`seed POST ${path} failed: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return r.data;
}

// ── Deploy wait: poll /api/version until `sha` matches the pushed commit ──
async function waitForDeploy(sha: string): Promise<void> {
  const deadline = Date.now() + 6 * 60_000;
  process.stdout.write(`Waiting for deploy ${sha.slice(0, 8)} at ${API_BASE} `);
  while (Date.now() < deadline) {
    try {
      const r = await api("GET", "/version");
      const live = String(r.data?.sha || "");
      if (live.startsWith(sha) || sha.startsWith(live) && live.length >= 8) {
        console.log(`— live (${live.slice(0, 8)})`);
        return;
      }
    } catch { /* transient */ }
    process.stdout.write(".");
    await sleep(10_000);
  }
  console.log("");
  throw new Error(`Deploy ${sha.slice(0, 8)} not live after 6 min — is the branch merged to main?`);
}

// Cross-step state for the Batch 5 merge flow (steps run in order).
let mergeSrcId = "";
let mergeTgtId = "";

const STEPS: Step[] = [
  // ── Batch 1 (MCP-grade) — envelope + verification ──────────────────────────
  {
    batch: "1", tool: "envelope (create verified)",
    message: `Add a task called ${TAG}_env smoke test due tomorrow`,
    verify: async () => (await list("/tasks")).some((t) => (t.title || "").includes(`${TAG}_env`)),
  },
  {
    batch: "1", tool: "envelope (duplicate_count surfaced)",
    // Same-NAME expense with a DIFFERENT amount: create_expense's 2-minute
    // dedup only fires on equal amounts, so this second create really lands,
    // and the envelope's duplicate_count (normalized-name match) is 1 — the
    // reply must mention the existing similar entry without blocking the save.
    seed: async () => { await seedPost("/expenses", { description: `${TAG}_dupexp coffee`, amount: 6.75, category: "food" }); },
    message: `Add a $5.50 expense called ${TAG}_dupexp coffee`,
    verify: async () => (await list("/expenses")).filter((e) => (e.description || "").includes(`${TAG}_dupexp`)).length >= 2,
    verifyReply: (reply) => /similar|duplicate|already|second|another/i.test(reply),
  },

  // ── Batch 2 (MCP-grade) — action ledger + undo ─────────────────────────────
  {
    batch: "2", tool: "undo_last_action (create→delete)",
    message: `Log a $12 expense called ${TAG}_undoexp coffee`,
    verify: async () => (await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_undoexp`)),
  },
  {
    batch: "2", tool: "undo_last_action (executes)",
    message: `Undo that last expense`,
    retryMessage: `Undo my last action — the ${TAG}_undoexp expense`,
    verify: async () => !(await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_undoexp`)),
  },
  {
    batch: "2", tool: "get_entity_history",
    seed: async () => { await seedPost("/tasks", { title: `${TAG}_histtask review docs` }); },
    message: `What's the change history of the task ${TAG}_histtask review docs?`,
    // History for a REST-seeded task may be empty (ledger records chat actions;
    // audit_log records creates) — the check is that the tool answers with a
    // history/no-changes response rather than an error or a guess.
    verify: async () => true,
    verifyReply: (reply) => /history|change|created|no recorded/i.test(reply),
  },

  // ── Batch 3 (MCP-grade) — bulk preview → confirm → execute ─────────────────
  {
    batch: "3", tool: "bulk preview (no deletes yet)",
    seed: async () => {
      await seedPost("/tasks", { title: `${TAG}_bulk one` });
      await seedPost("/tasks", { title: `${TAG}_bulk two` });
      await seedPost("/tasks", { title: `${TAG}_bulk three` });
    },
    message: `Delete all my tasks containing ${TAG}_bulk`,
    // Preview turn: NOTHING deleted yet, reply relays counts + asks to confirm.
    verify: async () => (await list("/tasks")).filter((t) => (t.title || "").includes(`${TAG}_bulk`)).length === 3,
    verifyReply: (reply) => /3\s|three/i.test(reply) && /confirm|proceed|sure|go ahead/i.test(reply),
  },
  {
    batch: "3", tool: "bulk execute (confirm turn)",
    // Standalone confirmation (each verifier step is a fresh conversation, so
    // it names what is being confirmed; plan_id resolves server-side).
    message: `Yes, I confirm — go ahead with the pending bulk delete of my ${TAG}_bulk tasks from the preview.`,
    retryMessage: `Execute the pending bulk delete plan now — I already confirmed the ${TAG}_bulk preview.`,
    verify: async () => (await list("/tasks")).filter((t) => (t.title || "").includes(`${TAG}_bulk`)).length === 0,
  },

  // ── Batch 4 (MCP-grade) — system validate / repair / refresh ───────────────
  {
    batch: "4", tool: "find_orphans",
    message: `Check my data for orphaned records`,
    verify: async () => true,
    verifyReply: (reply) => /orphan|consistent|healthy|no.*issue|found \d+/i.test(reply),
  },
  {
    batch: "4", tool: "find_duplicates",
    seed: async () => {
      await seedPost("/expenses", { description: `${TAG}_dupscan latte`, amount: 4.25, category: "food" });
      await seedPost("/expenses", { description: `${TAG}_dupscan latte`, amount: 4.25, category: "food" });
    },
    message: `Do I have any duplicate expenses?`,
    verify: async () => true,
    verifyReply: (reply) => /duplicate|similar/i.test(reply),
  },
  {
    batch: "4", tool: "refresh_dashboard",
    message: `Refresh my dashboard — the counts look stale`,
    verify: async () => true,
    verifyReply: (reply) => /refresh|recomputed|cleared|up to date/i.test(reply),
  },
  {
    batch: "4", tool: "explain_dashboard_item",
    seed: async () => { await seedPost("/tasks", { title: `${TAG}_whytask pay water bill`, dueDate: today }); },
    message: `Why is ${TAG}_whytask showing on my dashboard today?`,
    verify: async () => true,
    verifyReply: (reply) => /due|today|agenda|overdue|dashboard/i.test(reply),
  },

  // ── Batch 5 (MCP-grade) — merge_profiles (preview → confirm → undo) ────────
  {
    batch: "5", tool: "merge preview (no changes yet)",
    seed: async () => {
      const src = await seedPost("/profiles", { name: `${TAG}_mrgsrc`, type: "person" });
      const tgt = await seedPost("/profiles", { name: `${TAG}_mrgtgt`, type: "person" });
      mergeSrcId = src.id; mergeTgtId = tgt.id;
      await seedPost("/tasks", { title: `${TAG}_mrgtask src chore`, linkedProfiles: [src.id] });
    },
    message: `Merge the profile ${TAG}_mrgsrc into ${TAG}_mrgtgt`,
    // Preview turn: BOTH profiles must still exist untouched.
    verify: async () => {
      const profiles = await list("/profiles");
      return profiles.some((p) => p.id === mergeSrcId) && profiles.some((p) => p.id === mergeTgtId);
    },
    verifyReply: (reply) => /preview|confirm|re-point|proceed|merge/i.test(reply),
  },
  {
    batch: "5", tool: "merge execute (confirm turn)",
    message: `Yes, I confirm — go ahead with the pending profile merge of ${TAG}_mrgsrc into ${TAG}_mrgtgt.`,
    retryMessage: `Execute the pending merge plan now — I already confirmed merging ${TAG}_mrgsrc into ${TAG}_mrgtgt.`,
    // Source archived (gone from the live list), task re-pointed to the target.
    verify: async () => {
      const profiles = await list("/profiles");
      if (profiles.some((p) => p.id === mergeSrcId)) return false;
      const tasks = await list("/tasks");
      const t = tasks.find((x) => (x.title || "").includes(`${TAG}_mrgtask`));
      return !!t && Array.isArray(t.linkedProfiles) && t.linkedProfiles.includes(mergeTgtId);
    },
  },
  {
    batch: "5", tool: "merge undo (source restored)",
    message: `Undo that merge`,
    retryMessage: `Undo my last action — the ${TAG}_mrgsrc profile merge`,
    verify: async () => {
      const profiles = await list("/profiles");
      if (!profiles.some((p) => p.id === mergeSrcId)) return false;
      const tasks = await list("/tasks");
      const t = tasks.find((x) => (x.title || "").includes(`${TAG}_mrgtask`));
      return !!t && Array.isArray(t.linkedProfiles) && t.linkedProfiles.includes(mergeSrcId);
    },
  },

  // ── Batch 6 (MCP-grade) — dashboard section control ────────────────────────
  {
    batch: "6", tool: "configure_dashboard_sections",
    message: `Show the Weekly Summary section on my dashboard`,
    verify: async () => {
      const r = await api("GET", "/preferences/dashboard_layout");
      const raw = (r.data as any)?.value;
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (Number(parsed?.version) < 16) return false;
      const sec = (parsed?.sections || []).find((s: any) => s.id === "weekly-summary");
      return !!sec && sec.visible === true;
    },
  },
  {
    batch: "6", tool: "configure_dashboard_sections (hide + undo-ready)",
    message: `Hide the Weekly Summary section again`,
    verify: async () => {
      const r = await api("GET", "/preferences/dashboard_layout");
      const raw = (r.data as any)?.value;
      if (!raw) return false;
      const sec = (JSON.parse(raw)?.sections || []).find((s: any) => s.id === "weekly-summary");
      return !!sec && sec.visible === false;
    },
  },

  // ── Batch 7 (MCP-grade) — notifications v2 ─────────────────────────────────
  {
    batch: "7", tool: "create_notification",
    message: `Create an urgent notification: ${TAG}_notif insurance renewal needs attention`,
    verify: async () => {
      const r = await api("GET", "/notifications");
      const rows: any[] = Array.isArray(r.data) ? r.data : [];
      return rows.some((n) => String(n.id || "").startsWith("custom:") && `${n.title} ${n.message}`.includes(`${TAG}_notif`));
    },
  },
  {
    batch: "7", tool: "mark_notifications_read",
    message: `Mark the ${TAG}_notif notification as read`,
    verify: async () => true,
    verifyReply: (reply) => /read|marked/i.test(reply),
  },
  {
    batch: "7", tool: "dismiss custom notification",
    message: `Dismiss the ${TAG}_notif notification`,
    verify: async () => {
      const r = await api("GET", "/notifications");
      const rows: any[] = Array.isArray(r.data) ? r.data : [];
      return !rows.some((n) => `${n.title} ${n.message}`.includes(`${TAG}_notif`));
    },
  },
  {
    batch: "7", tool: "set_notification_preferences",
    message: `Mute info notifications`,
    verify: async () => {
      const r = await api("GET", "/preferences/notification_prefs");
      const raw = (r.data as any)?.value;
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.muted_severities) && parsed.muted_severities.includes("info");
    },
  },
  {
    batch: "7", tool: "set_notification_preferences (clear)",
    message: `Unmute all my notifications`,
    verify: async () => {
      const r = await api("GET", "/preferences/notification_prefs");
      const raw = (r.data as any)?.value;
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return !(parsed?.muted_severities || []).length && !(parsed?.muted_types || []).length;
    },
  },

  // ── Batch 8 (MCP-grade) — medication dose ledger ───────────────────────────
  {
    batch: "8", tool: "log_medication_dose",
    seed: async () => {
      await seedPost("/trackers", {
        name: `${TAG}_med Lisinopril (twice daily)`, category: "medication",
        fields: [
          { name: "drugName", type: "text" }, { name: "dosage", type: "text" },
          { name: "timeTaken", type: "text" }, { name: "adherence", type: "select", options: ["taken", "skipped", "missed"] },
          { name: "sideEffects", type: "text" }, { name: "notes", type: "text" },
        ],
      });
    },
    message: `I took my ${TAG}_med Lisinopril this morning`,
    verify: async () => {
      const trackers = await list("/trackers");
      const t = trackers.find((x) => (x.name || "").includes(`${TAG}_med`));
      return !!t && (t.entries || []).some((e: any) => String(e?.values?.adherence).toLowerCase() === "taken");
    },
  },
  {
    batch: "8", tool: "skip_medication_dose",
    message: `I skipped tonight's ${TAG}_med Lisinopril dose, felt nauseous`,
    verify: async () => {
      const trackers = await list("/trackers");
      const t = trackers.find((x) => (x.name || "").includes(`${TAG}_med`));
      return !!t && (t.entries || []).some((e: any) => String(e?.values?.adherence).toLowerCase() === "skipped");
    },
  },
  {
    batch: "8", tool: "get_missed_doses",
    message: `What ${TAG}_med doses did I miss this week?`,
    verify: async () => true,
    verifyReply: (reply) => /dose|taken|skipped|missed|expected|adherence/i.test(reply),
  },

  // ── Batch 9 (MCP-grade) — routing hints ────────────────────────────────────
  {
    batch: "9", tool: "projects ⇒ goals routing",
    message: `Create a project called ${TAG}_proj kitchen remodel`,
    verify: async () => (await list("/goals")).some((g) => (g.title || g.name || "").includes(`${TAG}_proj`)),
  },
  {
    batch: "9", tool: "move expense between profiles",
    seed: async () => {
      await seedPost("/profiles", { name: `${TAG}_luna`, type: "person" });
      await seedPost("/expenses", { description: `${TAG}_movexp gym fee`, amount: 30, category: "health" });
    },
    message: `Move the ${TAG}_movexp expense to ${TAG}_luna's profile`,
    retryMessage: `Update the ${TAG}_movexp expense — its owner should be ${TAG}_luna`,
    verify: async () => {
      const profiles = await list("/profiles");
      const luna = profiles.find((p) => (p.name || "").includes(`${TAG}_luna`));
      if (!luna) return false;
      const exp = (await list("/expenses")).find((e) => (e.description || "").includes(`${TAG}_movexp`));
      return !!exp && Array.isArray(exp.linkedProfiles) && exp.linkedProfiles.includes(luna.id);
    },
  },

  // ── Batch V (regression) — document-field lookups + vehicle resolution ─────
  {
    batch: "V", tool: "license plate from linked registration doc",
    seed: async () => {
      const car = await seedPost("/profiles", { name: `${TAG}_veh Honda CR-V 2021`, type: "vehicle" });
      // Look-alike liability that previously shadowed the vehicle in
      // search_documents' naive includes-match.
      await seedPost("/profiles", { name: `Insurance - ${TAG}_veh Honda CR-V 2021`, type: "subscription" });
      await seedPost("/documents", {
        name: `${TAG}_veh CA Vehicle Registration`,
        type: "vehicle_registration",
        mimeType: "text/plain",
        fileData: "",
        extractedData: { licenseNumber: "8ZQX417", make: "HOND", year: "2021", registeredOwner: "Smoke Test", expirationDate: "2027-03-28" },
        linkedProfiles: [car.id],
      });
    },
    message: `Can you retrieve my license plate number from my ${TAG}_veh Honda?`,
    verify: async () => true,
    verifyReply: (reply) => /8ZQX417/.test(reply),
  },
  {
    batch: "V", tool: "indirect vehicle reference (single vehicle)",
    message: `What's the license plate on my ${TAG}_veh car?`,
    verify: async () => true,
    verifyReply: (reply) => /8ZQX417|CR-V/i.test(reply) && !/not stored|don't have|couldn't find/i.test(reply),
  },
  {
    batch: "V", tool: "UNLINKED document found by content",
    seed: async () => {
      await seedPost("/documents", {
        name: `${TAG}_pol Statement`,
        type: "insurance",
        mimeType: "text/plain",
        fileData: "",
        extractedData: { provider: "Acme Mutual", policyNumber: "PLCY-773301", premium: "$92/mo" },
        linkedProfiles: [],
      });
    },
    message: `What's my Acme Mutual policy number?`,
    verify: async () => true,
    verifyReply: (reply) => /PLCY-?773301/i.test(reply),
  },
  {
    batch: "V", tool: "link_document to profile",
    message: `Link the ${TAG}_pol Statement document to my ${TAG}_veh Honda.`,
    verify: async () => {
      const docs = await list("/documents");
      const doc = docs.find((d) => (d.name || "").includes(`${TAG}_pol`));
      const car = (await list("/profiles")).find((p) => (p.name || "").includes(`${TAG}_veh Honda`));
      return !!doc && !!car && (doc.linkedProfiles || []).includes(car.id);
    },
  },
  {
    batch: "V", tool: "cross-entity inference (registration expiry)",
    message: `When does my ${TAG}_veh car's registration expire?`,
    verify: async () => true,
    verifyReply: (reply) => /2027|March/i.test(reply) && !/couldn't find|no document/i.test(reply),
  },

  // ── Batch A — Finance ──────────────────────────────────────────────────────
  {
    batch: "A", tool: "update_income",
    seed: async () => { await seedPost("/incomes", { description: `${TAG}_inc`, amount: 100, frequency: "monthly", category: "freelance" }); },
    message: `Change the ${TAG}_inc income to $250`,
    retryMessage: `Update the income entry called ${TAG}_inc — set its amount to $250`,
    verify: async () => (await list("/incomes")).some((r) => (r.description || "").includes(`${TAG}_inc`) && Number(r.amount) === 250),
  },
  {
    batch: "A", tool: "delete_income",
    seed: async () => { await seedPost("/incomes", { description: `${TAG}_inc2`, amount: 77, frequency: "once", category: "other" }); },
    message: `Delete the ${TAG}_inc2 income`,
    retryMessage: `Yes — delete the income entry called ${TAG}_inc2`,
    verify: async () => !(await list("/incomes")).some((r) => (r.description || "").includes(`${TAG}_inc2`)),
  },
  {
    batch: "A", tool: "delete_paycheck",
    seed: async () => { await seedPost("/paychecks", { source: `${TAG}_pay`, amount: 500, expected_date: today }); },
    message: `Delete the expected paycheck from ${TAG}_pay`,
    retryMessage: `I have an expected paycheck whose source/employer is "${TAG}_pay" — delete that paycheck entry`,
    verify: async () => !(await list("/paychecks")).some((r) => (r.source || "").includes(`${TAG}_pay`)),
  },
  {
    batch: "A", tool: "update_memory",
    seed: async () => { await seedPost("/memories", { key: `${TAG}_mem`, value: "old value 1", category: "general" }); },
    message: `Update my saved memory ${TAG}_mem — the correct value is "new value 42"`,
    retryMessage: `Change the memory with key ${TAG}_mem to say: new value 42`,
    verify: async () => (await list("/memories")).some((r) => (r.key || "").includes(`${TAG}_mem`) && String(r.value || "").includes("new value 42")),
  },
  // ── Batch B — Liabilities / bills / loans ──────────────────────────────────
  {
    batch: "B", tool: "undo_last_payment",
    seed: async () => {
      const bill = await seedPost("/obligations", { name: `${TAG}_ubill`, amount: 42, frequency: "monthly", kind: "bill", nextDueDate: today });
      await seedPost(`/obligations/${bill.id}/pay`, { amount: 42 });
    },
    message: `Undo the last payment on the ${TAG}_ubill bill`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_ubill`));
      return !!b && !(b.payments || []).length;
    },
  },
  {
    batch: "B", tool: "update_liability_payment",
    seed: async () => {
      const bill = await seedPost("/obligations", { name: `${TAG}_pbill`, amount: 60, frequency: "monthly", kind: "bill", nextDueDate: today });
      await seedPost(`/obligations/${bill.id}/pay`, { amount: 60 });
    },
    message: `The ${TAG}_pbill payment I just logged was actually $55 — fix it`,
    retryMessage: `Update the most recent recorded payment on ${TAG}_pbill: set its amount to $55`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_pbill`));
      return !!(b?.payments || []).some((p: any) => Number(p.amount) === 55);
    },
  },
  {
    batch: "B", tool: "delete_liability_payment",
    seed: async () => {
      const bill = await seedPost("/obligations", { name: `${TAG}_dbill`, amount: 30, frequency: "monthly", kind: "bill", nextDueDate: today });
      // The pay endpoint dedupes ANY second pay on the same obligation within
      // 8s (userId:obligationId key, amount ignored) — space the two payments
      // past that window or the second silently returns {deduped:true}.
      await seedPost(`/obligations/${bill.id}/pay`, { amount: 30 });
      await sleep(8500);
      await seedPost(`/obligations/${bill.id}/pay`, { amount: 31 });
    },
    message: `Delete the $31 payment recorded on ${TAG}_dbill`,
    retryMessage: `Yes — remove the most recent recorded payment (the $31 one) from ${TAG}_dbill's payment history`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_dbill`));
      const pays = (b?.payments || []) as any[];
      return pays.length === 1 && Number(pays[0].amount) === 30;
    },
  },
  {
    batch: "B", tool: "update_obligation (reschedule occurrence)",
    seed: async () => {
      await seedPost("/obligations", { name: `${TAG}_rbill`, amount: 25, frequency: "monthly", kind: "bill", nextDueDate: today });
    },
    message: `Move the next ${TAG}_rbill payment to the 28th of next month — just that one occurrence, don't change the schedule`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_rbill`));
      if (!b) return false;
      const r = await api("GET", `/liabilities/${b.id}/schedule`);
      const occs: any[] = (r.data as any)?.occurrences || [];
      return occs.some((o) => o.movedTo || o.effectiveDate !== o.date);
    },
  },
  {
    batch: "B", tool: "mark_loan_payment",
    seed: async () => {
      const loanId = crypto.randomUUID(); // loan_id column is uuid — the marker lives in loan_name
      const base = new Date();
      const entries = [1, 2, 3].map((n) => {
        const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
        return {
          loan_id: loanId, loan_name: `${TAG}_loan`, payment_number: n,
          payment_date: d.toISOString().slice(0, 10),
          principal_amount: 80, interest_amount: 20, total_payment: 100,
          remaining_balance: 1000 - n * 80,
        };
      });
      await seedPost("/loans/schedule", { entries });
    },
    message: `Mark the next ${TAG}_loan payment as paid on the loan schedule`,
    retryMessage: `On my loan amortization schedule there is a loan called ${TAG}_loan — mark its next unpaid installment as paid (do NOT create anything)`,
    verify: async () => {
      const r = await api("GET", `/loans/schedule`);
      const rows: any[] = Array.isArray(r.data) ? r.data : [];
      return rows.some((row) => (row.loan_name || "").includes(`${TAG}_loan`) && row.paid && Number(row.payment_number) === 1);
    },
  },
  // ── Batch C — Executive / wellness / notifications ─────────────────────────
  {
    batch: "C", tool: "update_reminder",
    seed: async () => {
      const at = new Date(Date.now() + 3 * 86400000); at.setHours(10, 0, 0, 0);
      await seedPost("/reminders", { title: `${TAG}_rem call vet`, fireAt: at.toISOString() });
    },
    message: `Move my ${TAG}_rem call vet reminder to 4pm that same day`,
    retryMessage: `Update the pending reminder titled "${TAG}_rem call vet" — change its time to 16:00 on the same date it is currently set for`,
    verify: async () => {
      const rems = await list("/reminders");
      const r = rems.find((x) => (x.title || "").includes(`${TAG}_rem`));
      if (!r?.fireAt) return false;
      const d = new Date(r.fireAt);
      return d.getUTCHours() !== 10 || d.getHours() === 16; // moved off the seeded 10:00
    },
  },
  {
    batch: "C", tool: "delete_reminder",
    seed: async () => {
      const at = new Date(Date.now() + 4 * 86400000); at.setHours(9, 0, 0, 0);
      await seedPost("/reminders", { title: `${TAG}_rem2 renew tags`, fireAt: at.toISOString() });
    },
    message: `Cancel the ${TAG}_rem2 renew tags reminder`,
    retryMessage: `Yes — delete the pending reminder titled "${TAG}_rem2 renew tags"`,
    verify: async () => !(await list("/reminders")).some((x) => (x.title || "").includes(`${TAG}_rem2`)),
  },
  {
    batch: "C", tool: "restore_task",
    seed: async () => {
      const t = await seedPost("/tasks", { title: `${TAG}_rtask file taxes` });
      await api("DELETE", `/tasks/${t.id}`);
    },
    message: `Restore the ${TAG}_rtask file taxes task I deleted`,
    verify: async () => (await list("/tasks")).some((t) => (t.title || "").includes(`${TAG}_rtask`)),
  },
  {
    batch: "C", tool: "restore_habit",
    seed: async () => {
      const h = await seedPost("/habits", { name: `${TAG}_rhabit stretch`, frequency: "daily" });
      await api("DELETE", `/habits/${h.id}`);
    },
    message: `Bring back the ${TAG}_rhabit stretch habit I deleted`,
    verify: async () => (await list("/habits")).some((h) => (h.name || "").includes(`${TAG}_rhabit`)),
  },
  {
    batch: "C", tool: "dismiss_notifications",
    seed: async () => {
      // An overdue task guarantees at least one live notification to dismiss.
      await seedPost("/tasks", { title: `${TAG}_ntask overdue thing`, dueDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) });
    },
    message: `Dismiss all my notifications`,
    verify: async () => {
      const r = await api("GET", "/preferences/dismissed_notifications");
      try {
        const ids = JSON.parse((r.data as any)?.value || "[]");
        return Array.isArray(ids) && ids.some((id: string) => String(id).startsWith("task-overdue-") || String(id).startsWith("task-today-"));
      } catch { return false; }
    },
  },
  {
    batch: "C", tool: "update_task (addTags subtask)",
    seed: async () => { await seedPost("/tasks", { title: `${TAG}_stask groceries` }); },
    message: `Add a subtask "buy milk" to my ${TAG}_stask groceries task`,
    retryMessage: `Update the task ${TAG}_stask groceries: add the subtask tag for "buy milk" (do not replace its other tags)`,
    verify: async () => {
      const t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_stask`));
      return !!(t?.tags || []).some((tag: string) => tag.startsWith("st:0:") && tag.includes("milk"));
    },
  },
  // ── Batch D — Artifacts ────────────────────────────────────────────────────
  {
    batch: "D", tool: "update_artifact (pin)",
    seed: async () => { await seedPost("/artifacts", { type: "checklist", title: `${TAG}_alist groceries`, content: "", items: [{ text: "milk", checked: false }, { text: "eggs", checked: false }] }); },
    message: `Pin my ${TAG}_alist groceries list`,
    retryMessage: `Update the artifact "${TAG}_alist groceries" — set pinned to true`,
    verify: async () => (await list("/artifacts")).some((a) => (a.title || "").includes(`${TAG}_alist`) && a.pinned === true),
  },
  {
    batch: "D", tool: "toggle_artifact_item",
    seed: async () => { await seedPost("/artifacts", { type: "checklist", title: `${TAG}_blist packing`, content: "", items: [{ text: "passport", checked: false }, { text: "charger", checked: false }] }); },
    message: `Check off passport on my ${TAG}_blist packing list`,
    retryMessage: `On the checklist artifact "${TAG}_blist packing", mark the "passport" item as done`,
    verify: async () => {
      const a = (await list("/artifacts")).find((x) => (x.title || "").includes(`${TAG}_blist`) && !(x.title || "").includes("(copy)"));
      return !!(a?.items || []).some((i: any) => (i.text || "").includes("passport") && i.checked === true);
    },
  },
  {
    batch: "D", tool: "duplicate_artifact",
    seed: async () => { await seedPost("/artifacts", { type: "checklist", title: `${TAG}_clist chores`, content: "", items: [{ text: "vacuum", checked: false }] }); },
    message: `Make a copy of my ${TAG}_clist chores list`,
    verify: async () => (await list("/artifacts")).some((a) => (a.title || "").includes(`${TAG}_clist`) && (a.title || "").includes("(copy)")),
  },
  {
    batch: "A", tool: "copy_budgets_previous_month",
    seed: async () => { await seedPost("/budgets", { category: "education", amount: 22133, month: prevMonth }); },
    message: `Copy last month's budgets to this month`,
    verify: async () => {
      const r = await api("GET", `/budgets?month=${month}`);
      const rows = Array.isArray(r.data) ? r.data : (r.data?.budgets || []);
      return rows.some((b: any) => b.category === "education" && Number(b.amount) === 22133);
    },
  },
];

async function cleanup(): Promise<void> {
  for (const ep of ["/incomes", "/paychecks", "/memories", "/tasks", "/habits", "/events", "/expenses", "/obligations", "/artifacts", "/reminders", "/profiles"]) {
    try {
      for (const row of await list(ep)) {
        if (JSON.stringify(row).includes(TAG)) {
          try { await api("DELETE", `${ep}/${row.id}`); } catch { /* best effort */ }
        }
      }
    } catch { /* endpoint may not support GET-all — best effort */ }
  }
  // Budgets need month-scoped deletes and don't carry the TAG — match the
  // sentinel amount instead.
  for (const m of [prevMonth, month]) {
    try {
      const r = await api("GET", `/budgets?month=${m}`);
      const rows = Array.isArray(r.data) ? r.data : (r.data?.budgets || []);
      for (const b of rows) {
        if (Number(b.amount) === 22133) { try { await api("DELETE", `/budgets/${b.id}?month=${m}`); } catch { /* */ } }
      }
    } catch { /* */ }
  }
}

(async () => {
  const args = process.argv.slice(2);
  const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const batch = arg("batch");
  const only = arg("only");
  const sha = arg("sha");

  if (sha) await waitForDeploy(sha);

  let steps = STEPS;
  if (batch) steps = steps.filter((s) => s.batch.toUpperCase() === batch.toUpperCase());
  if (only) steps = steps.filter((s) => s.tool === only);
  if (steps.length === 0) { console.error(`No steps match --batch=${batch} --only=${only}`); process.exit(2); }

  console.log(`\n── AI tool CRUD verification (${TAG}) — ${steps.length} step(s) at ${API_BASE} ──\n`);
  const results: string[] = [];
  let pass = 0;
  for (const s of steps) {
    const label = `[${s.batch}] ${s.tool.padEnd(28)}`;
    try {
      if (s.seed) { await s.seed(); await sleep(800); }
      let res = await api("POST", "/chat", { message: s.message });
      if (res.status === 429) { await sleep(6000); res = await api("POST", "/chat", { message: s.message }); }
      await sleep(1500);
      let ok = await s.verify();
      const reply = String((res.data as any)?.reply || "");
      if (!ok && /\?|confirm|are you sure|is that correct|should i/i.test(reply)) {
        // Destructive commands ask for confirmation (by design) — answer like
        // the real UI would: a follow-up turn with conversation history.
        await sleep(3600);
        res = await api("POST", "/chat", {
          message: "Yes, that's correct — go ahead.",
          history: [
            { role: "user", content: s.message },
            { role: "assistant", content: reply },
          ],
        });
        await sleep(1500);
        ok = await s.verify();
      }
      if (!ok && s.retryMessage) {
        // Routing may need more explicit phrasing — one retry before failing.
        await sleep(3600);
        res = await api("POST", "/chat", { message: s.retryMessage });
        await sleep(1500);
        ok = await s.verify();
      }
      const finalReply = String((res.data as any)?.reply || "");
      if (ok && s.verifyReply && !s.verifyReply(finalReply)) {
        ok = false;
        results.push(`❌ ${label} DB ok but reply assertion failed: ${finalReply.slice(0, 120)}`);
      } else if (ok) { pass++; results.push(`✅ ${label} "${s.message.slice(0, 52)}"`); }
      else results.push(`❌ ${label} write NOT observed [chat ${res.status}] reply: ${finalReply.slice(0, 120)}`);
    } catch (e: any) {
      results.push(`💥 ${label} ${e?.message || e}`);
    }
    await sleep(3600); // stay under 20 chat calls/min
  }

  await cleanup();

  console.log(results.join("\n"));
  console.log(`\n${pass}/${steps.length} tool CRUD checks verified.\n`);
  process.exit(pass === steps.length ? 0 : 1);
})();
