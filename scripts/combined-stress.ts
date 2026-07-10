/**
 * Combined-command stress test — multi-action messages against the REAL chat.
 *
 * Each probe sends ONE message that demands SEVERAL writes (cross-domain
 * where possible), then verifies EVERY claimed effect independently in the
 * DB via the UI's REST endpoints. Also measures wall-clock latency and
 * flags timeouts (>60s soft, >90s = the server's own wall-clock guard),
 * HTTP failures, and partially-executed messages.
 *
 * Output: per-probe ✅/🟡/❌ with per-item breakdown + a working/not-working
 * summary table (markdown report file).
 *
 * Run: npx tsx scripts/combined-stress.ts [--only=N]
 */
import { writeFileSync } from "fs";
import { api } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `CMB_${Date.now().toString(36)}`;
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  return Array.isArray(r.data) ? r.data : (r.data?.items || []);
}

interface ItemCheck { label: string; verify: () => Promise<boolean> }
interface Probe {
  name: string;
  message: string;
  items: ItemCheck[];
  /** Confirmation follow-up if the reply asks a question. */
  confirmOnAsk?: boolean;
  seed?: () => Promise<void>;
}

interface ProbeResult {
  name: string; status: number; elapsedMs: number; tools: string[];
  reply: string; itemsOk: string[]; itemsFail: string[];
  verdict: "PASS" | "PARTIAL" | "FAIL" | "TIMEOUT/ERROR";
}
const RESULTS: ProbeResult[] = [];

const PROBES: Probe[] = [
  {
    name: "3 domains in one message (expense + task + hydration)",
    message: `Add a $47.82 ${TAG}_grocery expense, create a task to ${TAG}_plumber call the plumber tomorrow, and log 8 glasses of water.`,
    items: [
      { label: "expense $47.82", verify: async () => (await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_grocery`) && Math.abs(e.amount - 47.82) < 0.01) },
      { label: "task tomorrow", verify: async () => (await list("/tasks")).some((t) => (t.title || "").includes(`${TAG}_plumber`)) },
      { label: "hydration entry (8 glasses)", verify: async () => {
        const tr = (await list("/trackers")).find((x) => /hydration|water/i.test(x.name || ""));
        return !!tr && (tr.entries || []).slice(-5).some((e: any) => /8|64/.test(JSON.stringify(e.values)));
      } },
    ],
  },
  {
    name: "Profile + event + recurring reminder in one",
    message: `Create a profile for my dog ${TAG}_Rex, a beagle, add a vet appointment for him on ${plusDays(6)} at 3pm, and a monthly ${TAG}_heartgard reminder starting ${plusDays(2)}.`,
    items: [
      { label: "pet profile", verify: async () => (await list("/profiles")).some((p) => (p.name || "").includes(`${TAG}_Rex`)) },
      { label: "vet event linked to Rex", verify: async () => {
        const profiles = await list("/profiles");
        const rex = profiles.find((p) => (p.name || "").includes(`${TAG}_Rex`));
        const ev = (await list("/events")).find((e) => /vet/i.test(e.title || "") && String(e.date || "").startsWith(plusDays(6)));
        return !!ev && (!rex || (ev.linkedProfiles || []).includes(rex.id));
      } },
      { label: "heartgard reminder", verify: async () => (await list("/reminders")).some((r) => (r.title || "").toLowerCase().includes(`${TAG}_heartgard`.toLowerCase())) },
    ],
  },
  {
    name: "3 tracker entries (nutrition + weight + supplement)",
    message: `Log breakfast: 3 eggs and toast, about 450 calories. My weight was 182 lbs this morning, and I took my multivitamin.`,
    items: [
      { label: "nutrition 450 cal", verify: async () => {
        const tr = (await list("/trackers")).filter((x) => /nutrition|calorie|food|meal/i.test(x.name || ""));
        return tr.some((x) => (x.entries || []).slice(-5).some((e: any) => /450/.test(JSON.stringify(e.values))));
      } },
      { label: "weight 182", verify: async () => {
        const tr = (await list("/trackers")).find((x) => /weight/i.test(x.name || ""));
        return !!tr && (tr.entries || []).slice(-5).some((e: any) => /182/.test(JSON.stringify(e.values)));
      } },
      { label: "multivitamin taken", verify: async () => {
        const tr = (await list("/trackers")).find((x) => /multivitamin/i.test(x.name || ""));
        return !!tr && (tr.entries || []).length > 0;
      } },
    ],
  },
  {
    name: "BP + heart rate dual log (regression of audit fix)",
    message: `Log a blood pressure reading of 126/82 with a resting heart rate of 61 BPM.`,
    items: [
      { label: "BP entry 126/82 (no pulse inside)", verify: async () => {
        const tr = (await list("/trackers")).find((x) => /blood\s*pressure/i.test(x.name || ""));
        return !!tr && (tr.entries || []).slice(-3).some((e: any) => /126/.test(JSON.stringify(e.values)) && /82/.test(JSON.stringify(e.values)));
      } },
      { label: "Heart Rate entry 61", verify: async () => {
        const tr = (await list("/trackers")).find((x) => /heart\s*rate/i.test(x.name || ""));
        return !!tr && (tr.entries || []).slice(-3).some((e: any) => /61/.test(JSON.stringify(e.values)));
      } },
    ],
  },
  {
    name: "Finance combo: two expenses + linked reminder",
    message: `I paid the electric bill $89.50 and renewed my ${TAG}_insurance car insurance for $612 — log both as expenses, and remind me on ${plusDays(150)} to shop around before the insurance renews.`,
    items: [
      { label: "electric expense 89.50", verify: async () => (await list("/expenses")).some((e) => /electric/i.test(e.description || "") && Math.abs(e.amount - 89.5) < 0.01) },
      { label: "insurance expense 612", verify: async () => (await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_insurance`) && Math.abs(e.amount - 612) < 0.01) },
      { label: "renewal reminder", verify: async () => (await list("/reminders")).some((r) => /insurance|shop/i.test(r.title || "") && String(r.fireAt || "").startsWith(plusDays(150).slice(0, 7))) },
    ],
  },
  {
    name: "6-item mega message",
    message: `Busy day: add a task ${TAG}_taxes to file taxes by ${plusDays(15)}, a dentist event ${TAG}_teeth on ${plusDays(9)} at 10am, log a $12.50 ${TAG}_lunch expense, check in my reading habit, log 30 minutes of yoga, and save a note that ${TAG}_memo the garage code is 4482.`,
    seed: async () => {
      const r = await api("POST", "/habits", { name: "Reading", frequency: "daily" });
      if (!r.ok && r.status !== 409) { /* may already exist */ }
    },
    items: [
      { label: "task taxes", verify: async () => (await list("/tasks")).some((t) => (t.title || "").includes(`${TAG}_taxes`)) },
      { label: "dentist event", verify: async () => (await list("/events")).some((e) => (e.title || "").includes(`${TAG}_teeth`)) },
      { label: "lunch expense 12.50", verify: async () => (await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_lunch`)) },
      { label: "reading habit checked", verify: async () => {
        const h = (await list("/habits")).find((x) => /reading/i.test(x.name || ""));
        return !!h && (h.checkins || []).some((c: any) => c.date === today);
      } },
      { label: "yoga 30 min", verify: async () => {
        const tr = (await list("/trackers")).filter((x) => /yoga|exercise|fitness|workout/i.test(x.name || ""));
        return tr.some((x) => (x.entries || []).slice(-5).some((e: any) => /30/.test(JSON.stringify(e.values))));
      } },
      { label: "memory saved (garage code)", verify: async () => (await list("/memories")).some((m) => JSON.stringify(m).includes("4482")) },
    ],
  },
  {
    name: "Mixed recurring + one-time (the classic poison test)",
    message: `Add a $19.99 ${TAG}_appletv subscription expense (one-time), and a ${TAG}_gym gym membership bill at $45 every month starting on the 1st.`,
    items: [
      { label: "one-time Apple TV EXPENSE (not a bill)", verify: async () => (await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_appletv`)) },
      { label: "gym BILL (recurring obligation)", verify: async () => (await list("/obligations")).some((o) => (o.name || "").includes(`${TAG}_gym`) && /month/i.test(o.frequency || "")) },
    ],
  },
  {
    name: "Cross-profile combo (two people, one message)",
    message: `Add a task for Bob ${TAG} to ${TAG}_bobmow mow the lawn Saturday, and one for Jane ${TAG} to ${TAG}_janebook book flights by ${plusDays(7)}.`,
    seed: async () => {
      await api("POST", "/profiles", { name: `Bob ${TAG}`, type: "person" });
      await api("POST", "/profiles", { name: `Jane ${TAG}`, type: "person" });
    },
    items: [
      { label: "Bob's task owned by Bob", verify: async () => {
        const profiles = await list("/profiles");
        const bob = profiles.find((p) => (p.name || "") === `Bob ${TAG}`);
        const t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_bobmow`));
        return !!t && !!bob && (t.linkedProfiles || []).includes(bob.id);
      } },
      { label: "Jane's task owned by Jane", verify: async () => {
        const profiles = await list("/profiles");
        const jane = profiles.find((p) => (p.name || "") === `Jane ${TAG}`);
        const t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_janebook`));
        return !!t && !!jane && (t.linkedProfiles || []).includes(jane.id);
      } },
      { label: "no cross-contamination", verify: async () => {
        const profiles = await list("/profiles");
        const bob = profiles.find((p) => (p.name || "") === `Bob ${TAG}`);
        const jane = profiles.find((p) => (p.name || "") === `Jane ${TAG}`);
        const tb = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_bobmow`));
        return !!tb && !!bob && !!jane && !(tb.linkedProfiles || []).includes(jane.id);
      } },
    ],
  },
  {
    name: "Read + write combo (question and action in one)",
    message: `What's my monthly spend so far? Also add a $9 ${TAG}_carwash expense.`,
    items: [
      { label: "carwash expense", verify: async () => (await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_carwash`)) },
    ],
  },
  {
    name: "Update + create combo",
    message: `Rename the ${TAG}_taxes task to "${TAG}_taxes file federal AND state taxes", and add a reminder for it 3 days before it's due.`,
    items: [
      { label: "task renamed", verify: async () => (await list("/tasks")).some((t) => /federal AND state/i.test(t.title || "")) },
      { label: "reminder ~3 days before due", verify: async () => (await list("/reminders")).some((r) => /tax/i.test(r.title || "")) },
    ],
  },
  {
    name: "Heavy read (report generation — timeout probe)",
    message: `Generate a report summarizing my finances this month: income, spending by category, upcoming bills, and net worth.`,
    items: [
      { label: "reply is substantive (no timeout/error)", verify: async () => true },
    ],
  },
  {
    name: "Bulk complete + targeted delete in one",
    message: `Mark the ${TAG}_taxes task complete and delete the ${TAG}_plumber task.`,
    items: [
      { label: "taxes task completed", verify: async () => {
        const t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_taxes`));
        return !!t && (t.status === "done" || t.completed === true);
      } },
      { label: "plumber task deleted", verify: async () => !(await list("/tasks")).some((x) => (x.title || "").includes(`${TAG}_plumber`)) },
    ],
    confirmOnAsk: true,
  },
];

async function runProbe(p: Probe): Promise<void> {
  if (p.seed) { try { await p.seed(); } catch { /* seed best-effort */ } await sleep(1200); }
  const t0 = Date.now();
  let r = await api("POST", "/chat", { message: p.message });
  if (r.status === 429) { await sleep(8000); r = await api("POST", "/chat", { message: p.message }); }
  let elapsed = Date.now() - t0;
  let d: any = r.data || {};
  let reply = String(d.reply || "");
  const tools: string[] = [...new Set([
    ...(Array.isArray(d.results) ? d.results.map((x: any) => x?.action) : []),
    ...(Array.isArray(d.actions) ? d.actions.map((a: any) => a?.type) : []),
  ].filter((x: any) => typeof x === "string"))];

  // Confirmation follow-up (deletes ask by design)
  if (p.confirmOnAsk && /\?|confirm|sure|should i/i.test(reply)) {
    await sleep(4000);
    const r2 = await api("POST", "/chat", {
      message: "Yes — go ahead with all of it.",
      history: [{ role: "user", content: p.message }, { role: "assistant", content: reply }],
    });
    const d2: any = r2.data || {};
    reply = String(d2.reply || reply);
    elapsed = Date.now() - t0;
  }

  await sleep(3000);
  const ok: string[] = [];
  const fail: string[] = [];
  for (const item of p.items) {
    (await item.verify().catch(() => false)) ? ok.push(item.label) : fail.push(item.label);
  }
  const httpBad = r.status !== 200;
  const timedOut = elapsed > 90_000 || /timed out|Load failed|took too long/i.test(reply);
  const verdict: ProbeResult["verdict"] = httpBad || timedOut
    ? "TIMEOUT/ERROR"
    : fail.length === 0 ? "PASS" : ok.length > 0 ? "PARTIAL" : "FAIL";
  RESULTS.push({ name: p.name, status: r.status, elapsedMs: elapsed, tools, reply: reply.slice(0, 160), itemsOk: ok, itemsFail: fail, verdict });
  const mark = verdict === "PASS" ? "✅" : verdict === "PARTIAL" ? "🟡" : "❌";
  console.log(`${mark} ${p.name} [${(elapsed / 1000).toFixed(1)}s, http ${r.status}] tools=${tools.join(",") || "-"}`);
  if (fail.length) console.log(`   failed items: ${fail.join(" | ")}`);
  if (fail.length) console.log(`   reply: ${reply.slice(0, 140)}`);
  await sleep(4500); // chat budget
}

async function cleanup() {
  for (const ep of ["/tasks", "/expenses", "/events", "/reminders", "/obligations", "/memories"]) {
    try {
      for (const row of await list(ep)) {
        if (JSON.stringify(row).includes(TAG)) await api("DELETE", `${ep}/${row.id}`).catch(() => {});
      }
    } catch { /* */ }
  }
  const profiles = await list("/profiles");
  for (const p of profiles) if ((p.name || "").includes(TAG)) await api("DELETE", `/profiles/${p.id}`).catch(() => {});
}

(async () => {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const probes = onlyArg ? [PROBES[Number(onlyArg) - 1]].filter(Boolean) : PROBES;
  console.log(`\n═══ COMBINED-COMMAND STRESS (${TAG}) at ${API_BASE} — ${probes.length} probes ═══\n`);
  for (const p of probes) {
    try { await runProbe(p); } catch (e: any) {
      RESULTS.push({ name: p.name, status: 0, elapsedMs: 0, tools: [], reply: String(e?.message || e), itemsOk: [], itemsFail: p.items.map((i) => i.label), verdict: "TIMEOUT/ERROR" });
      console.log(`💥 ${p.name}: ${e?.message || e}`);
    }
  }
  await cleanup();

  const lines: string[] = [`# Combined-command stress — ${new Date().toISOString()}`, ""];
  lines.push(`| # | Probe | Latency | HTTP | Tools | Items OK | Items failed | Verdict |`);
  lines.push(`|---|-------|---------|------|-------|----------|--------------|---------|`);
  RESULTS.forEach((x, i) => lines.push(
    `| ${i + 1} | ${x.name} | ${(x.elapsedMs / 1000).toFixed(1)}s | ${x.status} | ${x.tools.join(", ") || "-"} | ${x.itemsOk.length ? x.itemsOk.join("; ") : "-"} | ${x.itemsFail.length ? x.itemsFail.join("; ") : "-"} | ${x.verdict} |`
  ));
  const pass = RESULTS.filter((x) => x.verdict === "PASS").length;
  lines.push("", `**${pass}/${RESULTS.length} probes fully passed.** Partial = some items in the message executed, others silently didn't.`);
  const report = lines.join("\n");
  writeFileSync(`docs/combined-stress-${TAG}.md`, report);
  console.log(`\n${report}`);
  process.exit(RESULTS.every((x) => x.verdict === "PASS") ? 0 : 1);
})();
