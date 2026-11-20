// Live check (production, smoke account) for the Liabilities findings of
// 2026-11-20: a second chat payment the same day is recorded, the chat quotes
// the stored balance, and a rate under 1% is stored as that percent. Takes
// the gate lock, writes only records it creates, and deletes them when done.
//   npx tsx tests/live-liability-payments-check.ts
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { readBalance, readInterestRatePct, storedRateFields, RATE_UNIT_KEY } from "../shared/liability-fields";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function get(path: string): Promise<any> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return response.json();
}
async function write(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-liability-payments-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const created: string[] = [];
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

    // ── A card with a payment already made today ─────────────────────────
    const cardName = `Harbor ${tag} Card`;
    const card = await write("POST", "/profiles", {
      type: "liability", type_key: "credit_card", name: cardName,
      fields: { balance: 3200, minimumPayment: 95, dueDay: 12, ...storedRateFields(24.99) },
    });
    created.push(card.id);
    await write("POST", `/liabilities/${card.id}/payments`, { amount: 95, paymentDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) });
    const afterManual = readBalance((await get(`/profiles/${card.id}`)).fields);
    const rowsBefore = (await get(`/liabilities/${card.id}/payments`)).length;
    check(rowsBefore === 1, `the manual $95 payment is on the ledger (${rowsBefore} row)`);

    // ── The reported repro: pay it again through chat the same day ───────
    const r1 = await write("POST", "/chat", { message: `Paid $500 on my ${cardName}.`, history: [] });
    const afterChat = await get(`/profiles/${card.id}`);
    const rows1 = await get(`/liabilities/${card.id}/payments`);
    const bal1 = readBalance(afterChat.fields);
    check(rows1.length === 2, `the chat payment added a ledger row (${rows1.length} rows)`);
    check(Math.abs(bal1 - (afterManual - 500)) < 0.01, `the balance moved by $500: ${usd(afterManual)} → ${usd(bal1)}`);
    const reply1 = String(r1.reply || "");
    check(reply1.includes(usd(bal1)), `the reply quotes the stored balance ${usd(bal1)} (reply: ${reply1.replace(/\s+/g, " ").slice(0, 160)})`);

    // ── And a third, different amount ────────────────────────────────────
    const r2 = await write("POST", "/chat", { message: `I paid another $50 on my ${cardName}.`, history: [] });
    const rows2 = await get(`/liabilities/${card.id}/payments`);
    const bal2 = readBalance((await get(`/profiles/${card.id}`)).fields);
    check(rows2.length === 3, `"another $50" is recorded too (${rows2.length} rows)`);
    check(Math.abs(bal2 - (bal1 - 50)) < 0.01, `the balance moved by $50: ${usd(bal1)} → ${usd(bal2)}`);
    check(String(r2.reply || "").includes(usd(bal2)), `the reply quotes ${usd(bal2)}`);

    // ── A first payment's quoted balance includes the interest split ────
    const card2Name = `Lumen ${tag} Card`;
    const card2 = await write("POST", "/profiles", {
      type: "liability", type_key: "credit_card", name: card2Name,
      fields: { balance: 1250, dueDay: 20, ...storedRateFields(22.9) },
    });
    created.push(card2.id);
    const r3 = await write("POST", "/chat", { message: `Paid $100 on my ${card2Name}.`, history: [] });
    const bal3 = readBalance((await get(`/profiles/${card2.id}`)).fields);
    check(Math.abs(bal3 - 1173.85) < 0.01, `$100 on $1,250 at 22.9% leaves $1,173.85 (got ${usd(bal3)})`);
    check(String(r3.reply || "").includes("$1,173.85") && !String(r3.reply || "").includes("1,150"), `the reply says $1,173.85, not $1,150 (reply: ${String(r3.reply || "").replace(/\s+/g, " ").slice(0, 160)})`);

    // ── A rate under 1% is that percent ──────────────────────────────────
    const loanName = `Promo ${tag} Loan`;
    const loan = await write("POST", "/profiles", {
      type: "liability", type_key: "auto_loan", name: loanName,
      fields: { balance: 12000, monthlyPayment: 500, dueDay: 15, ...storedRateFields(6.5) },
    });
    created.push(loan.id);
    await write("PATCH", `/profiles/${loan.id}`, { fields: storedRateFields("0.9") });
    const promo = (await get(`/profiles/${loan.id}`)).fields;
    check(readInterestRatePct(promo) === 0.9, `a 0.9% rate reads back as 0.9% (got ${readInterestRatePct(promo)}%)`);
    check(promo.interestRate === 0.9 && promo[RATE_UNIT_KEY] === "percent", `it is stored as 0.9 with its unit (stored ${promo.interestRate}, unit ${promo[RATE_UNIT_KEY]})`);

    // A rate that arrives as a fraction with no unit is stored as a percent.
    await write("PATCH", `/profiles/${loan.id}`, { fields: { interestRate: 0.065, [RATE_UNIT_KEY]: null } });
    const legacy = (await get(`/profiles/${loan.id}`)).fields;
    check(legacy.interestRate === 6.5 && legacy[RATE_UNIT_KEY] === "percent", `an unmarked 0.065 is stored as 6.5 percent (stored ${legacy.interestRate}, unit ${legacy[RATE_UNIT_KEY]})`);
  } finally {
    for (const id of created.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
