// Live check (production, smoke account): the owner's nutrition test sheet,
// said to the real chat (Nutrition rules N1–N7 in CLAUDE.md). Each message is
// logged, the stored entry is read back and compared with the expected
// figures, and every entry this run created is deleted when it ends. Takes the
// gate lock (it writes as the smoke account).
//   npx tsx tests/live-nutrition-accuracy-check.ts
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { isNutritionTrackerLike } from "../shared/nutrition-enrichment";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function nutritionEntries(): Promise<Array<{ trackerId: string; entry: any }>> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}/trackers`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET /trackers: ${response.status}`);
  const trackers: any[] = await response.json();
  return trackers.filter((t) => isNutritionTrackerLike(t)).flatMap((t) => (t.entries || []).map((entry: any) => ({ trackerId: t.id, entry })));
}
async function chat(message: string): Promise<any> {
  const r = await api("POST", "/chat", { message, history: [] });
  if (!r.ok) throw new Error(`POST /chat: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

/** [what the user says, expected totals across the entries it creates, tolerance per value] */
const CASES: Array<{ say: string; want: Record<string, number>; tol?: number; entries?: number }> = [
  { say: "I ate one and a half Quest Chocolate Chip Cookie Dough protein bars.", want: { calories: 285, protein: 31.5, carbs: 33, fat: 13.5 } },
  { say: "I drank half a Fairlife Core Power Elite chocolate 42g protein shake.", want: { calories: 115, protein: 21, carbs: 4.5, fat: 1.75 } },
  { say: "I ate 225 grams of Chobani Zero Sugar Vanilla Greek Yogurt.", want: { calories: 90, protein: 18, carbs: 7.5, fat: 0 } },
  { say: "I ate seven original Oreo cookies.", want: { calories: 373.3, protein: 2.33, carbs: 58.33, fat: 16.33 } },
  { say: "I ate 100 grams of dry white rice.", want: { calories: 365, protein: 7.1, carbs: 80, fat: 0.7 } },
  { say: "I ate 200 grams of chicken weighed before cooking.", want: { calories: 240, protein: 45, fat: 5.2 } },
  { say: "I ate an entire bag of chips. There are 3.5 servings per bag, and each serving contains 150 calories, 9g fat, 16g carbs and 2g protein.", want: { calories: 525, fat: 31.5, carbs: 56, protein: 7 } },
  { say: "I ate 75 grams of cereal. The label says 160 calories, 3g fat, 30g carbs, 5g protein and 8g sugar per 40 grams.", want: { calories: 300, fat: 5.63, carbs: 56.25, protein: 9.38, sugar: 15 } },
  { say: "I ate half a protein bar containing 200 calories, 20g protein, 24g total carbs, 14g fiber, 6g sugar alcohol and 8g fat.", want: { calories: 100, protein: 10, carbs: 12, fiber: 7, fat: 4 } },
  { say: "I made four equal portions of a recipe containing 800 calories, 60g protein, 100g carbs and 17g fat. I ate one and a half portions.", want: { calories: 300, protein: 22.5, carbs: 37.5, fat: 6.38 } },
  { say: "I ate three eggs but only two of the yolks.", want: { calories: 161 }, tol: 6 },
];

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-nutrition-accuracy-check" });
  const created: Array<{ trackerId: string; id: string }> = [];
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);
    for (const c of CASES) {
      const before = new Set((await nutritionEntries()).map((x) => x.entry.id));
      const reply = await chat(c.say);
      const added = (await nutritionEntries()).filter((x) => !before.has(x.entry.id));
      for (const a of added) created.push({ trackerId: a.trackerId, id: a.entry.id });
      const label = c.say.length > 70 ? `${c.say.slice(0, 67)}…` : c.say;
      if (added.length === 0) { check(false, `${label} — no Nutrition entry was logged (reply: ${String(reply?.reply || "").slice(0, 120)})`); continue; }
      const sum = (k: string) => added.reduce((n, a) => n + (Number(a.entry.values?.[k]) || 0), 0);
      const tol = c.tol ?? 0.11;
      const off = Object.entries(c.want).filter(([k, v]) => Math.abs(sum(k) - v) > tol);
      const got = Object.keys(c.want).map((k) => `${k} ${Math.round(sum(k) * 100) / 100}`).join(", ");
      check(off.length === 0, `${label} → ${got}${off.length ? `  (expected ${off.map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`);
      // The reply must not contradict the entry it describes.
      const said = String(reply?.reply || "");
      const kcal = String(Math.round(sum("calories")));
      if (off.length === 0 && /\d\s*(kcal|cal)/i.test(said)) check(said.replace(/,/g, "").includes(kcal), `   the reply quotes the stored calories (${kcal})`);
    }
  } finally {
    for (const e of created) await api("DELETE", `/trackers/${e.trackerId}/entries/${e.id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
