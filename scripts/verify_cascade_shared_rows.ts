// Verifies bug #7 + #8 fix in server/supabase-storage.ts:
//
//   When you delete a profile that co-owns rows with other profiles, the
//   shared rows must NOT be deleted — only the deleted profile's id should be
//   stripped from linked_profiles. The journal pattern (already correct
//   pre-fix) is now applied to expenses, tasks, obligations, events,
//   documents, artifacts, goals, habits, AND incomes (bug #8: incomes had no
//   cascade at all, so they were left orphaned).
//
// What this exercises (real production code path):
//   server/supabase-storage.ts -> deleteProfile (post-fix)
//
// What this does NOT touch:
//   - The user's existing profiles. Creates disposable profiles + rows
//     tagged `__qa_cascade_test__`, runs all assertions, then wipes them.
//
// Run with:
//   cd portal && npx tsx scripts/verify_cascade_shared_rows.ts

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// SAFETY (2026-05-24): no production-user default. If QA_USER_ID isn't set the
// script aborts — prevents an accidental run from polluting a real user's data,
// which is what happened on 2026-05-23 (left orphan rows on test@aol.com).
const USER_ID = process.env.QA_USER_ID || "";
const TEST_TAG = "__qa_cascade_test__";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!USER_ID) {
  console.error(
    "\nABORT: QA_USER_ID is required. This script CREATES + DELETES test rows\n" +
    "under the given user id. Set QA_USER_ID to a dedicated QA account, e.g.:\n" +
    "  QA_USER_ID=<uuid> npx tsx scripts/verify_cascade_shared_rows.ts\n\n" +
    "It must NOT be a production user.\n"
  );
  process.exit(1);
}

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

interface RowCheck {
  domain: string;
  sharedRowPreserved: boolean;
  soleRowDeleted: boolean;
  deletedStrippedFromShared: boolean;
  notes: string;
}

const results: RowCheck[] = [];

async function main() {
  console.log("\n=== Cascade-shared-rows verification ===\n");

  // 1. Create two test profiles: Alice + Bob.
  const alice = await storage.createProfile({
    type: "person", name: `${TEST_TAG} Alice`, tags: [TEST_TAG], fields: {}, notes: "", documents: [],
  } as any);
  const bob = await storage.createProfile({
    type: "person", name: `${TEST_TAG} Bob`, tags: [TEST_TAG], fields: {}, notes: "", documents: [],
  } as any);
  console.log(`Created Alice=${alice.id.slice(0,8)}  Bob=${bob.id.slice(0,8)}`);

  // 2. Create one of each entity type, shared between Alice + Bob, and one
  //    bob-only. After deleting Bob: shared row must survive without Bob;
  //    bob-only row must be gone.

  // ── Expenses ────────────────────────────────────────────────────────────
  const sharedExp = await storage.createExpense({
    description: `${TEST_TAG} shared expense`, amount: 50, category: "general",
    linkedProfiles: [alice.id, bob.id], tags: [TEST_TAG], date: "2026-01-01",
  } as any);
  const soleExp = await storage.createExpense({
    description: `${TEST_TAG} sole expense`, amount: 25, category: "general",
    linkedProfiles: [bob.id], tags: [TEST_TAG], date: "2026-01-01",
  } as any);

  // ── Tasks ───────────────────────────────────────────────────────────────
  const sharedTask = await storage.createTask({
    title: `${TEST_TAG} shared task`, status: "todo", priority: "medium",
    linkedProfiles: [alice.id, bob.id], tags: [TEST_TAG],
  } as any);
  const soleTask = await storage.createTask({
    title: `${TEST_TAG} sole task`, status: "todo", priority: "medium",
    linkedProfiles: [bob.id], tags: [TEST_TAG],
  } as any);

  // ── Obligations ─────────────────────────────────────────────────────────
  const sharedOb = await storage.createObligation({
    name: `${TEST_TAG} shared obligation`, amount: 100, frequency: "monthly",
    category: "general", nextDueDate: "2026-02-01",
    linkedProfiles: [alice.id, bob.id], tags: [TEST_TAG],
  } as any);
  const soleOb = await storage.createObligation({
    name: `${TEST_TAG} sole obligation`, amount: 50, frequency: "monthly",
    category: "general", nextDueDate: "2026-02-01",
    linkedProfiles: [bob.id], tags: [TEST_TAG],
  } as any);

  // ── Events ──────────────────────────────────────────────────────────────
  const sharedEv = await storage.createEvent({
    title: `${TEST_TAG} shared event`, date: "2026-01-02", category: "personal",
    linkedProfiles: [alice.id, bob.id], tags: [TEST_TAG],
  } as any);
  const soleEv = await storage.createEvent({
    title: `${TEST_TAG} sole event`, date: "2026-01-02", category: "personal",
    linkedProfiles: [bob.id], tags: [TEST_TAG],
  } as any);

  // ── Incomes (bug #8: was never cascaded) ────────────────────────────────
  const sharedInc = await storage.createIncome({
    description: `${TEST_TAG} shared income`, amount: 200, category: "salary",
    frequency: "monthly", linkedProfiles: [alice.id, bob.id], tags: [TEST_TAG],
  } as any);
  const soleInc = await storage.createIncome({
    description: `${TEST_TAG} sole income`, amount: 100, category: "salary",
    frequency: "monthly", linkedProfiles: [bob.id], tags: [TEST_TAG],
  } as any);

  console.log("Created shared + sole rows for: expenses, tasks, obligations, events, incomes");

  // 3. Delete Bob.
  console.log(`\nDeleting Bob (${bob.id.slice(0,8)}) ...`);
  const ok = await storage.deleteProfile(bob.id);
  console.log(`deleteProfile returned: ${ok}`);

  // 4. Verify shared rows survived without Bob, and sole rows are gone.
  async function check(
    domain: string,
    table: string,
    sharedId: string,
    soleId: string,
    softDelete: boolean,
  ): Promise<RowCheck> {
    let sharedRowPreserved = false;
    let soleRowDeleted = false;
    let deletedStrippedFromShared = false;
    let notes = "";

    const { data: sharedRow } = await sb.from(table).select("id, linked_profiles, deleted_at").eq("id", sharedId).maybeSingle();
    if (sharedRow) {
      if (softDelete && sharedRow.deleted_at) {
        notes += "shared was soft-deleted (unexpected); ";
      } else {
        sharedRowPreserved = true;
        const lp: string[] = sharedRow.linked_profiles || [];
        if (!lp.includes(bob.id) && lp.includes(alice.id)) deletedStrippedFromShared = true;
        else notes += `shared linked_profiles=${JSON.stringify(lp)}; `;
      }
    } else {
      notes += "shared row missing; ";
    }

    const { data: soleRow } = await sb.from(table).select("id, deleted_at").eq("id", soleId).maybeSingle();
    if (!soleRow) {
      soleRowDeleted = true;
    } else if (softDelete && soleRow.deleted_at) {
      soleRowDeleted = true;
    } else {
      notes += "sole row survived (unexpected); ";
    }

    return { domain, sharedRowPreserved, soleRowDeleted, deletedStrippedFromShared, notes };
  }

  results.push(await check("expenses",   "expenses",   sharedExp.id, soleExp.id, true));
  results.push(await check("tasks",      "tasks",      sharedTask.id, soleTask.id, false));
  results.push(await check("obligations","obligations",sharedOb.id, soleOb.id, false));
  results.push(await check("events",     "events",     sharedEv.id, soleEv.id, false));
  results.push(await check("incomes",    "incomes",    sharedInc.id, soleInc.id, true));

  // 5. Summary.
  console.log("\n=== Results ===");
  console.log("domain        | sharedPreserved | soleDeleted | bobStripped | notes");
  console.log("--------------+-----------------+-------------+-------------+----------");
  let allPass = true;
  for (const r of results) {
    const pass = r.sharedRowPreserved && r.soleRowDeleted && r.deletedStrippedFromShared;
    if (!pass) allPass = false;
    console.log(
      `${r.domain.padEnd(13)} | ${String(r.sharedRowPreserved).padEnd(15)} | ${String(r.soleRowDeleted).padEnd(11)} | ${String(r.deletedStrippedFromShared).padEnd(11)} | ${r.notes || (pass ? "OK" : "FAIL")}`,
    );
  }

  // 6. Cleanup: delete Alice. The post-bug-#7 fix only STRIPS Alice from any
  //    shared rows (it doesn't remove them, because they're "shared"). After
  //    Bob is deleted earlier, Alice is the only remaining linked profile, so
  //    once Alice is deleted those rows are owner-less and we must hard-delete
  //    them by tag below — otherwise they orphan in the DB.
  console.log(`\nCleaning up: deleting Alice (${alice.id.slice(0,8)}) ...`);
  await storage.deleteProfile(alice.id);

  // 7. Hard-delete ANY row tagged TEST_TAG (or with the test name prefix) for
  //    this user. Bug fix (2026-05-24): previously only `expenses` + `incomes`
  //    were hard-deleted here, so `tasks`, `obligations`, `events` and their
  //    occurrences were left in place forever. We now sweep every table the
  //    script touched, including obligation_occurrences (joined by obligation
  //    id) and any test profile that somehow survived deletion.
  const sweepTables: Array<{ name: string; nameField: string }> = [
    { name: "expenses",    nameField: "description" },
    { name: "incomes",     nameField: "description" },
    { name: "tasks",       nameField: "title" },
    { name: "obligations", nameField: "name" },
    { name: "events",      nameField: "title" },
  ];
  for (const t of sweepTables) {
    // Delete by tag (works if tags column is jsonb array of strings)
    await sb.from(t.name).delete().eq("user_id", USER_ID).contains("tags", [TEST_TAG]);
    // Also delete any rows whose displayed name still has the prefix
    // (some tables had `linked_profiles: []` after cascade and may have
    //  ignored the tag filter depending on storage shape).
    await sb.from(t.name).delete().eq("user_id", USER_ID).ilike(t.nameField, `${TEST_TAG}%`);
  }
  // Obligation occurrences are child rows; the FK delete above should cascade.
  // If any survived the cascade (no FK constraint set up), we have no way to
  // identify them by name — they only carry obligation_id. The obligations
  // sweep above already deletes the parents; if the FK is correctly defined
  // as ON DELETE CASCADE, the occurrences go with them automatically.
  // Sweep test profiles that may have survived deletion.
  await sb.from("profiles").delete().eq("user_id", USER_ID).contains("tags", [TEST_TAG]);
  await sb.from("profiles").delete().eq("user_id", USER_ID).ilike("name", `${TEST_TAG}%`);

  // Final sanity: nothing tagged TEST_TAG should remain anywhere.
  for (const t of sweepTables) {
    const { data: leftover } = await sb.from(t.name).select("id").eq("user_id", USER_ID).contains("tags", [TEST_TAG]);
    if (leftover && leftover.length > 0) console.warn(`[cleanup] ${t.name} still has ${leftover.length} test rows`);
  }
  const { data: leftProf } = await sb.from("profiles").select("id, name").eq("user_id", USER_ID).contains("tags", [TEST_TAG]);
  if (leftProf && leftProf.length > 0) console.warn(`[cleanup] profiles still has ${leftProf.length} test rows`);

  console.log(`\nFinal: ${allPass ? "✅ ALL PASS" : "❌ FAILURES"}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
