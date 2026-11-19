// Live check (production, smoke account): saying a debt AND its payment in
// chat makes ONE liability card (Rule L1). Takes the gate lock, writes only
// records it creates, and deletes them when done.
//   npx tsx tests/live-debt-one-card-check.ts
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { isLiabilityTabProfile } from "../shared/asset-value";
import { readMonthlyPayment, readBalance } from "../shared/liability-fields";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function profiles(): Promise<any[]> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}/profiles`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET /profiles: ${response.status}`);
  return response.json();
}
async function chat(message: string): Promise<any> {
  const r = await api("POST", "/chat", { message, history: [] });
  if (!r.ok) throw new Error(`POST /chat: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-debt-one-card-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const mine = (p: any) => String(p.name || "").includes(tag);
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

    // 1. A loan and its payment in one sentence.
    const auto = `Northside ${tag} auto loan`;
    await chat(`Add my ${auto}: I owe $21,500 at 6.5% APR, and the payment is $553.12 a month due on the 15th.`);
    let cards = (await profiles()).filter((p) => mine(p) && isLiabilityTabProfile(p));
    check(cards.length === 1, `"an auto loan and a payment" made one liability card (got ${cards.length}: ${cards.map((c) => c.name).join(" | ")})`);
    const loan = cards.find((c) => (c.type_key ?? c.typeKey) === "auto_loan") ?? cards[0];
    if (loan) {
      check((loan.type_key ?? loan.typeKey) === "auto_loan", `it is an auto loan (got ${loan.type_key ?? loan.typeKey})`);
      check(readBalance(loan.fields) === 21500, `its balance is $21,500 (got ${readBalance(loan.fields)})`);
      check(readMonthlyPayment(loan.fields) === 553.12, `the $553.12 payment is stored on the loan (got ${readMonthlyPayment(loan.fields)})`);
      check(Number(loan.fields?.dueDay) === 15, `its due day is the 15th (got ${loan.fields?.dueDay})`);
    }

    // 2. Asking for the payment as a bill afterwards still does not add a card.
    await chat(`Also set up the monthly payment for my ${auto} as a recurring bill: $553.12 every month on the 15th.`);
    cards = (await profiles()).filter((p) => mine(p) && isLiabilityTabProfile(p));
    check(cards.length === 1, `asking for the payment as a recurring bill still leaves one card (got ${cards.length}: ${cards.map((c) => c.name).join(" | ")})`);
  } finally {
    for (const p of (await profiles().catch(() => [])).filter(mine)) await api("DELETE", `/profiles/${p.id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
