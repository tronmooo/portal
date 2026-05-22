// Verify multi-command capability: a single chat message that asks the AI
// to perform 3+ distinct actions should result in 3+ entries in allActions.
//
// We use a unique nonce in every name so we can clean up at the end and so
// re-runs don't collide with previous test rows.
import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { processMessage } from "../server/ai-engine.js";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const USER_ID      = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);
const supa = createClient(SUPABASE_URL, SERVICE_KEY);

const NONCE = `MULTICMD${Date.now().toString().slice(-6)}`;

async function run() {
  const msg =
    `Create a person profile named ${NONCE}Tester (he's a coworker). ` +
    `Also log a $50 groceries expense for me. ` +
    `Also add a journal entry: feeling great today.`;
  console.log("============================================================");
  console.log("MESSAGE:", msg);
  console.log("============================================================");
  const result: any = await requestStorageContext.run(
    storage as any,
    async () => await processMessage(msg, [], USER_ID)
  );

  const actions = result.actions || [];
  console.log("\n--- RESULT SUMMARY ---");
  console.log("reply:", result.reply?.slice(0, 400));
  console.log("actions count:", actions.length);
  for (const a of actions) {
    console.log("  -", a.type, JSON.stringify(a.data).slice(0, 200));
  }

  // Verify each in DB
  const findings: Record<string, any> = {};
  const profRes = await supa
    .from("profiles")
    .select("id,name,type,created_at")
    .eq("user_id", USER_ID)
    .ilike("name", `%${NONCE}%`);
  findings.profile = profRes.data || [];

  const expRes = await supa
    .from("expenses")
    .select("id,description,amount,category,date")
    .eq("user_id", USER_ID)
    .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
    .ilike("description", "%grocer%");
  findings.expense = expRes.data || [];

  // Journal entries have a UNIQUE (user_id, date) constraint, so the AI's
  // journal_entry tool appends to today's existing entry. Search by today's
  // date and verify the content was appended.
  const todayLA = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  const jourRes = await supa
    .from("journal_entries")
    .select("id,content,date,created_at,updated_at")
    .eq("user_id", USER_ID)
    .eq("date", todayLA);
  const candidates = jourRes.data || [];
  // Either: a fresh entry with our content, OR the existing entry was updated
  // to include our content (append path).
  findings.journal = candidates.filter((j: any) =>
    (j.content || "").toLowerCase().includes("feeling great"),
  );

  console.log("\n--- DB VERIFICATION ---");
  console.log("profile row(s):", JSON.stringify(findings.profile, null, 2));
  console.log("expense row(s):", JSON.stringify(findings.expense, null, 2));
  console.log("journal row(s):", JSON.stringify(findings.journal, null, 2));

  const pass =
    findings.profile.length >= 1 &&
    findings.expense.length >= 1 &&
    findings.journal.length >= 1;

  console.log("\n=============================");
  console.log(pass ? "✅ MULTI-COMMAND PASS" : "❌ MULTI-COMMAND FAIL");
  console.log("=============================");

  // Cleanup: delete our test rows
  if (findings.profile.length > 0)
    await supa
      .from("profiles")
      .delete()
      .in(
        "id",
        findings.profile.map((p: any) => p.id),
      );
  if (findings.expense.length > 0)
    await supa
      .from("expenses")
      .delete()
      .in(
        "id",
        findings.expense.map((p: any) => p.id),
      );
  // Note: do NOT delete the journal row because it may be a pre-existing
  // entry the tool appended to. Instead, restore the journal entry to its
  // pre-test state by stripping our appended snippet if present.
  for (const j of findings.journal) {
    const cleaned = (j.content || "").replace(/\n\nFeeling great today\.?/gi, "").replace(/^Feeling great today\.?$/i, "").trim();
    if (cleaned !== (j.content || "")) {
      await supa.from("journal_entries").update({ content: cleaned }).eq("id", j.id);
    }
  }
  console.log("[cleanup] removed test rows");

  if (!pass) process.exit(1);
}

run().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
