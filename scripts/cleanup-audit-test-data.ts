/**
 * Remove the rows the 2026-07-25 UX audit created while probing the app.
 *
 * Dry-run by default — it prints what it WOULD delete and exits. Nothing is
 * removed until you pass --apply.
 *
 *   npx tsx scripts/cleanup-audit-test-data.ts            # preview
 *   npx tsx scripts/cleanup-audit-test-data.ts --apply    # delete
 *
 * Requires (do not hardcode these — unlike scripts/data-cleanup.ts, which has
 * a service key checked in and should be rotated):
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORTOL_USER_ID
 *
 * Matching is exact on title/description so it cannot eat real data. The
 * audit's third artifact, the calendar event "QA Test Event - Recurring", is
 * NOT listed here: the Edit=Delete bug already destroyed it (see the calendar
 * fix commit) and it has to be recreated by hand.
 */

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.PORTOL_USER_ID;
const APPLY = process.argv.includes("--apply");

if (!SB_URL || !SB_KEY || !USER_ID) {
  console.error("Missing env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORTOL_USER_ID");
  process.exit(1);
}

const headers = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

/** One exact-match row the audit left behind. */
interface Target {
  table: string;
  /** Column holding the human label. */
  column: string;
  value: string;
  /** Extra equality filters, for belt-and-braces on the expense. */
  extra?: Record<string, string>;
}

const TARGETS: Target[] = [
  { table: "tasks", column: "title", value: "AUDIT TEST TASK — please delete" },
  {
    table: "expenses",
    column: "description",
    value: "AUDIT TEST EXPENSE — please delete",
    extra: { amount: "1", category: "general", date: "2026-07-25" },
  },
];

function filterFor(t: Target): string {
  const parts = [
    `user_id=eq.${USER_ID}`,
    `${t.column}=eq.${encodeURIComponent(t.value)}`,
  ];
  for (const [k, v] of Object.entries(t.extra || {})) parts.push(`${k}=eq.${v}`);
  return parts.join("&");
}

async function main() {
  console.log(APPLY ? "APPLY — rows will be deleted\n" : "DRY RUN — nothing will be deleted (pass --apply)\n");

  let found = 0;
  for (const t of TARGETS) {
    // Select WITHOUT the `extra` filters so a near-miss (e.g. the amount was
    // saved as 1.00 and the eq. does not match) is visible rather than silent.
    const loose = `user_id=eq.${USER_ID}&${t.column}=eq.${encodeURIComponent(t.value)}&select=*`;
    const res = await fetch(`${SB_URL}/rest/v1/${t.table}?${loose}`, { headers });
    if (!res.ok) {
      console.error(`  ${t.table}: query failed — ${res.status} ${await res.text()}`);
      continue;
    }
    const rows: any[] = await res.json();
    if (rows.length === 0) {
      console.log(`  ${t.table}: no match for "${t.value}" — already clean`);
      continue;
    }
    found += rows.length;
    for (const r of rows) {
      console.log(`  ${t.table}: ${r.id}  ${JSON.stringify({ [t.column]: r[t.column], amount: r.amount, date: r.date })}`);
    }
    if (!APPLY) continue;

    const del = await fetch(`${SB_URL}/rest/v1/${t.table}?${filterFor(t)}`, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=representation" },
    });
    if (!del.ok) {
      console.error(`  ${t.table}: DELETE failed — ${del.status} ${await del.text()}`);
      continue;
    }
    const deleted: any[] = await del.json();
    console.log(`  ${t.table}: deleted ${deleted.length}`);
  }

  console.log(`\n${found} row(s) matched.`);
  if (found > 0 && !APPLY) console.log("Re-run with --apply to delete them.");
}

main().catch(e => { console.error(e); process.exit(1); });
