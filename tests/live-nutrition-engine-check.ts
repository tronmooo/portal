// Live check (deployed app, smoke account, REAL model): the nutrition engine,
// end to end. Each case is said to the real chat endpoint (or a label picture
// is sent through the real upload endpoint), the client's after-reply lookup
// is run as the client runs it, and the entries the turn STORED are read back
// and compared with expected values that were obtained independently of the
// app (tests/fixtures/nutrition-e2e-cases.json names the source of each: a
// USDA FoodData Central record, an Open Food Facts barcode, a restaurant's
// published figures, or arithmetic on a label in the message).
//
// Nothing here is a unit test: the model, the databases and the store are the
// real ones. Every entry a case creates is deleted when the case ends. Takes
// the gate lock (it writes as the smoke account).
//
//   npx tsx tests/live-nutrition-engine-check.ts                 # everything
//   npx tsx tests/live-nutrition-engine-check.ts --only=G,H      # by id prefix
//   npx tsx tests/live-nutrition-engine-check.ts --ids=A03,L2    # by id
//   SMOKE_API_BASE=https://<preview>/api SMOKE_UI_BASE=https://<preview> …  # against a preview
//   --report=path.json writes every case's stored values, sources and reply.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { isNutritionTrackerLike, canonicalNutrientKey } from "../shared/nutrition-enrichment";

interface Case {
  id: string;
  category: string;
  say: string;
  expect: Record<string, number>;
  /** Checked against the provenance totals (nutrients that are not entry fields). */
  expectTotals?: Record<string, number>;
  source: string;
  tol?: { pct: number; abs: number };
  entries?: number;
  limits?: { maxCalories: number; maxProtein: number };
  image?: string;
}
interface Outcome {
  id: string; category: string; say: string; pass: boolean; why: string[];
  got: Record<string, number>; expect: Record<string, number>; entries: number;
  items: string[]; sources: string[]; verification: string[]; reply: string; ms: number; source: string;
}

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const only = (arg("only") || "").split(",").filter(Boolean);
const ids = (arg("ids") || "").split(",").filter(Boolean);
const reportPath = arg("report");
const FIX = join(process.cwd(), "tests", "fixtures");

// ── Label pictures (tests/fixtures/nutrition-labels/make-labels.mjs) ─────────
const GRANOLA = { calories: 230, fat: 9, carbs: 34, protein: 5, fiber: 4, sugar: 10, sodium: 115 };
const scale = (v: Record<string, number>, f: number) => Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Math.round(n * f * 100) / 100]));
const IMAGE_CASES: Case[] = [
  { id: "H01", category: "label-photo", image: "granola.png", say: "I ate 2 servings of this.", expect: scale(GRANOLA, 2), source: "Printed label × 2 servings", tol: { pct: 0, abs: 0.11 } },
  { id: "H02", category: "label-photo", image: "granola.png", say: "I ate 82.5 grams of this.", expect: scale(GRANOLA, 1.5), source: "Printed label: 82.5 g ÷ 55 g = 1.5 servings", tol: { pct: 0, abs: 0.11 } },
  { id: "H03", category: "label-photo", image: "granola.png", say: "I ate a third of a cup of this granola.", expect: scale(GRANOLA, 0.5), source: "Printed label: 1/3 cup ÷ 2/3 cup = 0.5 servings", tol: { pct: 0, abs: 0.2 } },
  { id: "H04", category: "label-photo", image: "keto-bar.png", say: "I ate half of this bar.", expect: { calories: 100, fat: 7, carbs: 11, protein: 6, fiber: 4.5, sodium: 90 }, expectTotals: { sugarAlcohol: 2, allulose: 3 }, source: "Printed label × 0.5 bar", tol: { pct: 0, abs: 0.11 } },
  { id: "H05", category: "label-photo", image: "drink.png", say: "I drank the whole bottle of this.", expect: { calories: 175, carbs: 42.5, protein: 2.5, sugar: 40, caffeine: 85 }, source: "Printed label: whole bottle × 2.5 servings", tol: { pct: 0, abs: 0.6 } },
  { id: "H06", category: "label-photo", image: "drink.png", say: "I drank 12 fl oz of this.", expect: { calories: 105, carbs: 25.5, protein: 1.5 }, source: "Printed label: 12 fl oz ÷ 8 fl oz = 1.5 servings", tol: { pct: 1.5, abs: 0.2 } },
  { id: "H07", category: "label-photo", image: "chips-dual.png", say: "I ate the entire bag of these chips.", expect: { calories: 450, fat: 27, carbs: 48, protein: 6, sodium: 510 }, source: "Printed label: whole bag = 3 servings (per-container column)", tol: { pct: 0, abs: 0.11 } },
  { id: "H08", category: "label-photo", image: "granola.png", say: "Log this food for me.", expect: GRANOLA, source: "Printed label, 1 serving (no amount stated: must be marked assumed)", tol: { pct: 0, abs: 0.11 } },
  { id: "H09", category: "label-photo", image: "granola-photo.png", say: "I ate 2 servings of this.", expect: scale(GRANOLA, 2), source: "Same label, tilted and blurred, × 2 servings", tol: { pct: 0, abs: 0.11 } },
  { id: "H10", category: "barcode-photo", image: "barcode.png", say: "I ate 30 g of this.", expect: { calories: 161.7, protein: 1.89, carbs: 17.25, fat: 9.27 }, source: "Open Food Facts product 3017620422003 (read from the picture's digits) × 30 g", tol: { pct: 4, abs: 1 } },
];

let failed = 0;
const outcomes: Outcome[] = [];

interface Row { trackerId: string; trackerName: string; nutrition: boolean; entry: any }
async function allEntries(): Promise<Row[]> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}/trackers`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET /trackers: ${response.status}`);
  const trackers: any[] = await response.json();
  return trackers.flatMap((t) => (t.entries || []).map((entry: any) => ({ trackerId: t.id, trackerName: t.name, nutrition: isNutritionTrackerLike(t), entry })));
}

/** One chat turn, plus the after-reply lookup exactly as the client runs it. */
async function chat(message: string, history: Array<{ role: string; content: string }> = []): Promise<any> {
  const r = await api("POST", "/chat", { message, history });
  if (!r.ok) throw new Error(`POST /chat: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  for (const c of Array.isArray(r.data?.pendingEnrichment) ? r.data.pendingEnrichment : []) {
    if (c?.target && c.target !== "trackerEntry") continue;
    if (c?.entryId) await api("POST", `/tracker-entries/${c.entryId}/enrich`, { trackerId: c.trackerId, message: c.message, intent: "auto" }).catch(() => undefined);
  }
  return r.data;
}
async function upload(image: string, message: string): Promise<any> {
  const fileData = readFileSync(join(FIX, "nutrition-labels", image)).toString("base64");
  const r = await api("POST", "/upload", { fileName: image, mimeType: "image/png", fileData, message, discardImage: true });
  if (!r.ok) throw new Error(`POST /upload: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

const round = (n: number) => Math.round(n * 100) / 100;
const sumOf = (rows: Row[], key: string) => round(rows.reduce((n, r) => n + (Number(Object.entries(r.entry.values || {}).find(([k]) => canonicalNutrientKey(k) === key)?.[1]) || 0), 0));
const totalOf = (rows: Row[], key: string) => round(rows.reduce((n, r) => n + (Number(r.entry.computed?.nutrition?.totals?.[key]?.value) || 0), 0));
const within = (got: number, want: number, tol: { pct: number; abs: number }) => Math.abs(got - want) <= Math.max(tol.abs, (tol.pct / 100) * Math.abs(want)) + 1e-9;
const describe = (rows: Row[]) => ({
  items: rows.map((r) => String(r.entry.values?.item ?? r.entry.values?.name ?? `(${r.trackerName})`)),
  sources: rows.flatMap((r) => (r.entry.computed?.nutrition?.components || []).map((c: any) => `${c.sourceType}: ${String(c.source).slice(0, 110)}`)),
  verification: rows.map((r) => String(r.entry.computed?.nutrition?.verification || (r.entry.computed?.nutrition ? "unlabelled" : "none"))),
});
async function cleanup(rows: Row[]) {
  for (const r of rows) await api("DELETE", `/trackers/${r.trackerId}/entries/${r.entry.id}`).catch(() => undefined);
}

function record(c: { id: string; category: string; say: string; source: string }, pass: boolean, why: string[], rows: Row[], got: Record<string, number>, expect: Record<string, number>, reply: string, ms: number) {
  const d = describe(rows);
  outcomes.push({ id: c.id, category: c.category, say: c.say, pass, why, got, expect, entries: rows.length, ...d, reply: reply.slice(0, 300), ms, source: c.source });
  if (!pass) failed++;
  const gotText = Object.keys(expect).map((k) => `${k} ${got[k]}`).join(", ");
  console.log(`${pass ? "PASS" : "FAIL"}  ${c.id}  ${c.say.length > 78 ? `${c.say.slice(0, 75)}…` : c.say}\n      stored: ${gotText || "(nothing compared)"}${pass ? "" : `\n      ${why.join("; ")}`}\n      ${d.items.join(" | ") || "no entry"} — ${d.verification.join(",")} — ${d.sources[0] || "no source recorded"}`);
}

async function runCase(c: Case): Promise<void> {
  const before = new Set((await allEntries()).map((r) => r.entry.id));
  const started = Date.now();
  let reply = "";
  let rows: Row[] = [];
  try {
    const data = c.image ? await upload(c.image, c.say) : await chat(c.say);
    reply = String(data?.reply || "");
    rows = (await allEntries()).filter((r) => !before.has(r.entry.id));
    const food = rows.filter((r) => r.nutrition);
    const why: string[] = [];
    const got: Record<string, number> = {};
    if (c.limits) {
      // A supplement: logged somewhere, with nothing it does not have.
      const kcal = sumOf(rows, "calories");
      const protein = sumOf(rows, "protein");
      got.calories = kcal; got.protein = protein;
      if (rows.length === 0) why.push("nothing was logged");
      if (kcal > c.limits.maxCalories) why.push(`calories ${kcal} invented (limit ${c.limits.maxCalories})`);
      if (protein > c.limits.maxProtein) why.push(`protein ${protein} invented (limit ${c.limits.maxProtein})`);
      record(c, why.length === 0, why, rows, got, { calories: c.limits.maxCalories, protein: c.limits.maxProtein }, reply, Date.now() - started);
      return;
    }
    if (food.length === 0) why.push(`no Nutrition entry was logged (reply: ${reply.slice(0, 120)})`);
    if (c.entries && food.length !== c.entries) why.push(`${food.length} entries, expected ${c.entries} (one per food)`);
    const tol = c.tol || { pct: 8, abs: 1 };
    for (const [k, want] of Object.entries(c.expect)) {
      got[k] = sumOf(food, k);
      if (!within(got[k], want, tol)) why.push(`${k} ${got[k]} vs ${want} (${want ? `${round(((got[k] - want) / want) * 100)}%` : "abs"})`);
    }
    for (const [k, want] of Object.entries(c.expectTotals || {})) {
      got[k] = totalOf(food, k);
      if (!within(got[k], want, { pct: 0, abs: 0.11 })) why.push(`${k} ${got[k]} vs ${want} (provenance total)`);
    }
    // The reply may not contradict what was stored.
    const kcal = String(Math.round(got.calories ?? sumOf(food, "calories")));
    const spoken = reply.replace(/,/g, "");
    if (food.length === 1 && /\d\s*(kcal|calories|cal\b)/i.test(spoken) && Number(kcal) > 0 && !spoken.includes(kcal) && !spoken.includes(String(got.calories))) {
      why.push(`the reply quotes calories other than the stored ${kcal}`);
    }
    // A label picture with no amount stated must say it assumed a serving.
    if (c.id === "H08" && !food.some((r) => (r.entry.computed?.nutrition?.components || []).some((x: any) => x.servingAssumed))) why.push("one serving was assumed without being marked as assumed");
    record(c, why.length === 0, why, food, got, { ...c.expect, ...(c.expectTotals || {}) }, reply, Date.now() - started);
  } catch (e: any) {
    record(c, false, [`error: ${e?.message || e}`], rows, {}, c.expect, reply, Date.now() - started);
  } finally {
    await cleanup((await allEntries().catch(() => [] as Row[])).filter((r) => !before.has(r.entry.id)));
  }
}

// ── Corrections: several turns on one entry ──────────────────────────────────
interface Step { say: string; check: (food: Row[], ctx: { today: string; yesterday: string }) => string[] }
interface Flow { id: string; category: string; title: string; source: string; steps: Step[] }
const near = (rows: Row[], key: string, want: number, pct = 8, abs = 1): string[] => {
  const got = sumOf(rows, key);
  return within(got, want, { pct, abs }) ? [] : [`${key} ${got} vs ${want}`];
};
const count = (rows: Row[], n: number): string[] => (rows.length === n ? [] : [`${rows.length} entries, expected ${n}`]);
const dayOf = (r: Row) => new Date(r.entry.timestamp).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const FLOWS: Flow[] = [
  { id: "L1", category: "correction", title: "change the quantity", source: "KIND bar label (USDA Branded #2550612): 180 kcal → half = 90", steps: [
    { say: "I ate a KIND Dark Chocolate Nuts & Sea Salt bar.", check: (f) => [...count(f, 1), ...near(f, "calories", 180, 5)] },
    { say: "Actually, I only ate half of that KIND bar.", check: (f) => [...count(f, 1), ...near(f, "calories", 90, 5), ...near(f, "protein", 3, 5, 0.3), ...near(f, "fat", 7.5, 5, 0.4)] },
  ] },
  { id: "L2", category: "correction", title: "remove an ingredient", source: "USDA #172388 chicken thigh 116 g (207.6 kcal) + #171412 coconut oil 14 g (124.9 kcal)", steps: [
    { say: "I ate 116 grams of roasted chicken thigh meat, no skin, cooked with 14 grams of coconut oil.", check: (f) => near(f, "calories", 332.5, 8, 3) },
    { say: "Remove the coconut oil from that chicken.", check: (f) => [...count(f, 1), ...near(f, "calories", 207.6, 8, 3), ...near(f, "fat", 9.5, 15, 1)] },
  ] },
  { id: "L3", category: "correction", title: "replace the food", source: "USDA #175168 salmon 170 g (350.2 kcal) → #171956 cod 170 g (178.5 kcal, 38.8 g protein)", steps: [
    { say: "I ate 170 grams of baked farmed Atlantic salmon.", check: (f) => [...count(f, 1), ...near(f, "calories", 350.2)] },
    { say: "Actually that was baked Atlantic cod, not salmon.", check: (f) => [...count(f, 1), ...near(f, "calories", 178.5), ...near(f, "protein", 38.8), ...(/cod/i.test(String(f[0]?.entry.values?.item)) ? [] : [`item still "${f[0]?.entry.values?.item}"`])] },
  ] },
  { id: "L4", category: "correction", title: "move the entry to another date", source: "USDA #168917 quinoa 150 g (180 kcal)", steps: [
    { say: "I ate 150 grams of cooked quinoa.", check: (f, c) => [...count(f, 1), ...(f[0] && dayOf(f[0]) === c.today ? [] : ["not logged today"])] },
    { say: "I actually ate that quinoa yesterday, not today.", check: (f, c) => [...count(f, 1), ...near(f, "calories", 180), ...(f[0] && dayOf(f[0]) === c.yesterday ? [] : [`entry is dated ${f[0] ? dayOf(f[0]) : "?"}, expected ${c.yesterday}`])] },
  ] },
  { id: "L5", category: "correction", title: "repeat a previous meal", source: "USDA oats 40 g (151.6 kcal) + mango 165 g (99 kcal), logged yesterday, repeated today", steps: [
    { say: "Yesterday for breakfast I ate 40 grams of dry rolled oats and 165 g of mango.", check: (f, c) => [...count(f, 2), ...near(f, "calories", 250.6), ...(f.every((r) => dayOf(r) === c.yesterday) ? [] : ["not dated yesterday"])] },
    { say: "I had the same breakfast as yesterday.", check: (f, c) => { const today = f.filter((r) => dayOf(r) === c.today); return [...count(f, 4), ...count(today, 2).map((w) => `today: ${w}`), ...near(today, "calories", 250.6)]; } },
  ] },
  { id: "L6", category: "correction", title: "correct the preparation", source: "USDA #169737 pasta cooked 85 g (134.3 kcal) → #169736 pasta dry 85 g (315.4 kcal)", steps: [
    { say: "I ate 85 g of cooked pasta.", check: (f) => [...count(f, 1), ...near(f, "calories", 134.3)] },
    { say: "That pasta was actually weighed dry, before cooking.", check: (f) => [...count(f, 1), ...near(f, "calories", 315.4), ...near(f, "carbs", 63.5)] },
  ] },
  { id: "L7", category: "correction", title: "scale up a counted food", source: "Triscuit label (USDA Branded #2744038): 6 crackers = 120 kcal → 18 crackers = 360", steps: [
    { say: "I ate 6 Triscuit Original crackers.", check: (f) => [...count(f, 1), ...near(f, "calories", 120, 5)] },
    { say: "Correction: it was 18 Triscuit crackers, not 6.", check: (f) => [...count(f, 1), ...near(f, "calories", 360, 5), ...near(f, "carbs", 60, 5)] },
  ] },
];

async function runFlow(flow: Flow): Promise<void> {
  const before = new Set((await allEntries()).map((r) => r.entry.id));
  const tz = "America/Los_Angeles";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
  const history: Array<{ role: string; content: string }> = [];
  const started = Date.now();
  const why: string[] = [];
  let food: Row[] = [];
  let reply = "";
  try {
    for (const [i, step] of flow.steps.entries()) {
      const data = await chat(step.say, history);
      reply = String(data?.reply || "");
      history.push({ role: "user", content: step.say }, { role: "assistant", content: reply });
      food = (await allEntries()).filter((r) => !before.has(r.entry.id) && r.nutrition);
      const problems = step.check(food, { today, yesterday });
      for (const p of problems) why.push(`step ${i + 1} ("${step.say.slice(0, 40)}…"): ${p}`);
    }
  } catch (e: any) { why.push(`error: ${e?.message || e}`); }
  const got = { calories: sumOf(food, "calories"), protein: sumOf(food, "protein"), carbs: sumOf(food, "carbs"), fat: sumOf(food, "fat") };
  record({ id: flow.id, category: flow.category, say: `${flow.title}: ${flow.steps.map((s) => s.say).join(" → ")}`, source: flow.source }, why.length === 0, why, food, got, {}, reply, Date.now() - started);
  await cleanup((await allEntries().catch(() => [] as Row[])).filter((r) => !before.has(r.entry.id)));
}

async function main() {
  const cases: Case[] = [...JSON.parse(readFileSync(join(FIX, "nutrition-e2e-cases.json"), "utf8")), ...IMAGE_CASES];
  const wanted = (id: string) => (ids.length ? ids.includes(id) : only.length ? only.some((p) => id.startsWith(p)) : true);
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-nutrition-engine-check" });
  try {
    const version = await (await fetchWithRateLimitRetry(`${UI_BASE}/api/version`, {})).response.json();
    const sources = await api("GET", "/nutrition/sources");
    console.log(`serving ${String(version.sha).slice(0, 7)} at ${UI_BASE} — sources: ${JSON.stringify(sources.data)}\n`);
    for (const c of cases.filter((c) => wanted(c.id))) await runCase(c);
    for (const f of FLOWS.filter((f) => wanted(f.id))) await runFlow(f);
  } finally {
    await release();
  }
  const byCat = new Map<string, { pass: number; total: number }>();
  for (const o of outcomes) { const c = byCat.get(o.category) || { pass: 0, total: 0 }; c.total++; if (o.pass) c.pass++; byCat.set(o.category, c); }
  console.log("\nBy category:");
  for (const [cat, c] of byCat) console.log(`  ${cat.padEnd(26)} ${c.pass}/${c.total}`);
  console.log(`\n${outcomes.length - failed}/${outcomes.length} passed`);
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), base: UI_BASE, outcomes }, null, 1));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
