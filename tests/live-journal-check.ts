// Live check (production, smoke account): the Journal / Quick Notes / mood
// tutorial script (rules J1–J5). Replays each step the QA run of 2026-11-20
// reported broken, against the deployed app and the real model. Takes the gate
// lock, writes only today's journal entry and notes it tags, and removes them.
//   npx tsx tests/live-journal-check.ts
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const note = (what: string) => console.log(`NOTE  ${what}`);

async function get(path: string): Promise<any> {
  const r = await api("GET", path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.data;
}
async function chat(message: string): Promise<{ reply: string; raw: any }> {
  const r = await api("POST", "/chat", { message, history: [] });
  if (!r.ok) throw new Error(`POST /chat: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return { reply: String(r.data?.reply || ""), raw: r.data };
}
const journal = async (): Promise<any[]> => get("/journal");
const trackerEntryCount = async (): Promise<number> =>
  ((await get("/trackers")) as any[]).reduce((n, t) => n + (Array.isArray(t.entries) ? t.entries.length : 0), 0);

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-journal-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startIds = new Set((await journal()).map((j) => j.id));
  const created = async () => (await journal()).filter((j) => !startIds.has(j.id));
  const dropCreated = async () => { for (const j of await created()) await api("DELETE", `/journal/${j.id}`).catch(() => undefined); };
  // One entry per day: today's must be this run's own. Whatever the account
  // holds for the last two days is cleared first (smoke account only).
  const recent = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  for (const j of await journal()) if (String(j.date) >= recent) { await api("DELETE", `/journal/${j.id}`); startIds.delete(j.id); }

  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}\n`);

    // ── #2  "…Save this as today's journal entry" ─────────────────────────
    const before = await trackerEntryCount();
    const s2 = await chat("I had a pretty good day today. I went for a 3 mile run this morning and took a walk after dinner. Save this as today's journal entry");
    let mine = await created();
    check(mine.length === 1, `#2 the message was saved as one journal entry (got ${mine.length}; reply: ${s2.reply.slice(0, 120)})`);
    check(!/needs content or mood/i.test(JSON.stringify(s2.raw)), `#2 no "needs content or mood" error`);
    check(/pretty good day/i.test(mine[0]?.content || "") && /3 mile run/i.test(mine[0]?.content || ""), `#2 the entry holds the user's own words (got "${String(mine[0]?.content).slice(0, 80)}")`);
    check(mine[0]?.mood === "good", `#2 its mood is Good (got ${mine[0]?.mood})`);
    const logged = (await trackerEntryCount()) - before;
    // Guidance, not a veto (tests/no-intent-veto.test.ts): reported, and it
    // fails the run so a model that starts logging again is seen.
    check(logged === 0, `#2 no run / walk was logged to a tracker (${logged} new tracker entr${logged === 1 ? "y" : "ies"})`);
    await dropCreated();

    // ── #3  mood detection and honest wording ─────────────────────────────
    const s3 = await chat("I'm feeling frustrated and overwhelmed with work today. Journal this.");
    mine = await created();
    check(mine.length === 1, `#3 the entry was saved (got ${mine.length})`);
    check(["bad", "awful", "terrible"].includes(mine[0]?.mood), `#3 "frustrated and overwhelmed" is not Neutral (got ${mine[0]?.mood})`);
    check(!/\bupdated\b/i.test(s3.reply), `#3 a new entry is not called "Updated" (reply: ${s3.reply.slice(0, 120)})`);
    const entryId = mine[0]?.id;
    const entryDate = mine[0]?.date;

    await chat("Add this to today's journal: I also went grocery shopping after work.");
    mine = await created();
    check(mine.length === 1 && /frustrated/i.test(mine[0].content) && /grocery/i.test(mine[0].content), `adding to today's entry keeps what was there (got "${String(mine[0]?.content).slice(0, 120)}")`);

    // ── #4  a manual entry does not replace the day's entry ───────────────
    const post = await api("POST", "/journal", { content: `Walked the dog ${tag}`, entryDate, tags: [] });
    check(post.ok && post.data?.appended === true && post.data?.id === entryId, `#4 a manual entry for the same day is joined onto it (appended=${post.data?.appended})`);
    const patch = await api("PATCH", `/journal/${entryId}`, { find: `Walked the dog ${tag}`, replace: `Walked the dog and cooked dinner ${tag}` });
    mine = await created();
    const text = String(mine[0]?.content || "");
    check(patch.ok && mine.length === 1 && /frustrated/i.test(text) && /grocery/i.test(text) && text.includes(`cooked dinner ${tag}`),
      `#4 after the composer's autosave the earlier text is still there (got "${text.slice(0, 160)}")`);
    check(["bad", "awful", "terrible"].includes(mine[0]?.mood), `#4 the day's mood was not changed by text with no feeling in it (got ${mine[0]?.mood})`);

    // ── #5  backdated entry ───────────────────────────────────────────────
    const back = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
    const old = (await journal()).find((j) => j.date === back);
    if (old) note(`#5 skipped: the account already has an entry on ${back}`);
    else {
      const b = await api("POST", "/journal", { content: `Backdated ${tag}`, entryDate: back });
      check(b.ok && b.data?.date === back, `#5 an entry can be filed under an earlier day (got ${b.data?.date})`);
    }

    // ── #6  a manual note is a Note ───────────────────────────────────────
    const n = await api("POST", "/notes", { title: `Car Maintenance Ideas ${tag}`, content: `Buy new tires for the Honda before winter ${tag}` });
    check(n.ok && n.data?.title === `Car Maintenance Ideas ${tag}`, `#6 a manual note saves with its title (got "${n.data?.title}")`);
    const arts = (await get("/artifacts")) as any[];
    check(arts.some((a) => a.id === n.data?.id && a.type === "note"), `#6 it shows in Notes & Artifacts`);

    // ── #7  chat reads them back ──────────────────────────────────────────
    const r1 = await chat("Show me my journal entry from today");
    check(/frustrated/i.test(r1.reply) && !/warranty/i.test(r1.reply) && !r1.raw?.documentPreview, `#7 "Show me my journal entry from today" shows the entry (reply: ${r1.reply.slice(0, 100)})`);
    const r2 = await chat("What was my mood earlier today?");
    check(/\b(bad|awful|terrible)\b/i.test(r2.reply) && !/can't see|cannot see|don't have access/i.test(r2.reply), `#7 "What was my mood earlier today?" answers from the journal (reply: ${r2.reply.slice(0, 100)})`);
    const r3 = await chat("Find my note about buying new tires");
    check(r3.reply.includes(tag) && /Honda/.test(r3.reply) && !r3.raw?.documentPreview, `#7 "Find my note about buying new tires" shows the note (reply: ${r3.reply.slice(0, 100)})`);
    const r4 = await chat("Summarize what I wrote in my journal today");
    check(/frustrat|overwhelm|grocer|work/i.test(r4.reply) && !/only see|can't see|cannot see|don't have access/i.test(r4.reply), `#7 "Summarize what I wrote in my journal today" summarises the text (reply: ${r4.reply.slice(0, 140)})`);
    check((await created()).filter((j) => j.date === entryDate).length === 1, `the four questions wrote nothing to the journal`);

    // ── #8  "last written" time ───────────────────────────────────────────
    const fresh = (await journal()).find((j) => j.id === entryId);
    const age = Date.now() - new Date(fresh?.updatedAt).getTime();
    check(age >= 0 && age < 15 * 60_000, `#8 the entry reports when it was last written (updatedAt ${Math.round(age / 1000)}s ago)`);
  } finally {
    await dropCreated().catch(() => undefined);
    for (const a of ((await get("/artifacts").catch(() => [])) as any[]).filter((a) => String(a.title || "").includes(tag) || String(a.content || "").includes(tag))) {
      await api("DELETE", `/notes/${a.id}`).catch(() => undefined);
    }
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
