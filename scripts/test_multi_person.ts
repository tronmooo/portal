// Multi-person comprehensive test. Runs ONE command per data type per person
// through processMessage() and reports DB evidence per command.
//
// PRINCIPLE: every command uses UNIQUE marker strings ("TestX_Bob_Running")
// so post-run we can attribute exactly which command produced which row.

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { processMessage } from "../server/ai-engine.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const USER_ID      = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";
const TAG          = "QAMULTI" + Date.now().toString().slice(-6); // unique tag in this run

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);
const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  requestStorageContext.run(storage as any, fn);

interface TestCase {
  n: number;
  category: string;     // "tracker" | "expense" | "habit" | "journal" | "task" | "event" | "goal" | "obligation" | "asset" | "liability"
  who: string;          // expected target profile name
  msg: string;
  marker: string;       // unique string in the message that will appear in saved data
}

// Marker convention: include TAG + category + who so a SQL WHERE can find it.
const C: TestCase[] = [
  // TRACKERS — one per person
  { n: 1,  category: "tracker",  who: "You",       msg: `I ran 3 miles today as my ${TAG}_tracker_self_run morning workout`,                      marker: `${TAG}_tracker_self_run` },
  { n: 2,  category: "tracker",  who: "Bob",       msg: `Bob lifted weights for 45 minutes — ${TAG}_tracker_bob_lift`,                            marker: `${TAG}_tracker_bob_lift` },
  { n: 3,  category: "tracker",  who: "Jane Doe",  msg: `Jane meditated for 20 minutes today — ${TAG}_tracker_jane_meditate`,                     marker: `${TAG}_tracker_jane_meditate` },
  { n: 4,  category: "tracker",  who: "Mike",      msg: `Mike played guitar for 30 minutes — ${TAG}_tracker_mike_guitar`,                         marker: `${TAG}_tracker_mike_guitar` },

  // EXPENSES — one per person
  { n: 5,  category: "expense",  who: "You",       msg: `I spent $42 at Trader Joe's — ${TAG}_expense_self_groc`,                                marker: `${TAG}_expense_self_groc` },
  { n: 6,  category: "expense",  who: "Bob",       msg: `Bob spent $67 on dinner at Olive Garden — ${TAG}_expense_bob_dinner`,                   marker: `${TAG}_expense_bob_dinner` },
  { n: 7,  category: "expense",  who: "Jane Doe",  msg: `Jane spent $19 on coffee at Blue Bottle — ${TAG}_expense_jane_coffee`,                  marker: `${TAG}_expense_jane_coffee` },

  // HABITS — create + check in
  { n: 8,  category: "habit",    who: "You",       msg: `Create habit "${TAG}_habit_self_read" — daily reading at 9pm and mark today complete`,  marker: `${TAG}_habit_self_read` },
  { n: 9,  category: "habit",    who: "Bob",       msg: `Create a habit for Bob called "${TAG}_habit_bob_run" — daily run, mark today done`,    marker: `${TAG}_habit_bob_run` },
  { n: 10, category: "habit",    who: "Jane Doe",  msg: `Add Jane's habit "${TAG}_habit_jane_yoga" — every morning, complete today`,            marker: `${TAG}_habit_jane_yoga` },

  // JOURNAL ENTRIES
  { n: 11, category: "journal",  who: "You",       msg: `Save a journal entry for me: "${TAG}_journal_self note about my day"`,                  marker: `${TAG}_journal_self` },
  { n: 12, category: "journal",  who: "Bob",       msg: `Write in Bob's journal: "${TAG}_journal_bob bob had a great workout"`,                  marker: `${TAG}_journal_bob` },
  { n: 13, category: "journal",  who: "Jane Doe",  msg: `Add a journal note for Jane: "${TAG}_journal_jane jane is feeling positive"`,           marker: `${TAG}_journal_jane` },

  // TASKS
  { n: 14, category: "task",     who: "You",       msg: `Add a task for me: ${TAG}_task_self call the dentist by Friday`,                       marker: `${TAG}_task_self` },
  { n: 15, category: "task",     who: "Bob",       msg: `Create a task for Bob: ${TAG}_task_bob renew his car registration next week`,           marker: `${TAG}_task_bob` },
  { n: 16, category: "task",     who: "Jane Doe",  msg: `Remind Jane to ${TAG}_task_jane book her flight by next Wednesday`,                     marker: `${TAG}_task_jane` },

  // EVENTS (calendar)
  { n: 17, category: "event",    who: "You",       msg: `Schedule ${TAG}_event_self_meeting at 2pm tomorrow on my calendar`,                     marker: `${TAG}_event_self_meeting` },
  { n: 18, category: "event",    who: "Bob",       msg: `Put ${TAG}_event_bob_haircut on Bob's calendar at 4pm Saturday`,                        marker: `${TAG}_event_bob_haircut` },

  // GOALS
  { n: 19, category: "goal",     who: "You",       msg: `Create a savings goal for me: ${TAG}_goal_self_emergency target $5000 by end of year`,  marker: `${TAG}_goal_self_emergency` },
  { n: 20, category: "goal",     who: "Bob",       msg: `Add a fitness goal for Bob: ${TAG}_goal_bob_marathon — run a marathon by October`,     marker: `${TAG}_goal_bob_marathon` },

  // OBLIGATIONS (recurring bills)
  { n: 21, category: "obligation", who: "You",     msg: `Add a recurring obligation: ${TAG}_oblig_self_gym $39.99 monthly on the 5th`,           marker: `${TAG}_oblig_self_gym` },
  { n: 22, category: "obligation", who: "Bob",     msg: `Create Bob's obligation: ${TAG}_oblig_bob_phone $85 monthly on the 12th`,               marker: `${TAG}_oblig_bob_phone` },

  // ASSETS (profile type = asset, linked to a person)
  { n: 23, category: "asset",    who: "Bob",       msg: `Add an asset for Bob: ${TAG}_asset_bob_kayak — kayak worth $800`,                       marker: `${TAG}_asset_bob_kayak` },
  { n: 24, category: "asset",    who: "Jane Doe",  msg: `Register Jane's asset: ${TAG}_asset_jane_camera — Sony camera worth $1500`,             marker: `${TAG}_asset_jane_camera` },

  // LIABILITIES (profile type = liability, linked to a person)
  { n: 25, category: "liability", who: "Bob",      msg: `Add a liability for Bob: ${TAG}_liab_bob_card — Chase credit card balance $2400`,       marker: `${TAG}_liab_bob_card` },
  { n: 26, category: "liability", who: "Jane Doe", msg: `Track Jane's liability: ${TAG}_liab_jane_loan — student loan balance $18000`,           marker: `${TAG}_liab_jane_loan` },
];

interface CmdResult {
  n: number;
  category: string;
  who: string;
  msg: string;
  marker: string;
  reply: string;
  duration_ms: number;
  error?: string;
}

async function run() {
  console.log(`Tag for this run: ${TAG}`);
  console.log(`Running ${C.length} commands...\n`);

  const results: CmdResult[] = [];

  for (const cmd of C) {
    const start = Date.now();
    let reply = "";
    let err: string | undefined;
    try {
      const result = await ctx(() => processMessage(cmd.msg, [], USER_ID));
      reply = (result as any).reply || "";
    } catch (e: any) {
      err = e?.message || String(e);
    }
    const dur = Date.now() - start;
    results.push({ n: cmd.n, category: cmd.category, who: cmd.who, msg: cmd.msg, marker: cmd.marker, reply, duration_ms: dur, error: err });
    console.log(`[#${cmd.n.toString().padStart(2)}] ${cmd.category}/${cmd.who} (${dur}ms) — reply: ${reply.slice(0, 80).replace(/\n/g, " ")}${err ? `  ERR: ${err.slice(0,80)}` : ""}`);
  }

  const fs = await import("fs");
  fs.writeFileSync(`/tmp/multi_${TAG}.json`, JSON.stringify({ tag: TAG, results }, null, 2));
  console.log(`\nResults: /tmp/multi_${TAG}.json`);
  console.log(`TAG: ${TAG}`);
}

run().catch(e => { console.error("FATAL:", e); process.exit(1); });
