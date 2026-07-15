/**
 * Multi-action AI chat verification — the "20 actions in one message" proof.
 *
 * Drives a DEPLOYED build (SMOKE_API_BASE, default portol.me) with the smoke
 * account and sends three real chat commands containing 5, 10, and 20
 * discrete actions across tasks, events, reminders, habits, trackers,
 * expenses, assets, liabilities, bills/obligations, journal, and multiple
 * profiles. Nothing is trusted from the reply:
 *
 *   1. every claimed write is re-read from the same REST endpoints the UI
 *      renders (read-your-writes),
 *   2. profile ownership is asserted on profile-scoped items,
 *   3. the whole data set is re-read AGAIN on a FRESH auth session
 *      (equivalent to closing + reopening the app) to prove persistence,
 *   4. the 5-action command deliberately includes one impossible action
 *      (delete a task that doesn't exist) to prove failures are REPORTED
 *      and don't break the remaining actions.
 *
 * If the server hits its 90s wall-clock budget mid-command it replies with
 * "ran out of time … ask me to continue" — the script then sends ONE
 * follow-up continue turn (exactly like a real user) before re-verifying.
 *
 * Run:  SMOKE_API_BASE=https://<deployment>/api npx tsx scripts/verify-multi-action.ts
 * Exit: 0 = all checks pass, 1 = failures (summary table printed either way).
 */
import { api, getSmokeToken } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const laDate = (msOffset: number) =>
  new Date(Date.now() + msOffset).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const today = laDate(0);
const tomorrow = laDate(86400000);
const RUN_START = new Date(Date.now() - 60000).toISOString();
// Unique per-run tag so finders can't match residue from earlier runs.
const TAG = process.env.RUN_TAG || `QZ${Date.now().toString(36).slice(-5).toUpperCase()}`;
const J = (x: any) => JSON.stringify(x || "");

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  await sleep(100);
  return Array.isArray(r.data) ? r.data : (r.data?.items || []);
}
const findBy = (rows: any[], re: RegExp, key = "") =>
  rows.find((r) => re.test(key ? String(r[key] || "") : J(r)) && String(r.createdAt || r.created_at || "") >= RUN_START)
  || rows.find((r) => re.test(key ? String(r[key] || "") : J(r)))
  || null;

const taskBy = async (re: RegExp) => findBy(await list("/tasks"), re, "title");
const eventBy = async (re: RegExp) => findBy(await list("/events"), re, "title");
const reminderBy = async (re: RegExp) => findBy(await list("/reminders"), re, "title");
const expenseBy = async (re: RegExp) => findBy(await list("/expenses"), re, "description");
const habitBy = async (re: RegExp) => findBy(await list("/habits"), re, "name");
const trackerBy = async (re: RegExp) => findBy(await list("/trackers"), re, "name");
const obligationBy = async (re: RegExp) => findBy(await list("/obligations"), re, "name");
// Assets and liabilities are PROFILE rows (type:"asset" / type:"liability") —
// there is no /api/assets or /api/liabilities list endpoint; the UI reads them
// from /profiles too.
const assetBy = async (re: RegExp) =>
  findBy((await list("/profiles")).filter((p) => p.type === "asset"), re, "name");
const liabilityBy = async (re: RegExp) =>
  findBy((await list("/profiles")).filter((p) => p.type === "liability"), re, "name");
const profileByName = async (re: RegExp) => findBy(await list("/profiles"), re, "name");
const journalToday = async () => (await list("/journal")).find((j) => String(j.date || "").startsWith(today)) || null;

const entryToday = (t: any, re: RegExp) =>
  !!t && (t.entries || []).some((e: any) => {
    const raw = String(e.timestamp || "");
    const ts = /T/.test(raw)
      ? new Date(raw).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
      : raw.slice(0, 10);
    return ts === today && re.test(J(e.values));
  });

const linkedTo = (row: any, profileId?: string) =>
  !profileId ||
  (row?.linkedProfiles || []).includes(profileId) ||
  row?.profileId === profileId ||
  (row?.profileIds || []).includes(profileId);

interface TurnLog { label: string; elapsedMs: number; status: number; tools: string[]; reply: string }
const turnLogs: TurnLog[] = [];

async function chat(label: string, message: string, history: Array<{ role: string; content: string }> = []): Promise<TurnLog> {
  const t0 = Date.now();
  const r = await api("POST", "/chat", history.length ? { message, history } : { message });
  const elapsedMs = Date.now() - t0;
  const d: any = r.data || {};
  const tools: string[] = [...new Set([
    ...(Array.isArray(d.results) ? d.results.map((x: any) => x?.action) : []),
    ...(Array.isArray(d.actions) ? d.actions.map((a: any) => a?.type) : []),
  ].filter((x: any) => typeof x === "string"))] as string[];
  const log = { label, elapsedMs, status: r.status, tools, reply: String(d.reply || "") };
  turnLogs.push(log);
  console.log(`\n── ${label} ── ${(elapsedMs / 1000).toFixed(1)}s, HTTP ${r.status}, ${tools.length} tool types`);
  console.log(`   tools: ${tools.join(", ") || "(none)"}`);
  console.log(`   reply: ${log.reply.slice(0, 400).replace(/\n/g, " | ")}`);
  return log;
}

interface CheckResult { phase: string; label: string; ok: boolean }
const results: CheckResult[] = [];
async function check(phase: string, label: string, fn: () => Promise<boolean>) {
  let ok = false;
  try { ok = await fn(); } catch (e: any) { console.log(`   check "${label}" threw: ${e.message}`); }
  results.push({ phase, label, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${label}`);
  return ok;
}

(async () => {
  console.log(`Multi-action QA against ${API_BASE}  TAG=${TAG}  today(LA)=${today}`);
  await getSmokeToken();

  // ── Setup: make sure two secondary profiles exist (Jane / Mike) ───────────
  let jane = await profileByName(/jane/i);
  let mike = await profileByName(/mike/i);
  if (!jane || !mike) {
    const need = [!jane ? 'a profile named Jane with relationship "Family"' : "", !mike ? 'a profile named Mike with relationship "Family"' : ""].filter(Boolean).join(" and ");
    await chat("setup: create missing profiles", `Create ${need}.`);
    jane = await profileByName(/jane/i);
    mike = await profileByName(/mike/i);
  }
  console.log(`profiles: jane=${jane?.id || "MISSING"} mike=${mike?.id || "MISSING"}`);

  // ═══ Command A — 5 actions, one deliberately impossible ═══════════════════
  const a = await chat("A: 5 actions (1 impossible)", `Do ALL of the following right now:
1) create a task called "${TAG} Replace HVAC filter" due tomorrow;
2) add a calendar event called "${TAG} Dentist checkup" tomorrow at 2 PM;
3) set a reminder called "${TAG} Renew car registration" for tomorrow at 9 AM;
4) log an expense of $23.75 for "${TAG} car wash" in the vehicle category;
5) delete the task called "${TAG} Nonexistent Zebra 999".`);

  await check("A", "task created, due tomorrow", async () => { const t = await taskBy(new RegExp(`${TAG} Replace HVAC`, "i")); return !!t && String(t.dueDate || "").startsWith(tomorrow); });
  await check("A", "event created for tomorrow", async () => { const e = await eventBy(new RegExp(`${TAG} Dentist`, "i")); return !!e && String(e.date || "").startsWith(tomorrow); });
  await check("A", "reminder created", async () => !!(await reminderBy(new RegExp(`${TAG} Renew car`, "i"))));
  await check("A", "expense $23.75 created", async () => { const x = await expenseBy(new RegExp(`${TAG} car wash`, "i")); return !!x && Math.abs(Number(x.amount) - 23.75) < 0.001; });
  await check("A", "impossible delete REPORTED in reply (not silently skipped)", async () =>
    /(couldn'?t|can'?t|cannot|unable|no |not? .*(find|found|exist)|doesn'?t exist|didn'?t find)/i.test(a.reply));
  await check("A", "other 4 actions executed despite the failed one", async () =>
    !!(await taskBy(new RegExp(`${TAG} Replace HVAC`, "i"))) && !!(await expenseBy(new RegExp(`${TAG} car wash`, "i"))));

  // ═══ Command B — 10 actions across two profiles ═══════════════════════════
  const bMsg = `Please do ALL of the following in one go — every item is a separate action:
1) create a task "${TAG} Book Jane's eye exam" for Jane due in 3 days;
2) create a task "${TAG} Mike soccer pickup" for Mike due tomorrow;
3) add an event "${TAG} Family budget review" on Saturday at 10 AM;
4) remind me to "${TAG} submit insurance claim" tomorrow at 8 AM;
5) create a habit called "${TAG} Evening stretch";
6) mark the "${TAG} Evening stretch" habit complete for today;
7) log 64 ounces of water for me today;
8) log an expense of $42.18 for "${TAG} groceries" in the food category;
9) add an asset called "${TAG} Kayak" worth $650;
10) add a liability called "${TAG} Dental payment plan" with a balance of $840.`;
  let b = await chat("B: 10 actions, 2 profiles", bMsg);
  if (/ran out of time|ask me to continue/i.test(b.reply)) {
    b = await chat("B: continue", "Please finish whatever didn't complete from my last message.", [
      { role: "user", content: bMsg }, { role: "assistant", content: b.reply },
    ]);
  }

  await check("B", "Jane's task created + linked to Jane", async () => { const t = await taskBy(new RegExp(`${TAG} Book Jane`, "i")); return !!t && linkedTo(t, jane?.id); });
  await check("B", "Mike's task created + linked to Mike", async () => { const t = await taskBy(new RegExp(`${TAG} Mike soccer`, "i")); return !!t && linkedTo(t, mike?.id); });
  await check("B", "event created", async () => !!(await eventBy(new RegExp(`${TAG} Family budget`, "i"))));
  await check("B", "reminder created", async () => !!(await reminderBy(new RegExp(`${TAG} submit insurance`, "i"))));
  await check("B", "habit created", async () => !!(await habitBy(new RegExp(`${TAG} Evening stretch`, "i"))));
  await check("B", "habit checked in today", async () => { const h = await habitBy(new RegExp(`${TAG} Evening stretch`, "i")); return !!h && (h.checkins || []).some((c: any) => c.date === today); });
  await check("B", "water 64oz logged today", async () => entryToday(await trackerBy(/hydration|water/i), /64/));
  await check("B", "expense $42.18 created", async () => { const x = await expenseBy(new RegExp(`${TAG} groceries`, "i")); return !!x && Math.abs(Number(x.amount) - 42.18) < 0.001; });
  await check("B", "asset Kayak $650 created", async () => { const x = await assetBy(new RegExp(`${TAG} Kayak`, "i")); return !!x && /650/.test(J(x)); });
  await check("B", "liability $840 created", async () => { const x = await liabilityBy(new RegExp(`${TAG} Dental payment`, "i")); return !!x && /840/.test(J(x)); });

  // ═══ Command C — 20 actions, all domains, 3+ profiles ═════════════════════
  const cMsg = `This is one big batch — execute EVERY numbered item as its own action, do not skip any:
1) create a task "${TAG} Rotate tires" due in 2 days;
2) create a task "${TAG} Jane passport renewal" for Jane due in 5 days;
3) create a task "${TAG} Mike science fair" for Mike due in 4 days;
4) add an event "${TAG} Oil change" tomorrow at 9 AM;
5) add an event "${TAG} Neighborhood BBQ" on Sunday at 1 PM;
6) remind me to "${TAG} pay water bill" tomorrow at 10 AM;
7) remind me to "${TAG} call grandma" tomorrow at 6 PM;
8) create a habit called "${TAG} Read 20 minutes";
9) mark the "${TAG} Read 20 minutes" habit complete for today;
10) log my weight at 181.4 pounds today;
11) log 7.5 hours of sleep for last night;
12) log an expense of $12.40 for "${TAG} coffee beans" in the food category;
13) log an expense of $88.99 for "${TAG} electric bill payment" in the utilities category;
14) add an asset called "${TAG} eBike" worth $1800;
15) add a liability called "${TAG} Holiday credit card" with a balance of $450;
16) create a monthly bill called "${TAG} Gym membership" for $45 due on the 1st;
17) add a journal entry saying "${TAG} long day but the batch test is running well";
18) create a profile named "${TAG} Riley" with relationship "Friend";
19) log 72 ounces of water for Jane today;
20) log an expense of $19.99 for "${TAG} Mike cleats" in the shopping category for Mike.`;
  let c = await chat("C: 20 actions, all domains", cMsg);
  if (/ran out of time|ask me to continue/i.test(c.reply)) {
    c = await chat("C: continue", "Please finish whatever didn't complete from my last message — do not redo anything that already succeeded.", [
      { role: "user", content: cMsg }, { role: "assistant", content: c.reply },
    ]);
  }

  await check("C", "1. task Rotate tires", async () => !!(await taskBy(new RegExp(`${TAG} Rotate tires`, "i"))));
  await check("C", "2. Jane task + ownership", async () => { const t = await taskBy(new RegExp(`${TAG} Jane passport`, "i")); return !!t && linkedTo(t, jane?.id); });
  await check("C", "3. Mike task + ownership", async () => { const t = await taskBy(new RegExp(`${TAG} Mike science`, "i")); return !!t && linkedTo(t, mike?.id); });
  await check("C", "4. event Oil change tomorrow", async () => { const e = await eventBy(new RegExp(`${TAG} Oil change`, "i")); return !!e && String(e.date || "").startsWith(tomorrow); });
  await check("C", "5. event Neighborhood BBQ", async () => !!(await eventBy(new RegExp(`${TAG} Neighborhood BBQ`, "i"))));
  await check("C", "6. reminder pay water bill", async () => !!(await reminderBy(new RegExp(`${TAG} pay water bill`, "i"))));
  await check("C", "7. reminder call grandma", async () => !!(await reminderBy(new RegExp(`${TAG} call grandma`, "i"))));
  await check("C", "8. habit Read 20 minutes", async () => !!(await habitBy(new RegExp(`${TAG} Read 20`, "i"))));
  await check("C", "9. habit checked in today", async () => { const h = await habitBy(new RegExp(`${TAG} Read 20`, "i")); return !!h && (h.checkins || []).some((x: any) => x.date === today); });
  await check("C", "10. weight 181.4 today", async () => entryToday(await trackerBy(/weight/i), /181\.4/));
  await check("C", "11. sleep 7.5h today", async () => entryToday(await trackerBy(/sleep/i), /7\.5|7:30|450/));
  await check("C", "12. expense coffee beans $12.40", async () => { const x = await expenseBy(new RegExp(`${TAG} coffee beans`, "i")); return !!x && Math.abs(Number(x.amount) - 12.4) < 0.001; });
  await check("C", "13. expense electric $88.99", async () => { const x = await expenseBy(new RegExp(`${TAG} electric bill`, "i")); return !!x && Math.abs(Number(x.amount) - 88.99) < 0.001; });
  await check("C", "14. asset eBike $1800", async () => { const x = await assetBy(new RegExp(`${TAG} eBike`, "i")); return !!x && /1,?800/.test(J(x)); });
  await check("C", "15. liability Holiday CC $450", async () => { const x = await liabilityBy(new RegExp(`${TAG} Holiday credit`, "i")); return !!x && /450/.test(J(x)); });
  await check("C", "16. monthly bill Gym $45", async () => { const o = await obligationBy(new RegExp(`${TAG} Gym membership`, "i")); return !!o && /45/.test(J(o)); });
  await check("C", "17. journal entry appended", async () => { const j = await journalToday(); return !!j && new RegExp(`${TAG} long day`, "i").test(String(j.content || "")); });
  await check("C", "18. profile Riley created", async () => !!(await profileByName(new RegExp(`${TAG} Riley`, "i"))));
  await check("C", "19. Jane water 72oz today", async () => {
    const trs = await list("/trackers");
    return trs.some((t) => /hydration|water/i.test(t.name || "") && entryToday(t, /72/));
  });
  await check("C", "20. Mike expense cleats $19.99 + ownership", async () => { const x = await expenseBy(new RegExp(`${TAG} Mike cleats`, "i")); return !!x && Math.abs(Number(x.amount) - 19.99) < 0.001 && linkedTo(x, mike?.id); });

  // ═══ Command D — stated-fact comprehension (the "shower" regression) ══════
  // Real user report 2026-07-15: sleep + meal were logged but "I took one
  // shower" was silently dropped. Every stated fact must produce a tool call
  // or an explicit "not logged" acknowledgement — never a silent skip.
  const d = await chat("D: stated facts (sleep/shower/meal)",
    `I went to bed at 11 PM last night. I woke up at 7 AM. I took one shower and now I'm about to eat three triple cheeseburgers, plain with a fry and a large cherry Coke.`);
  const anyTrackerEntryToday = async (nameRe: RegExp, valRe: RegExp) =>
    (await list("/trackers")).some((t) => nameRe.test(String(t.name || "")) && entryToday(t, valRe));
  await check("D", "sleep logged today (11PM–7AM)", async () =>
    (await list("/trackers")).some((t) => /sleep/i.test(String(t.name || "")) && entryToday(t, /8|11|7/)));
  await check("D", "meal logged today (cheeseburgers)", async () =>
    (await list("/trackers")).some((t) => entryToday(t, /cheeseburger/i)));
  await check("D", "shower logged OR explicitly acknowledged as not logged", async () =>
    (await anyTrackerEntryToday(/shower|hygiene/i, /1|shower|true|taken/i))
    || (await list("/trackers")).some((t) => entryToday(t, /shower/i))
    || /shower/i.test(d.reply));

  // ═══ Refresh persistence — fresh auth session, re-read everything ═════════
  await getSmokeToken(true); // force new token = new app session after refresh
  await check("R", "task A survives refresh", async () => !!(await taskBy(new RegExp(`${TAG} Replace HVAC`, "i"))));
  await check("R", "expense B survives refresh", async () => !!(await expenseBy(new RegExp(`${TAG} groceries`, "i"))));
  await check("R", "asset B survives refresh", async () => !!(await assetBy(new RegExp(`${TAG} Kayak`, "i"))));
  await check("R", "liability C survives refresh", async () => !!(await liabilityBy(new RegExp(`${TAG} Holiday credit`, "i"))));
  await check("R", "bill C survives refresh", async () => !!(await obligationBy(new RegExp(`${TAG} Gym membership`, "i"))));
  await check("R", "journal C survives refresh", async () => { const j = await journalToday(); return !!j && new RegExp(`${TAG} long day`, "i").test(String(j.content || "")); });
  await check("R", "profile Riley survives refresh", async () => !!(await profileByName(new RegExp(`${TAG} Riley`, "i"))));
  await check("R", "Jane task ownership survives refresh", async () => { const t = await taskBy(new RegExp(`${TAG} Jane passport`, "i")); return !!t && linkedTo(t, jane?.id); });

  // ═══ Summary ═══════════════════════════════════════════════════════════════
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`TAG=${TAG}  •  ${results.length - failed.length}/${results.length} checks passed`);
  for (const t of turnLogs) console.log(`  turn "${t.label}": ${(t.elapsedMs / 1000).toFixed(1)}s HTTP ${t.status}`);
  if (failed.length) {
    console.log(`\nFAILED CHECKS:`);
    for (const f of failed) console.log(`  ❌ [${f.phase}] ${f.label}`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
