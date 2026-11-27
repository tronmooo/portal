// AI Chat, the remaining tools: payments edited and removed, links and shares,
// assets, documents, notifications, profiles, bulk actions and undo.
//
// Every message is one clear sentence that calls for one tool; the scenario
// then reads the rows the message left (straight from the database), works the
// dependent figures out a second time, and holds the reply to what was stored
// (CLAUDE.md I16: what chat confirms is what was stored). The model's wording
// varies from run to run, so nothing here depends on the exact text of a reply
// — except where the reply NAMES a figure, which must then be the stored one.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const inWords = (ymd: string) => { const d = O.parseYmd(ymd); return `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`; };
const json = (x: unknown, n = 260) => JSON.stringify(x).slice(0, n);
const close = (a: unknown, b: number, tol = 0.005) => Number.isFinite(Number(a)) && Math.abs(Number(a) - b) <= tol;
const gone = (row: any) => row === null || row.deleted_at != null;
const settle = () => new Promise((r) => setTimeout(r, 2500));

type Msg = { role: "user" | "assistant"; content: string };
interface Turn { said: string; reply: string; tools: string[]; data: any; asked?: string }

/** One request to the chat. `tools` is what the chat's own action ledger
 *  recorded for it (informational: which tool the model picked). */
async function chat(ctx: Ctx, message: string, history: Msg[] = []): Promise<Turn> {
  const since = new Date(Date.now() - 1500).toISOString();
  const r = await ctx.api("POST", "/chat", { message, history });
  if (!r.ok) throw new Error(`chat "${message.slice(0, 60)}": ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const reply = String(r.data?.reply ?? "");
  const logged = await ctx.db.rows("ai_action_log", `created_at=gte.${since}&order=created_at.asc`).catch(() => [] as any[]);
  const acted = (Array.isArray(r.data?.actions) ? r.data.actions : []).map((a: any) => String(a?.data?._tool || (String(a?.type || "").includes("_") ? a.type : ""))).filter(Boolean);
  const tools = [...new Set([...acted, ...logged.map((x: any) => String(x.tool))])];
  ctx.step(`chat reply: ${reply.replace(/\s+/g, " ").slice(0, 260)}`);
  ctx.step(`tools in the action ledger: ${tools.join(", ") || "(none)"}`);
  console.log(`    · "${message.slice(0, 80)}" → [${tools.join(", ")}] ${reply.replace(/\s+/g, " ").slice(0, 150)}`);
  return { said: message, reply, tools, data: r.data };
}
// A question that closes the reply, or "are you sure … ?" / "please confirm" anywhere in it
// (a delete may ask and then add what would be lost).
const ASKS_TO_PROCEED = /(shall i|should i|do you want me to|want me to|would you like me to|can you confirm|please confirm|are you sure|confirm)[^?]{0,200}\?\s*$|\bare you sure\b[^?]{0,200}\?|\b(please|can you) confirm\b|\bconfirm and i.ll\b|\breply\s+["“']?yes\b/i;
/** A message, with ONE "yes" when the chat asks before acting (Rule 8): that
 *  is an answer, not a refusal, and the outcome is held to the same check.
 *  The yes is to what was ASKED FOR and nothing else: a reply that offers a
 *  different action ("I can't mark it read — dismiss it instead?") must not be
 *  taken as agreed to. */
async function say(ctx: Ctx, message: string): Promise<Turn> {
  const first = await chat(ctx, message);
  if (!ASKS_TO_PROCEED.test(first.reply)) return first;
  ctx.step("chat asked before acting; answered yes");
  const second = await chat(ctx, "Yes, go ahead — do what I asked, and nothing else.", [{ role: "user", content: message }, { role: "assistant", content: first.reply }]);
  return { said: message, reply: second.reply, tools: [...first.tools, ...second.tools], data: second.data, asked: first.reply };
}
const yes = (ctx: Ctx, first: Turn, words = "Yes, go ahead — do what I asked, and nothing else.") => chat(ctx, words, [{ role: "user", content: first.said }, { role: "assistant", content: first.reply }]);

/** Everything made since the scenario began, whatever the model called it. */
function sweepAfter(ctx: Ctx): void {
  const since = new Date(Date.now() - 2000).toISOString();
  for (const [table, path] of [["expenses", "/expenses"], ["incomes", "/incomes"], ["tasks", "/tasks"], ["events", "/events"], ["journal_entries", "/journal"], ["habits", "/habits"], ["goals", "/goals"], ["artifacts", "/artifacts"], ["trackers", "/trackers"]] as const) {
    ctx.cleanup(async () => {
      const rows = await ctx.db.rows(table, `created_at=gte.${since}&deleted_at=is.null`).catch(() => ctx.db.rows(table, `created_at=gte.${since}`).catch(() => []));
      for (const r of rows) await ctx.api("DELETE", `${path}/${r.id}`);
    });
  }
  ctx.cleanup(async () => {
    const docs = await ctx.db.rows("documents", `created_at=gte.${since}`).catch(() => []);
    for (const d of docs) { await ctx.api("POST", `/documents/${d.id}/purge`); await ctx.api("DELETE", `/documents/${d.id}`); }
  });
  ctx.cleanup(async () => {
    const rows = await ctx.db.rows("profiles", `created_at=gte.${since}&deleted_at=is.null&type=neq.self`);
    for (const r of rows) await ctx.api("DELETE", `/profiles/${r.id}?deleteHistory=1`);
  });
}

/** One tool's block: a throw in it fails that block and lets the next one run. */
async function part(ctx: Ctx, name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`  — ${name}`);
  ctx.step(`— ${name}`);
  try { await fn(); } catch (e: any) { ctx.check("action", false, `${name}: ran to its end`, String(e?.message || e).slice(0, 300)); }
}
/** A failed check about what chat did is a finding, with the words on both sides. */
function report(ctx: Ctx, ok: boolean, severity: "bug" | "discrepancy", title: string, t: Turn, database: string, rule: string): void {
  if (ok) return;
  ctx.finding({ severity, title, detail: `Said: "${t.said}" · Tools: ${t.tools.join(", ") || "(none logged)"} · Reply: "${t.reply.replace(/\s+/g, " ").slice(0, 320)}" · Database: ${database} · Rule: ${rule}` });
}
const mk = async (ctx: Ctx, body: any, query = "") => {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}${query}`));
  return p;
};
const snapshot = async (ctx: Ctx, ids?: string[]) => must(await ctx.api("GET", `/dashboard-enhanced${ids ? `?profileIds=${ids.join(",")}` : ""}`), "snapshot").financeSnapshot;
const money = (n: number) => [n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), n.toLocaleString("en-US", { maximumFractionDigits: 0 })];
/** Every dollar figure a reply prints. */
const figures = (reply: string) => (reply.match(/\$\s?[\d,]+(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/[$,\s]/g, "")));
const names = (reply: string, n: number) => money(n).some((s) => reply.includes(`$${s}`));
const CENSUS = ["profiles", "expenses", "incomes", "tasks", "events", "habits", "goals", "journal_entries", "artifacts", "trackers", "tracker_entries", "documents", "liability_payments"] as const;
const census = async (ctx: Ctx, tables: readonly string[] = CENSUS) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await ctx.db.count(t, "id=not.is.null")] as const)));
/** Tables whose row count moved, and by how much. */
const moved = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => [k, b[k] - a[k]]));
const pref = async (ctx: Ctx, key: string): Promise<string | null> => { const rows = await ctx.db.rows("preferences", `key=eq.${encodeURIComponent(key)}`); return rows[0] ? String(rows[0].value) : null; };

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.debts",
  title: "Chat: a recorded payment removed; a debt linked to its collateral, detached and deleted — the ledger, the balance and the totals follow",
  area: "AI Chat",
  chat: true,
  covers: ["liabilityPayment.delete.chat", "liability.transfer.chat", "liability.cancel.chat", "liability.delete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const loan = await mk(ctx, { type: "liability", type_key: "auto_loan", name: `Vanloan ${T}`, fields: { balance: 12000, monthlyPayment: 300, dueDay: 12, interestRate: 6, _interestRateUnit: "percent" } }, "?deleteHistory=1");
    const camper = await mk(ctx, { type: "asset", name: `Camper ${T}`, fields: { currentValue: 9000 } });
    const s0 = await snapshot(ctx);
    const balance = async () => Number((await ctx.db.row("profiles", loan.id))?.fields?.balance);
    const ledger = () => ctx.db.rows("liability_payments", `liability_profile_id=eq.${loan.id}`);

    await part(ctx, "delete_liability_payment", async () => {
      must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 300, paymentDate: ctx.today, idempotencyKey: `${T}-pay-1` }), "record the payment");
      const first = O.splitPayment(12000, 6, 300);
      ctx.near("db", await balance(), first.newBalance, "setup: a $300 payment left the balance (12,000 less 240 principal)");
      ctx.near("db", Number((await ledger())[0]?.interest_portion), first.interest, "setup: and carried the month's interest");
      await settle();
      const t = await say(ctx, `Delete the payment I recorded today on my "${loan.name}" — it was a mistake.`);
      const rows = await ledger();
      const ok = ctx.check("db", rows.length === 0, "the ledger row is gone", json(rows.map((p: any) => p.amount)));
      const okBal = ctx.near("derived", await balance(), 12000, "the balance is back to what it was before the payment");
      const s = await snapshot(ctx);
      ctx.near("derived", O.cents(s.totalLiabilities - s0.totalLiabilities), 0, "total debt is back where it started");
      ctx.near("derived", O.cents(s.totalMonthlySpend - s0.totalMonthlySpend), 0, "the payment's interest no longer counts in this month's spending");
      report(ctx, ok && okBal, "bug", "Chat: deleting a recorded payment did not undo it", t, `${rows.length} payment row(s); balance ${await balance()}`, "L5, A3");
      ctx.check("db", (await ctx.db.row("profiles", loan.id))?.deleted_at == null, "the debt itself is untouched");
    });

    await part(ctx, "link_liability_asset / unlink_asset_from_liability / link_asset_to_liability", async () => {
      const links = () => ctx.db.rows("liability_asset_links", `liability_profile_id=eq.${loan.id}`);
      const live = () => ctx.db.count("profiles", "deleted_at=is.null");
      const n0 = await live();
      const sA = await snapshot(ctx);
      let t = await say(ctx, `My "${loan.name}" is secured by my "${camper.name}" — link the loan to that asset as collateral.`);
      let rows = await links();
      let ok = ctx.check("db", rows.length === 1 && rows[0].asset_profile_id === camper.id, "one link row from the debt to the asset", json(rows));
      report(ctx, ok, "bug", "Chat: linking a debt to its collateral left no link row", t, json(rows), "I16");
      ctx.check("db", (await live()) === n0, "no stub asset was created beside the one named", `${await live()} live profiles, was ${n0}`);
      ctx.check("action", listOf(must(await ctx.api("GET", `/liabilities/${loan.id}/assets`), "linked assets")).some((a: any) => json(a, 2000).includes(camper.id)), "the debt's page lists the asset");
      const sB = await snapshot(ctx);
      ctx.check("derived", close(sB.totalLiabilities, sA.totalLiabilities) && close(sB.totalAssetValue, sA.totalAssetValue), "a link is not a second debt or a second asset: both totals are unchanged", `${sA.totalLiabilities}→${sB.totalLiabilities}, ${sA.totalAssetValue}→${sB.totalAssetValue}`);

      t = await say(ctx, `Remove the "${camper.name}" from my "${loan.name}" — it is no longer collateral for that loan.`);
      rows = await links();
      ok = ctx.check("db", rows.length === 0, "the link row is gone", json(rows));
      report(ctx, ok, "bug", "Chat: detaching an asset from a debt left the link in place", t, json(rows), "I16");
      ctx.check("db", !gone(await ctx.db.row("profiles", camper.id)) && !gone(await ctx.db.row("profiles", loan.id)), "the asset and the debt themselves are both still there");

      t = await say(ctx, `The "${loan.name}" covers my "${camper.name}" — attach that asset to the loan.`);
      rows = await links();
      ok = ctx.check("db", rows.length === 1 && rows[0].asset_profile_id === camper.id, "attached again: one link row, to the same asset", json(rows));
      report(ctx, ok, "bug", "Chat: attaching an asset to a debt left no single link row", t, json(rows), "I16");
      ctx.check("db", (await live()) === n0, "and still no extra profile", `${await live()} live profiles, was ${n0}`);

      // Two tools make this link (link_liability_asset, link_asset_to_liability).
      // When neither sentence drew the second, a third wording is tried, so the
      // run says which tool answers which sentence.
      if (![...t.tools].includes("link_asset_to_liability")) {
        for (const l of await links()) await ctx.api("DELETE", `/liability-asset-links/${l.id}`);
        await settle();
        t = await say(ctx, `Attach the asset "${camper.name}" to the liability "${loan.name}" — that loan covers it.`);
        rows = await links();
        ok = ctx.check("db", rows.length === 1 && rows[0].asset_profile_id === camper.id && (await live()) === n0, "a third wording: one link row to the same asset, and no extra profile", json(rows));
        report(ctx, ok, "bug", "Chat: attaching an asset to a debt (third wording) left no single link row", t, json(rows), "I16");
        ctx.step(`link_asset_to_liability ${t.tools.includes("link_asset_to_liability") ? "was" : "was NOT"} the tool chosen in three wordings`);
        console.log(`    (link_asset_to_liability ${t.tools.includes("link_asset_to_liability") ? "chosen on the third wording" : "not chosen in three wordings"})`);
      }
    });

    await part(ctx, "delete_profile (a debt)", async () => {
      const b = await balance();
      const sA = await snapshot(ctx);
      const c0 = await census(ctx, ["tasks", "events", "trackers", "documents", "artifacts"]);
      const t = await say(ctx, `Delete my "${loan.name}" debt.`);
      const row = await ctx.db.row("profiles", loan.id);
      const ok = ctx.check("db", gone(row), "the debt's row is deleted", json({ deleted_at: row?.deleted_at }));
      report(ctx, ok, "bug", "Chat: asked to delete a debt (and told yes), the debt is still there", t, json({ deleted_at: row?.deleted_at }), "I16");
      const sB = await snapshot(ctx);
      ctx.near("derived", O.cents(sA.totalLiabilities - sB.totalLiabilities), O.cents(b), "total debt fell by the deleted debt's stored balance");
      ctx.near("derived", sB.totalAssetValue, sA.totalAssetValue, "the asset that secured it still counts in full");
      ctx.check("db", !gone(await ctx.db.row("profiles", camper.id)), "the linked asset was not deleted with it");
      ctx.check("db", (await ctx.db.count("liability_asset_links", `liability_profile_id=eq.${loan.id}&asset_profile_id=eq.${camper.id}`)) <= 1, "and no second link row appeared for it");
      ctx.same("db", moved(c0, await census(ctx, ["tasks", "events", "trackers", "documents", "artifacts"])), {}, "nothing else was created or removed");
    });
    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.debt-payment-changes",
  title: "Chat: a recorded payment corrected, and a scheduled instalment marked paid — the balance moves with the ledger",
  area: "AI Chat",
  chat: true,
  covers: ["liabilityPayment.edit.chat", "liabilityPayment.complete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const loan = await mk(ctx, { type: "liability", type_key: "auto_loan", name: `Vanloan ${T}`, fields: { balance: 12000, monthlyPayment: 300, dueDay: 12, interestRate: 6, _interestRateUnit: "percent" } }, "?deleteHistory=1");
    const s0 = await snapshot(ctx);
    const balance = async () => Number((await ctx.db.row("profiles", loan.id))?.fields?.balance);
    const ledger = () => ctx.db.rows("liability_payments", `liability_profile_id=eq.${loan.id}`);

    await part(ctx, "update_liability_payment", async () => {
      must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 300, paymentDate: ctx.today, idempotencyKey: `${T}-pay-1` }), "record the payment");
      const first = O.splitPayment(12000, 6, 300);
      ctx.near("db", await balance(), first.newBalance, "setup: a $300 payment left the balance (12,000 less 240 principal)");
      await settle();
      const t = await say(ctx, `The payment I recorded today on my "${loan.name}" was actually $350, not $300 — correct that payment.`);
      const rows = await ledger();
      const okRow = ctx.check("db", rows.length === 1 && close(rows[0]?.amount, 350), "still one ledger row, and it reads 350 (an edit, not a second payment)", json(rows.map((p: any) => [p.amount, p.principal_portion, p.interest_portion])));
      report(ctx, okRow, "bug", "Chat: correcting a recorded payment did not leave one payment of the new amount", t, json(rows.map((p: any) => p.amount)), "L5, I16");
      // The month's interest was charged once (60); the extra 50 is principal.
      const want = O.splitPayment(12000, 6, 350);
      const b = await balance();
      const okBal = ctx.near("derived", b, want.newBalance, "the stored balance moved by exactly the $50 difference");
      const okSplit = ctx.near("derived", Number(rows[0]?.principal_portion), want.principal, "the payment row's principal is the new amount less the month's interest");
      ctx.near("derived", O.cents((await snapshot(ctx)).totalLiabilities - s0.totalLiabilities), -want.principal, "total debt is down by that payment's principal");
      report(ctx, okBal && okSplit, "bug", "Chat: a payment's amount is corrected in the ledger but the debt's balance does not move", t,
        `payment row ${json(rows.map((p: any) => ({ amount: p.amount, principal: p.principal_portion, interest: p.interest_portion, after: p.remaining_balance_after })))}; stored balance ${b} (expected ${want.newBalance})`, "L5 (the server owns the split), Rule 1");
      const said = figures(t.reply);
      ctx.check("action", !/balance/i.test(t.reply) || said.length === 0 || names(t.reply, b), "a balance the reply names is the stored balance (I16)", `stored ${b}; reply: ${t.reply.replace(/\s+/g, " ").slice(0, 200)}`);
    });

    await part(ctx, "back to a clean ledger", async () => {
      for (const p of await ledger()) await ctx.api("DELETE", `/liability-payments/${p.id}`);
      if ((await ledger()).length !== 0) throw new Error("setup: could not clear the ledger");
    });

    await part(ctx, "mark_loan_payment", async () => {
      // One instalment, dated long ago so an unpaid row can never land in a
      // current calendar or cash-flow window (schedule rows have no delete door).
      const made = must(await ctx.api("POST", "/loans/schedule", { entries: [{ loan_id: loan.id, loan_name: loan.name, payment_number: 1, payment_date: "2001-01-15", principal_amount: 240, interest_amount: 60, total_payment: 300, remaining_balance: 11760 }] }), "schedule");
      const rowId = listOf(made)[0].id;
      const schedRow = async () => (await ctx.db.rows("loan_amortization", `id=eq.${rowId}`))[0];
      ctx.cleanup(async () => { if ((await schedRow())?.paid !== true) await ctx.api("PATCH", `/loans/payment/${rowId}/mark`); });
      const before = { bal: await balance(), pays: (await ledger()).length };
      await settle();
      const t = await say(ctx, `Mark the next scheduled payment on my "${loan.name}" amortization schedule as paid.`);
      const row = await schedRow();
      const okFlag = ctx.check("db", row?.paid === true, "the schedule row is marked paid", json(row));
      // "Paid" means one thing (the schedule's own button, PATCH /api/loans/payment/:id/mark,
      // and L5): the payment is in the ledger and the balance is lower by its principal.
      const pays = await ledger();
      const okLedger = ctx.check("derived", pays.length === before.pays + 1 && pays.some((p: any) => close(p.amount, 300)), "an instalment marked paid has its payment in the ledger", `${pays.length} payment row(s): ${json(pays.map((p: any) => p.amount))}`);
      const okBal = ctx.near("derived", await balance(), O.cents(before.bal - 240), "and the balance fell by the instalment's principal");
      report(ctx, okFlag && okLedger && okBal, okFlag ? "discrepancy" : "bug", "Chat marks a loan instalment paid without recording the payment", t,
        `loan_amortization.paid=${row?.paid}; ledger rows ${pays.length} (was ${before.pays}); balance ${await balance()} (was ${before.bal})`, "L5 (\"a payment the chat reports IS recorded\"); the schedule's own Mark button records the payment first, then the flag");
    });

    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.assets",
  title: "Chat: an asset created on request, revalued, made from an expense and deleted; an account deleted — the totals count each once",
  area: "AI Chat",
  chat: true,
  covers: ["asset.create.chat", "asset.edit.chat", "asset.delete.chat", "account.delete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const robin = await mk(ctx, { type: "person", name: `Robin ${T}`, fields: { relationship: "partner" } });
    const s0 = await snapshot(ctx);
    const name = `Mavic Drone ${T}`;
    let assetId = "";
    const value = async () => Number((await ctx.db.row("profiles", assetId))?.fields?.currentValue);

    await part(ctx, "create_profile (an asset, on an explicit request)", async () => {
      const people0 = await ctx.db.count("profiles", "type=eq.person&deleted_at=is.null");
      await settle();
      const t = await say(ctx, `Create an asset profile called "${name}": I bought it for $1,200 and it is worth $900 today.`);
      const rows = await ctx.db.rows("profiles", `name=ilike.*${encodeURIComponent(`Drone ${T}`)}*&deleted_at=is.null`);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${r.id}`));
      const f = rows[0]?.fields || {};
      const ok = ctx.check("db", rows.length === 1 && ["asset", "vehicle"].includes(rows[0].type) && close(f.currentValue, 900) && close(f.purchasePrice, 1200), "one asset row: purchase price 1,200, current value 900", json(rows.map((r: any) => [r.type, r.name, r.fields])));
      report(ctx, ok, "bug", "Chat: an asset created on request is not stored as one asset with the figures given", t, json(rows.map((r: any) => [r.type, r.name, r.fields])), "Rule 1, L2, I16");
      assetId = rows[0]?.id || "";
      ctx.check("db", (await ctx.db.count("profiles", "type=eq.person&deleted_at=is.null")) === people0, "no person profile was created (Rule 13)");
      ctx.near("derived", O.cents((await snapshot(ctx)).totalAssetValue - s0.totalAssetValue), 900, "total assets rose by its current value, not its purchase price");
    });
    if (!assetId) {
      const p = await mk(ctx, { type: "asset", name, fields: { currentValue: 900, purchasePrice: 1200 } });
      assetId = p.id;
      await settle();
    }

    await part(ctx, "revalue_asset", async () => {
      const before = await value();
      const t = await say(ctx, `Re-estimate what my "${name}" is worth now and update its value.`);
      const row = await ctx.db.row("profiles", assetId);
      const v = Number(row?.fields?.currentValue);
      ctx.check("db", Number.isFinite(v) && v > 0 && !gone(row), "the asset row holds a positive current value", json(row?.fields));
      ctx.check("db", v === before || !!row?.fields?.valuationMethod, "a changed value is stored with how it was estimated", json({ before, v, method: row?.fields?.valuationMethod }));
      ctx.near("derived", O.cents((await snapshot(ctx)).totalAssetValue - s0.totalAssetValue), O.cents(v), "total assets count the stored value, once");
      const said = figures(t.reply);
      const ok = ctx.check("action", said.length === 0 || names(t.reply, v), "the value the reply gives is the stored value (I16)", `stored ${v} (was ${before}); reply figures ${json(said)}; reply: ${t.reply.replace(/\s+/g, " ").slice(0, 220)}`);
      report(ctx, ok, "bug", "Chat: the value quoted after a revaluation is not the value stored", t, `fields.currentValue=${v} (was ${before})`, "I16, Rule 1");
      ctx.check("db", (await ctx.db.count("profiles", `name=ilike.*${encodeURIComponent(`Drone ${T}`)}*&deleted_at=is.null`)) === 1, "still one record for the asset");
    });

    await part(ctx, "convert_expense_to_asset", async () => {
      const exp = must(await ctx.api("POST", "/expenses", { description: `Telescope ${T}`, amount: 640, category: "shopping", date: ctx.today }), "expense");
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${exp.id}`));
      const sA = await snapshot(ctx);
      const c0 = await census(ctx, ["profiles", "tasks", "events", "trackers"]);
      await settle();
      const t = await say(ctx, `The "Telescope ${T}" expense is actually an asset — convert that expense into a tracked asset.`);
      const made = await ctx.db.rows("profiles", `name=ilike.*${encodeURIComponent(`Telescope ${T}`)}*&deleted_at=is.null`);
      for (const r of made) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${r.id}`));
      const okP = ctx.check("db", made.length === 1 && made[0].type === "asset" && close(made[0].fields?.purchasePrice, 640) && made[0].fields?.purchaseDate === ctx.today, "one asset row: bought for 640, today", json(made.map((r: any) => [r.type, r.name, r.fields])));
      const okE = ctx.check("db", gone(await ctx.db.row("expenses", exp.id)), "the expense row is gone (it is an asset now, not spending)");
      report(ctx, okP && okE, "bug", "Chat: converting an expense into an asset did not leave one asset and no expense", t, `profiles ${json(made.map((r: any) => [r.type, r.name]))}; expense deleted=${gone(await ctx.db.row("expenses", exp.id))}`, "I16");
      ctx.near("derived", O.cents(sA.totalMonthlySpend - (await snapshot(ctx)).totalMonthlySpend), 640, "this month's spending fell by the purchase");
      ctx.same("db", moved(c0, await census(ctx, ["profiles", "tasks", "events", "trackers"])), { profiles: 1 }, "one profile was added and nothing else");
    });

    await part(ctx, "delete_profile (an asset)", async () => {
      const v = await value();
      const sA = await snapshot(ctx);
      const t = await say(ctx, `Delete my "${name}" asset profile.`);
      const row = await ctx.db.row("profiles", assetId);
      const ok = ctx.check("db", gone(row), "the asset's row is deleted", json({ deleted_at: row?.deleted_at }));
      report(ctx, ok, "bug", "Chat: asked to delete an asset (and told yes), the asset is still there", t, json({ deleted_at: row?.deleted_at }), "I16");
      ctx.near("derived", O.cents(sA.totalAssetValue - (await snapshot(ctx)).totalAssetValue), O.cents(v), "total assets fell by its stored value");
      ctx.check("db", !gone(await ctx.db.row("profiles", robin.id)), "a person in the account was not deleted with it");
    });

    await part(ctx, "delete_profile (a financial account)", async () => {
      const acct = must(await ctx.api("POST", "/accounts", { name: `Stash ${T}`, accountKind: "savings", balance: 1500 }), "account");
      const acctId = acct.id ?? acct.account?.id;
      ctx.cleanup(() => ctx.api("DELETE", `/accounts/${acctId}`));
      const sA = await snapshot(ctx);
      const c0 = await census(ctx, ["expenses", "incomes", "tasks", "events"]);
      await settle();
      const t = await say(ctx, `Delete my "Stash ${T}" account.`);
      const row = await ctx.db.row("profiles", acctId);
      const ok = ctx.check("db", gone(row), "the account's row is deleted", json({ type: row?.type, deleted_at: row?.deleted_at }));
      report(ctx, ok, "bug", "Chat: asked to delete an account (and told yes), the account is still there", t, json({ deleted_at: row?.deleted_at }), "I16");
      ctx.near("derived", O.cents(sA.totalAssetValue - (await snapshot(ctx)).totalAssetValue), 1500, "total assets fell by the account's balance");
      ctx.same("db", moved(c0, await census(ctx, ["expenses", "incomes", "tasks", "events"])), {}, "no money record was created or removed with it");
    });
    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.ownership-shares",
  title: "Chat: a co-owner added, an asset split and a debt split between two people — the owner rows hold the shares, and each person counts theirs",
  area: "AI Chat",
  chat: true,
  covers: ["asset.transfer.chat", "liability.transfer.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const robin = await mk(ctx, { type: "person", name: `Robin ${T}`, fields: { relationship: "partner" } });
    const name = `Mavic Drone ${T}`;
    const asset = await mk(ctx, { type: "asset", name, fields: { currentValue: 900, purchasePrice: 1200 } });
    const assetId: string = asset.id;
    const value = async () => Number((await ctx.db.row("profiles", assetId))?.fields?.currentValue);
    const loan = await mk(ctx, { type: "liability", type_key: "auto_loan", name: `Vanloan ${T}`, fields: { balance: 12000, monthlyPayment: 300, dueDay: 12, interestRate: 6, _interestRateUnit: "percent" } }, "?deleteHistory=1");
    const balance = async () => Number((await ctx.db.row("profiles", loan.id))?.fields?.balance);
    await settle();

    await part(ctx, "link_asset_owner", async () => {
      const v = await value();
      const sA = await snapshot(ctx);
      const t = await say(ctx, `Add "${robin.name}" as a co-owner of my "${name}" with a 40% share.`);
      const rows = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${assetId}`);
      const theirs = rows.filter((r: any) => r.party_profile_id === robin.id).map((r: any) => Number(r.ownership_percentage));
      const ok = ctx.check("db", json(theirs) === "[40]", "an owner row gives the partner 40%", json(rows.map((r: any) => [r.party_profile_id === robin.id ? "partner" : "me?", r.ownership_percentage, r.role])));
      const refused = /couldn.t|could not|didn.t go through|unable|wasn.t able/i.test(t.reply);
      report(ctx, ok, "bug", refused ? "Chat cannot add a co-owner with a share to an asset that already has an owner (it says so, and nothing is saved)" : "Chat: a co-owner's 40% share is not what the owner rows hold", t, json(rows.map((r: any) => [r.party_profile_id === robin.id ? "partner" : r.party_profile_id === ctx.self.id ? "me" : r.party_profile_id, r.ownership_percentage, r.role])), refused ? "the tool's own example (\"add my wife as co-owner of the house\"); shares over 100% are refused by the database, and the tool does not make room" : "I16");
      const mine = rows.filter((r: any) => r.party_profile_id === ctx.self.id).reduce((n: number, r: any) => n + Number(r.ownership_percentage), 0);
      const okMine = ctx.check("db", !ok || mine === 60, "and the other 60% is still the account holder's (the shares add up to 100%)", json(rows.map((r: any) => [r.party_profile_id === robin.id ? "partner" : r.party_profile_id === ctx.self.id ? "me" : r.party_profile_id, r.ownership_percentage])));
      report(ctx, okMine, "bug", "Chat: adding a co-owner at 40% dropped the account holder's own share", t, json(rows.map((r: any) => [r.party_profile_id === robin.id ? "partner" : r.party_profile_id === ctx.self.id ? "me" : r.party_profile_id, r.ownership_percentage])), "I16, Rule 9");
      ctx.near("derived", (await snapshot(ctx, [robin.id])).totalAssetValue, O.netWorth([{ value: v, sharePct: 40 }], []).assets, "the partner's assets are 40% of its stored value");
      ctx.near("derived", (await snapshot(ctx)).totalAssetValue, sA.totalAssetValue, "the household total did not change when it was shared");
    });

    await part(ctx, "split_ownership", async () => {
      const v = await value();
      const sA = await snapshot(ctx);
      const myPct = async () => { const r = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${assetId}`); return r.length === 0 ? 100 : r.filter((x: any) => x.party_profile_id === ctx.self.id).reduce((n: number, x: any) => n + Number(x.ownership_percentage), 0); };
      const [pct0, mine0] = [await myPct(), (await snapshot(ctx, [ctx.self.id])).totalAssetValue];
      const t = await say(ctx, `Split ownership of my "${name}" 70/30 between me and "${robin.name}".`);
      const rows = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${assetId}`);
      const share = (id: string) => rows.filter((r: any) => r.party_profile_id === id).map((r: any) => Number(r.ownership_percentage));
      const ok = ctx.check("db", rows.length === 2 && json(share(ctx.self.id)) === "[70]" && json(share(robin.id)) === "[30]", "exactly two owner rows: 70% me, 30% the partner (the earlier 40% is replaced)", json(rows.map((r: any) => [r.party_profile_id === robin.id ? "partner" : r.party_profile_id === ctx.self.id ? "me" : r.party_profile_id, r.ownership_percentage])));
      report(ctx, ok, "bug", "Chat: a 70/30 split of an asset is not what the owner rows hold", t, json(rows.map((r: any) => [r.party_profile_id, r.ownership_percentage, r.role])), "I16");
      ctx.near("derived", (await snapshot(ctx, [robin.id])).totalAssetValue, O.netWorth([{ value: v, sharePct: 30 }], []).assets, "the partner's assets are 30% of its stored value");
      ctx.near("derived", O.cents((await snapshot(ctx, [ctx.self.id])).totalAssetValue - mine0), O.cents((v * (70 - pct0)) / 100), `my own assets hold 70% of it (I held ${pct0}% before)`);
      ctx.near("derived", (await snapshot(ctx)).totalAssetValue, sA.totalAssetValue, "the household still counts the whole asset");
      ctx.check("db", (await ctx.db.count("profiles", "type=eq.person&deleted_at=is.null&name=ilike.*" + T + "*")) === 1, "no second person was created for the split");
    });

    await part(ctx, "link_liability_owner / split_ownership (a debt, 50/50)", async () => {
      const sA = await snapshot(ctx);
      const mine0 = (await snapshot(ctx, [ctx.self.id])).totalLiabilities;
      const t = await say(ctx, `My "${loan.name}" is split 50/50 between me and "${robin.name}".`);
      const rows = await ctx.db.rows("liability_profile_links", `liability_profile_id=eq.${loan.id}`);
      const share = (id: string) => rows.filter((r: any) => r.party_profile_id === id).map((r: any) => Number(r.ownership_percentage));
      const ok = ctx.check("db", rows.length === 2 && json(share(ctx.self.id)) === "[50]" && json(share(robin.id)) === "[50]", "two owner rows: 50% me, 50% the partner", json(rows.map((r: any) => [r.party_profile_id === robin.id ? "partner" : r.party_profile_id === ctx.self.id ? "me" : r.party_profile_id, r.ownership_percentage, r.role])));
      report(ctx, ok, "bug", "Chat: a 50/50 split of a debt is not what the owner rows hold", t, json(rows.map((r: any) => [r.party_profile_id, r.ownership_percentage, r.role])), "I16, Rule 9");
      const b = await balance();
      ctx.near("derived", (await snapshot(ctx, [robin.id])).totalLiabilities, O.netWorth([], [{ value: b, sharePct: 50 }]).liabilities, "the partner's debt is half the stored balance");
      ctx.near("derived", O.cents(mine0 - (await snapshot(ctx, [ctx.self.id])).totalLiabilities), O.cents(b / 2), "my own debt fell by the half that is now the partner's");
      ctx.near("derived", (await snapshot(ctx)).totalLiabilities, sA.totalLiabilities, "the household's total debt did not change when the loan was shared");
      ctx.check("db", (await ctx.db.count("profiles", `name=ilike.*${T}*&deleted_at=is.null`)) === 3, "no profile was created for the split", `${await ctx.db.count("profiles", `name=ilike.*${T}*&deleted_at=is.null`)} tagged profiles`);
      ctx.check("action", ok || !/50\s?%\s*(you|me|yours)|you\b[^.]{0,20}50\s?%/i.test(t.reply), "the reply does not give the account holder a 50% share the rows do not hold (I16)", t.reply.replace(/\s+/g, " ").slice(0, 200));
    });

    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.records",
  title: "Chat: a paycheck received, budgets copied, doses and refills, a tracker, documents, artifacts and a characteristic",
  area: "AI Chat",
  chat: true,
  covers: ["income.complete.chat", "budget.duplicate.chat", "trackerEntry.cancel.chat", "trackerEntry.reschedule.chat", "tracker.edit.chat", "document.create.chat", "document.edit.chat", "document.transfer.chat", "artifact.edit.chat", "artifact.duplicate.chat", "detail.edit.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;

    await part(ctx, "confirm_paycheck_received", async () => {
      const pc = must(await ctx.api("POST", "/paychecks", { source: `Employer ${T}`, amount: 1234.56, expected_date: ctx.today }), "paycheck");
      ctx.cleanup(() => ctx.api("DELETE", `/paychecks/${pc.id}`));
      const n0 = await ctx.db.count("paychecks", "id=not.is.null");
      await settle();
      const t = await say(ctx, `My paycheck from "Employer ${T}" arrived today — mark it as received.`);
      const row = await ctx.db.row("paychecks", pc.id);
      const ok = ctx.check("db", row?.confirmed === true && close(row?.amount, 1234.56) && (row?.actual_amount == null || close(row.actual_amount, 1234.56)), "the paycheck row is confirmed, at the expected 1,234.56", json(row));
      report(ctx, ok, "bug", "Chat: a paycheck reported as received is not confirmed in its row", t, json(row), "I16");
      ctx.check("db", (await ctx.db.count("paychecks", "id=not.is.null")) === n0, "no second paycheck row");
      ctx.check("action", listOf(must(await ctx.api("GET", "/paychecks"), "paychecks")).find((x: any) => x.id === pc.id)?.confirmed === true, "the paycheck list shows it received");
    });

    await part(ctx, "copy_budgets_previous_month", async () => {
      const month = ctx.today.slice(0, 7);
      const prev = O.addMonthsAnchored(`${month}-01`, -1).slice(0, 7);
      const of = async (m: string) => listOf(must(await ctx.api("GET", `/budgets?month=${m}`), "budgets")).map((b: any) => ({ id: b.id, category: String(b.category), amount: Number(b.amount) }));
      const [now0, prev0] = [await of(month), await of(prev)];
      const category = ["gifts", "travel", "pets", "education", "entertainment"].find((c) => !now0.some((b) => b.category.toLowerCase() === c) && !prev0.some((b) => b.category.toLowerCase() === c));
      if (!category) throw new Error("no free budget category to test with");
      const made = must(await ctx.api("POST", "/budgets", { month: prev, category, amount: 77 }), "last month's budget");
      const madeId = made.id ?? made.budget?.id;
      ctx.cleanup(() => ctx.api("DELETE", `/budgets/${madeId}?month=${prev}`));
      ctx.cleanup(async () => { for (const b of await of(month)) if (!now0.some((x) => x.id === b.id)) await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`); });
      const prev1 = await of(prev);
      const stored = prev1.find((b) => b.id === madeId)?.category ?? category;
      await settle();
      const t = await say(ctx, "Copy last month's budgets into this month.");
      const now1 = await of(month);
      const mine = now1.filter((b) => b.category === stored);
      const ok = ctx.check("db", mine.length === 1 && mine[0].amount === 77 && String(await pref(ctx, `budget:${month}`)).includes(stored), `this month now has last month's ${stored} budget of 77, once`, json(now1));
      report(ctx, ok, "bug", "Chat: copying last month's budgets did not bring last month's budget into this month", t, `this month: ${json(now1)}; last month: ${json(prev1)}`, "I16");
      // Mine, worked out from the two lists as they stood: every category last
      // month had and this month lacked arrives with last month's amount;
      // what this month already had keeps its own amount.
      const want = [...now0.map((b) => [b.category, b.amount]), ...prev1.filter((p) => !now0.some((b) => b.category === p.category)).map((p) => [p.category, p.amount])].sort();
      ctx.same("derived", now1.map((b) => [b.category, b.amount]).sort(), want, "this month's budgets = what it had + last month's missing categories at last month's amounts");
      ctx.same("db", (await of(prev)).map((b) => [b.category, b.amount]).sort(), prev1.map((b) => [b.category, b.amount]).sort(), "last month's budgets are untouched");
    });

    const med = `Zolvex${T}`;
    await part(ctx, "skip_medication_dose", async () => {
      const tr = must(await ctx.api("POST", "/trackers", { name: med, category: "medication", fields: [{ name: "adherence", type: "text" }, { name: "dosage", type: "text" }] }), "medication tracker");
      ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tr.id}`));
      const n0 = await ctx.db.count("trackers", "id=not.is.null");
      await settle();
      const t = await say(ctx, `I skipped tonight's dose of ${med} because I felt nauseous.`);
      const entries = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tr.id}`);
      const ok = ctx.check("db", entries.length === 1 && String(entries[0].entry_values?.adherence).toLowerCase() === "skipped", "one entry on that medication's tracker, recorded as skipped (not taken)", json(entries.map((e: any) => e.entry_values)));
      report(ctx, ok, "bug", "Chat: a skipped dose is not one entry marked skipped on the medication's tracker", t, json(entries.map((e: any) => e.entry_values)), "I16, Rule 11");
      ctx.check("db", (await ctx.db.count("trackers", "id=not.is.null")) === n0, "no second tracker was created for it (Rule 11)");
      const doses = must(await ctx.api("GET", `/trackers/${tr.id}`), "tracker");
      ctx.check("derived", (doses.entries || []).filter((e: any) => String(e.values?.adherence).toLowerCase() === "taken").length === 0, "the tracker counts no taken dose from it");
    });

    await part(ctx, "schedule_medication_refills", async () => {
      const c0 = await census(ctx, ["tasks", "trackers"]);
      const t = await say(ctx, `I was prescribed ${med} 10mg once daily: 30 pills with 3 refills, started today at CVS. Schedule the refill reminders.`);
      const evs = (await ctx.db.rows("events", `title=ilike.*${med}*&deleted_at=is.null`)).sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
      for (const e of evs) ctx.cleanup(() => ctx.api("DELETE", `/events/${e.id}`));
      const ok = ctx.check("db", evs.length === 3, "three refill reminders are on the calendar — one per refill", json(evs.map((e: any) => [e.title, e.date])));
      // 30 pills at one a day last 30 days: fill n runs out on day 30n, and its
      // reminder falls in the week before that day.
      const runOut = [1, 2, 3].map((n) => O.addDays(ctx.today, 30 * n));
      const inWindow = evs.length === 3 && evs.every((e: any, i: number) => e.date < runOut[i] && e.date >= O.addDays(runOut[i], -7));
      const okD = ctx.check("derived", inWindow, `each reminder falls in the week before its fill runs out (${runOut.join(", ")})`, json(evs.map((e: any) => e.date)));
      report(ctx, ok && okD, "bug", "Chat: refill reminders for a prescription are not the events the supply calls for", t, json(evs.map((e: any) => [e.title, e.date])), "I16");
      const cal = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 95)}`), "timeline")).filter((i: any) => evs.some((e: any) => e.id === i.sourceId));
      ctx.check("derived", cal.length === evs.length && cal.every((i: any) => evs.some((e: any) => e.id === i.sourceId && e.date === i.date)), "the calendar shows each reminder once, on its stored date", json(cal.map((i: any) => i.date)));
      ctx.same("db", moved(c0, await census(ctx, ["tasks", "trackers"])), {}, "no task and no second tracker were created for the prescription");
    });

    await part(ctx, "update_tracker", async () => {
      const tr = must(await ctx.api("POST", "/trackers", { name: `Laps ${T}`, category: "fitness", fields: [{ name: "laps", type: "number" }] }), "tracker");
      ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tr.id}`));
      must(await ctx.api("POST", `/trackers/${tr.id}/entries`, { values: { laps: 20 } }), "entry");
      const n0 = await ctx.db.count("trackers", "id=not.is.null");
      await settle();
      const t = await say(ctx, `Rename my "Laps ${T}" tracker to "Pool Laps ${T}".`);
      const row = await ctx.db.row("trackers", tr.id);
      const ok = ctx.check("db", row?.name === `Pool Laps ${T}` && row.deleted_at == null && row.category === "fitness", "the same tracker row has the new name; its category is untouched", json({ name: row?.name, category: row?.category }));
      report(ctx, ok, "bug", "Chat: a tracker rename did not rename the tracker's row", t, json({ name: row?.name }), "I16, Rule 11");
      const entries = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tr.id}`);
      ctx.check("db", entries.length === 1 && entries[0].entry_values?.laps === 20 && (await ctx.db.count("trackers", "id=not.is.null")) === n0, "its entry stayed with it and no second tracker was made (Rule 11: never rename by creating)", json(entries.map((e: any) => e.entry_values)));
      ctx.check("derived", listOf(must(await ctx.api("GET", "/trackers"), "trackers")).filter((x: any) => String(x.name).includes(T) && /laps/i.test(x.name)).map((x: any) => x.name).join("|") === `Pool Laps ${T}`, "the tracker list shows it once, under the new name");
    });

    const kin = await mk(ctx, { type: "person", name: `Kin ${T}`, fields: { relationship: "sibling" } });
    let docId = "";
    await part(ctx, "create_document", async () => {
      const expires = O.addDays(ctx.today, 12);
      const n0 = await ctx.db.count("documents", "id=not.is.null");
      await settle();
      const t = await say(ctx, `Create a document called "Permit ${T}" that expires on ${inWords(expires)}. Its content is: parking permit number P-4471.`);
      const rows = await ctx.db.rows("documents", `name=ilike.*${encodeURIComponent(`Permit ${T}`)}*`);
      for (const d of rows) ctx.cleanup(() => ctx.api("POST", `/documents/${d.id}/purge`).then(() => ctx.api("DELETE", `/documents/${d.id}`)));
      const ok = ctx.check("db", rows.length === 1 && rows[0].extracted_data?.expirationDate === expires && (await ctx.db.count("documents", "id=not.is.null")) === n0 + 1, `one document row, expiring ${expires}`, json(rows.map((d: any) => [d.name, d.extracted_data])));
      report(ctx, ok, "bug", "Chat: a document created with an expiry is not one row holding that date", t, json(rows.map((d: any) => [d.name, d.extracted_data])), "I16");
      docId = rows[0]?.id || "";
      const alerts = listOf(must(await ctx.api("GET", "/notifications"), "notifications")).filter((n: any) => json(n, 4000).includes(docId) || json(n, 4000).includes(`Permit ${T}`));
      ctx.check("derived", !!docId && alerts.length === 1, "one alert is raised for the document expiring in 12 days", `${alerts.length}: ${json(alerts)}`);
    });

    await part(ctx, "manage_document (rename)", async () => {
      if (!docId) throw new Error("no document to rename (create_document left none)");
      const before = await ctx.db.row("documents", docId);
      const t = await say(ctx, `Rename the document "Permit ${T}" to "Parking Permit ${T}".`);
      const row = await ctx.db.row("documents", docId);
      const ok = ctx.check("db", row?.name === `Parking Permit ${T}` && row.deleted_at == null && json(row.extracted_data) === json(before.extracted_data), "the same document row has the new name; its expiry is untouched", json({ name: row?.name, x: row?.extracted_data }));
      report(ctx, ok, "bug", "Chat: a document rename did not rename the document's row", t, json({ name: row?.name }), "I16");
      ctx.check("db", (await ctx.db.count("documents", `name=ilike.*${encodeURIComponent(`Permit ${T}`)}*`)) === 1, "no second document");
    });

    await part(ctx, "link_document", async () => {
      if (!docId) throw new Error("no document to link (create_document left none)");
      const before: string[] = (await ctx.db.row("documents", docId))?.linked_profiles || [];
      const t = await say(ctx, `Link the document "Parking Permit ${T}" to "${kin.name}".`);
      const linked: string[] = (await ctx.db.row("documents", docId))?.linked_profiles || [];
      const ok = ctx.check("db", linked.includes(kin.id) && before.every((id) => linked.includes(id)), "the document row is linked to that person and keeps the links it had", json({ before, linked }));
      report(ctx, ok, "bug", "Chat: linking a document to a profile did not add the link", t, json({ before, linked }), "I16, Rule 9");
      const detail = must(await ctx.api("GET", `/profiles/${kin.id}/detail`), "profile detail");
      ctx.check("derived", json(detail, 200000).includes(docId), "the person's page lists the document");
    });

    await part(ctx, "update_artifact / duplicate_artifact", async () => {
      const art = must(await ctx.api("POST", "/artifacts", { type: "checklist", title: `Gear ${T}`, items: [{ text: "Tent" }, { text: "Stove" }, { text: "Lantern" }] }), "checklist");
      ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${art.id}`));
      const texts = (row: any) => (row?.items || []).map((i: any) => [String(i.text), !!i.checked]);
      await settle();
      let t = await say(ctx, `Pin my "Gear ${T}" checklist.`);
      let row = await ctx.db.row("artifacts", art.id);
      let ok = ctx.check("db", row?.pinned === true && json(texts(row)) === json([["Tent", false], ["Stove", false], ["Lantern", false]]) && row.title === `Gear ${T}`, "the checklist row is pinned; its title and three items are untouched", json({ pinned: row?.pinned, items: texts(row) }));
      report(ctx, ok, "bug", "Chat: pinning a checklist did not set its pinned flag (or changed its items)", t, json({ pinned: row?.pinned, items: texts(row) }), "I16");
      ctx.check("derived", listOf(must(await ctx.api("GET", "/artifacts"), "artifacts")).find((a: any) => a.id === art.id)?.pinned === true, "the artifact list shows it starred");

      t = await say(ctx, `Make a copy of my "Gear ${T}" checklist.`);
      const all = await ctx.db.rows("artifacts", `title=ilike.*${encodeURIComponent(`Gear ${T}`)}*&deleted_at=is.null`);
      for (const a of all) ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${a.id}`));
      const copy = all.find((a: any) => a.id !== art.id);
      ok = ctx.check("db", all.length === 2 && !!copy && json(texts(copy)) === json(texts(row)) && copy.type === "checklist" && copy.pinned === false, "one new checklist row with the same three items, not pinned", json(all.map((a: any) => [a.title, a.pinned, texts(a)])));
      report(ctx, ok, "bug", "Chat: copying a checklist did not leave one faithful, unpinned copy", t, json(all.map((a: any) => [a.title, a.pinned, texts(a)])), "I16");
      row = await ctx.db.row("artifacts", art.id);
      ctx.check("db", row?.pinned === true && row.title === `Gear ${T}` && json(texts(row)) === json([["Tent", false], ["Stove", false], ["Lantern", false]]), "the original is unchanged by the copy");
    });

    await part(ctx, "set_record_detail", async () => {
      const kayak = await mk(ctx, { type: "asset", name: `Kayak ${T}`, fields: { currentValue: 400 } });
      const defs = async () => { const raw = await pref(ctx, "detail_definitions"); const v = raw ? JSON.parse(raw) : []; return (Array.isArray(v) ? v : v.definitions || Object.values(v)) as any[]; };
      const conditions = async () => (await defs()).filter((d: any) => String(d.label ?? d.name).toLowerCase() === "condition");
      const had = (await conditions()).length;
      ctx.cleanup(async () => {
        const d = (await conditions())[0];
        if (!d) return;
        await ctx.api("DELETE", `/details/profile/${kayak.id}/${d.id}`);
        if (had === 0) await ctx.api("DELETE", `/details/definitions/${d.id}`);
      });
      await settle();
      const t = await say(ctx, `Record a characteristic on my "Kayak ${T}": its Condition is Good.`);
      const raw = await pref(ctx, `details:profile:${kayak.id}`);
      const now = await conditions();
      const ok = ctx.check("db", !!raw && /"Good"/.test(raw) && now.length === 1, "the record's details row holds \"Good\" under ONE \"Condition\" definition (D1)", `details row ${String(raw).slice(0, 200)}; ${now.length} Condition definition(s)`);
      const f = (await ctx.db.row("profiles", kayak.id))?.fields || {};
      report(ctx, ok, "bug", "Chat: a characteristic set on a record is not stored as a typed characteristic", t, `details:profile row ${String(raw).slice(0, 160)}; Condition definitions ${now.length}; profile fields ${json(f)}`, "D1, D2, D5, I16");
      ctx.check("db", !("condition" in f) && !("Condition" in f) && close(f.currentValue, 400), "it was not also written as a free-text profile field (D5: one source per value), and the value is untouched", json(f));
      const shown = must(await ctx.api("GET", `/details/profile/${kayak.id}`), "details");
      ctx.check("derived", /"Good"/.test(json(shown, 20000)), "the record's characteristics, as the app reads them, show Condition = Good");
    });
    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.event-complete",
  title: "Chat: an event the person attended is recorded as completed",
  area: "AI Chat",
  chat: true,
  covers: ["event.complete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;

    await part(ctx, "complete_event", async () => {
      const ev = must(await ctx.api("POST", "/events", { title: `Checkup ${T}`, date: ctx.today, time: "09:00" }), "event");
      ctx.cleanup(() => ctx.api("DELETE", `/events/${ev.id}`));
      const c0 = await census(ctx, ["events", "tasks", "habits"]);
      const before = await ctx.db.row("events", ev.id);
      await settle();
      const t = await say(ctx, `I went to my "Checkup ${T}" appointment today — mark that event as completed.`);
      const row = await ctx.db.row("events", ev.id);
      // However completion is stored (a status, or a mark among the tags), the
      // row must carry it: a row identical to the one before records nothing.
      const strip = (r: any) => { const { updated_at, ...rest } = r || {}; void updated_at; return rest; };
      const changed = Object.keys(strip(row)).filter((k) => JSON.stringify(strip(row)[k]) !== JSON.stringify(strip(before)[k]));
      const marked = row?.status === "completed" || (row?.tags || []).some((x: any) => /done|complet|attend/i.test(String(x)));
      const ok = ctx.check("db", marked && row.deleted_at == null && row.date === ctx.today && String(row.time).startsWith("09:00"), "the event row records the completion — not deleted, same day and time", `columns that changed: ${json(changed)}; status=${json(row?.status ?? null)} tags=${json(row?.tags)}`);
      report(ctx, ok, "bug", "Chat says an event is marked completed, and nothing is stored", t, `events row columns changed by the message: ${json(changed)} (status=${json(row?.status ?? null)}, tags=${json(row?.tags)}, deleted_at=${json(row?.deleted_at)})`, "I16");
      ctx.check("derived", !marked || listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${ctx.today}`), "timeline")).filter((i: any) => i.sourceId === ev.id).length === 1, "a completed event is still on the calendar once, on its day (completed is not deleted)");
      ctx.same("db", moved(c0, await census(ctx, ["events", "tasks", "habits"])), {}, "no event, task or habit was created beside it");
    });

    ctx.check("action", true, "chat answered the message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.dashboard",
  title: "Chat: notifications made, read and dismissed; mutes, the dashboard's sections and scope; a memory corrected",
  area: "AI Chat",
  chat: true,
  covers: ["dashboard.create.chat", "dashboard.complete.chat", "dashboard.cancel.chat", "dashboard.edit.chat", "memory.edit.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const bell = async () => listOf(must(await ctx.api("GET", "/notifications"), "notifications"));
    const custom = () => ctx.db.rows("user_notifications", `title=ilike.*${encodeURIComponent(T)}*`);
    ctx.cleanup(async () => { const rows = await custom().catch(() => []); if (rows.length) await ctx.api("POST", "/notifications/dismiss", { ids: rows.map((r: any) => `custom:${r.id}`) }); });

    await part(ctx, "create_notification", async () => {
      const n0 = await ctx.db.count("user_notifications", "id=not.is.null");
      const c0 = await census(ctx, ["tasks", "events"]);
      const t = await say(ctx, `Create an urgent notification titled "Roofer ${T}" that says the roofer comes Friday.`);
      const rows = await custom();
      const ok = ctx.check("db", rows.length === 1 && ["critical", "warning"].includes(rows[0].severity) && rows[0].read_at == null && rows[0].dismissed_at == null && (await ctx.db.count("user_notifications", "id=not.is.null")) === n0 + 1, "one notification row, urgent, unread and not dismissed", json(rows.map((r: any) => [r.title, r.severity, r.read_at, r.dismissed_at])));
      report(ctx, ok, "bug", "Chat: a notification it says it created is not one urgent row in the bell's table", t, json(rows.map((r: any) => [r.title, r.severity])), "I16");
      ctx.same("db", moved(c0, await census(ctx, ["tasks", "events"])), {}, "a bell entry is not a task or an event: none was created");
      ctx.check("derived", (await bell()).filter((n: any) => json(n, 2000).includes(`Roofer ${T}`)).length === 1, "the bell lists it once");
    });

    await part(ctx, "mark_notifications_read", async () => {
      const others0 = await ctx.db.count("user_notifications", `read_at=is.null&title=not.ilike.*${T}*`);
      const t = await say(ctx, `Mark the "Roofer ${T}" notification as read.`);
      const rows = await custom();
      const ok = ctx.check("db", rows.length === 1 && rows[0].read_at != null && rows[0].dismissed_at == null, "the notification row is read — and not dismissed", json(rows.map((r: any) => [r.read_at, r.dismissed_at])));
      const done = /\b(marked|done)\b/i.test(t.reply) && !/isn.t possible|not possible|can.t|cannot|couldn.t|unable/i.test(t.reply);
      report(ctx, ok, done ? "bug" : "discrepancy", done ? "Chat: a notification it says it marked read is not read in its row" : "Chat declines to mark a notification it created as read", t, `[read_at, dismissed_at] = ${json(rows.map((r: any) => [r.read_at, r.dismissed_at]))}`, "I16; mark_notifications_read covers every user-created notification");
      ctx.check("db", (await ctx.db.count("user_notifications", `read_at=is.null&title=not.ilike.*${T}*`)) === others0, "no other notification was marked read");
      ctx.check("derived", (await bell()).filter((n: any) => json(n, 2000).includes(`Roofer ${T}`)).length === 1, "a read notification is still in the bell (read is not dismissed)");
    });

    await part(ctx, "dismiss_notifications (a notification, then a dated alert)", async () => {
      const dismissed0 = await pref(ctx, "dismissed_notifications");
      const others0 = await ctx.db.count("user_notifications", `dismissed_at=is.null&title=not.ilike.*${T}*`);
      let t = await say(ctx, `Dismiss the "Roofer ${T}" notification.`);
      const rows = await custom();
      let ok = ctx.check("db", rows.length === 1 && rows[0].dismissed_at != null, "the notification row is dismissed", json(rows.map((r: any) => [r.read_at, r.dismissed_at])));
      report(ctx, ok, "bug", "Chat: a notification it says it dismissed is not dismissed in its row", t, json(rows.map((r: any) => r.dismissed_at)), "Rule 8, I16");
      ctx.check("db", (await ctx.db.count("user_notifications", `dismissed_at=is.null&title=not.ilike.*${T}*`)) === others0 && (await pref(ctx, "dismissed_notifications")) === dismissed0, "nothing else was dismissed: the other notifications and the dismissed-alerts list are as they were");
      ctx.check("derived", (await bell()).filter((n: any) => json(n, 2000).includes(`Roofer ${T}`)).length === 0, "it left the bell");

      // a dated alert has one store: the server's dismissed list (Rule 8)
      const expires = O.addDays(ctx.today, 9);
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const doc = must(await ctx.api("POST", "/documents", { name: `Lease ${T}`, type: "lease", mimeType: "image/png", fileData: PNG, extractedData: { expirationDate: expires } }), "document");
      ctx.cleanup(() => ctx.api("POST", `/documents/${doc.id}/purge`).then(() => ctx.api("DELETE", `/documents/${doc.id}`)));
      const mine = async () => (await bell()).filter((n: any) => json(n, 4000).includes(doc.id) || json(n, 4000).includes(`Lease ${T}`));
      const alerts = await mine();
      if (alerts.length !== 1) throw new Error(`setup: expected one alert for the expiring document, got ${alerts.length}`);
      ctx.cleanup(() => ctx.api("POST", "/notifications/restore", { ids: [alerts[0].id] }));
      const list = (raw: string | null) => { try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
      const before = list(await pref(ctx, "dismissed_notifications"));
      await settle();
      t = await say(ctx, `Dismiss the "Lease ${T}" expiry alert from my notifications.`);
      const after = list(await pref(ctx, "dismissed_notifications"));
      const added = after.filter((id) => !before.includes(id));
      ok = ctx.check("db", json(added) === json([String(alerts[0].id)]) && before.every((id) => after.includes(id)), "the dismissed list gained exactly that alert's id and kept what it had", json({ added, alert: alerts[0].id }));
      report(ctx, ok, "bug", "Chat: an alert it says it dismissed is not in the dismissed list (or others were dismissed with it)", t, json({ added, alert: alerts[0].id }), "Rule 8, I16");
      ctx.check("derived", (await mine()).length === 0, "the alert left the bell");
      ctx.check("derived", json(must(await ctx.api("GET", "/notifications/dismissed"), "dismissed"), 200000).includes(String(alerts[0].id)), "and it is listed among the dismissed alerts, where it can be restored");
      ctx.check("db", !gone(await ctx.db.row("documents", doc.id)) && (await ctx.db.row("documents", doc.id))?.extracted_data?.expirationDate === expires, "the document and its real date were not touched (a dismissal never moves the record's date)");
    });

    await part(ctx, "set_notification_preferences", async () => {
      const before = await pref(ctx, "notification_prefs");
      ctx.cleanup(async () => { if ((await pref(ctx, "notification_prefs")) !== before) await ctx.api("PUT", "/preferences/notification_prefs", { value: before ?? "{}" }); });
      const muted = (raw: string | null) => { try { return JSON.parse(raw || "{}") || {}; } catch { return {}; } };
      const m0 = muted(before);
      let t = await say(ctx, "Mute info notifications.");
      let m = muted(await pref(ctx, "notification_prefs"));
      let ok = ctx.check("db", json(m.muted_severities) === json(["info"]) && json(m.muted_types || []) === json(m0.muted_types || []), "the preference row mutes the info severity, and only that", json(m));
      report(ctx, ok, "bug", "Chat: a mute it confirms is not what the preference row holds", t, json(m), "I16");
      const infos = (await bell()).filter((n: any) => n.severity === "info");
      ctx.check("derived", infos.length === 0, "the bell shows no info-severity notification while it is muted", json(infos.map((n: any) => n.title)));
      t = await say(ctx, "Unmute all my notifications — show everything again.");
      m = muted(await pref(ctx, "notification_prefs"));
      ok = ctx.check("db", (m.muted_severities || []).length === 0 && (m.muted_types || []).length === 0, "the preference row mutes nothing", json(m));
      report(ctx, ok, "bug", "Chat: \"unmute everything\" left a mute in the preference row", t, json(m), "I16");
    });

    await part(ctx, "configure_dashboard_sections", async () => {
      const before = await pref(ctx, "dashboard_layout");
      ctx.cleanup(async () => { if (before != null && (await pref(ctx, "dashboard_layout")) !== before) await ctx.api("PUT", "/preferences/dashboard_layout", { value: before }); });
      const sections = (raw: string | null): any[] => { try { const v = JSON.parse(raw || "null"); return Array.isArray(v) ? v : Array.isArray(v?.sections) ? v.sections : []; } catch { return []; } };
      const vis = (raw: string | null) => Object.fromEntries(sections(raw).map((s: any) => [s.id, s.visible !== false]));
      const v0 = vis(before);
      const want = v0["notifications"] === true ? false : true; // flip whatever it is now
      const t = await say(ctx, want ? "Show the Notifications section on my dashboard." : "Hide the Notifications section on my dashboard.");
      const raw = await pref(ctx, "dashboard_layout");
      const v1 = vis(raw);
      const ok = ctx.check("db", v1["notifications"] === want, `the saved layout has the Notifications section ${want ? "shown" : "hidden"}`, json(v1, 600));
      report(ctx, ok, "bug", "Chat: a dashboard section it says it changed is not changed in the saved layout", t, json(v1, 600), "I16");
      // every other section the layout already listed keeps its visibility and order
      const others = (v: Record<string, boolean>) => Object.entries(v).filter(([id]) => id !== "notifications" && (before == null || id in v0));
      if (before != null) {
        ctx.same("db", others(v1), others(v0), "no other section's visibility or order changed");
      } else {
        ctx.check("db", sections(raw).filter((s: any) => s.id !== "notifications" && s.visible !== false).map((s: any) => s.id).join(",") === "exec-briefing", "with no layout saved before, the only other visible section is the default Daily Briefing", json(v1, 600));
      }
      if (before == null) ctx.cleanup(() => chat(ctx, "Reset my dashboard layout to the default."));
      ctx.check("derived", json(must(await ctx.api("GET", "/preferences/dashboard_layout"), "layout preference"), 20000).includes("notifications"), "the layout the dashboard reads is the stored one");
    });

    await part(ctx, "update_memory", async () => {
      const key = `Gatecode${T}`;
      const mem = must(await ctx.api("POST", "/memories", { key, value: "4471", category: "general" }), "memory");
      ctx.cleanup(() => ctx.api("DELETE", `/memories/${mem.id}`));
      ctx.cleanup(async () => { for (const x of await ctx.db.rows("memories", `or=(key.ilike.*${key}*,value.ilike.*${key}*)`).catch(() => [])) await ctx.api("DELETE", `/memories/${x.id}`); });
      const n0 = await ctx.db.count("memories", "id=not.is.null");
      await settle();
      const t = await say(ctx, `Actually my ${key} is 9912, not 4471 — update that memory.`);
      const row = await ctx.db.row("memories", mem.id);
      const all = await ctx.db.rows("memories", `or=(key.ilike.*${key}*,value.ilike.*${key}*,value.ilike.*9912*)`);
      const ok = ctx.check("db", !!row && String(row.value).includes("9912") && !String(row.value).includes("4471") && (await ctx.db.count("memories", "id=not.is.null")) === n0, "the same memory row now holds 9912 — corrected, not a second memory", json(all.map((x: any) => [x.key, x.value])));
      report(ctx, ok, "bug", "Chat: a corrected memory is not the same row with the new value", t, json(all.map((x: any) => [x.key, x.value])), "I16");
      ctx.check("derived", json(must(await ctx.api("GET", `/memories/recall?q=${encodeURIComponent(key)}`), "recall"), 20000).includes("9912"), "recalling it gives the corrected value");
    });
    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.dashboard-scope",
  title: "Chat: switching whose data the dashboard shows hands the app that scope — and writes nothing",
  area: "AI Chat",
  chat: true,
  covers: ["dashboard.edit.chat"],
  requires: ["action", "db"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const kin = await mk(ctx, { type: "person", name: `Kin ${T}`, fields: { relationship: "sibling" } });
    const rowBefore = json(await ctx.db.row("profiles", kin.id), 4000);
    // The scope lives in the app, not in a row: the chat's answer carries it
    // (`scope: { mode, profileId }`) and the screen applies it. A reply that
    // says the view changed while the answer carries no scope changed nothing.
    const selected = (t: Turn) => { const p = json(t.data, 20000); return p.includes(kin.id) && /"mode"\s*:\s*"selected"/.test(p); };
    const everyone = (t: Turn) => /"mode"\s*:\s*"everyone"/.test(json(t.data, 20000));
    const claims = (t: Turn) => /\b(now|switched|filtered|scoped|showing|set to|focused)\b/i.test(t.reply) && !/couldn.t|could not|didn.t|not chang/i.test(t.reply);
    await settle();

    for (const [label, sentence] of [
      ["in the tool's own words (\"filter the dashboard to <Name>\")", `Filter the dashboard to ${kin.name}.`],
      ["said another way (\"switch the dashboard to show only <Name>\")", `Switch the dashboard to show only "${kin.name}".`],
    ] as const) {
      await part(ctx, `set_dashboard_scope — ${label}`, async () => {
        const c0 = await census(ctx);
        const t = await say(ctx, sentence);
        const ok = ctx.check("action", selected(t) || !claims(t), `${label}: a reply that says the dashboard now shows one person carries that person's scope`, json(t.data, 420));
        report(ctx, ok, "bug", "Chat says the dashboard is now filtered to one person, but its answer carries no scope — the view does not change", t, `answer: ${json({ actions: t.data?.actions, results: t.data?.results }, 400)}`, "I16; Rule 4 (the scope is a filter the app must be told about)");
        ctx.check("action", selected(t), `${label}: the answer carries the scope to switch to`, json({ results: t.data?.results }, 300));
        ctx.same("db", moved(c0, await census(ctx)), {}, "changing the view created and removed nothing (thirteen tables)");
        ctx.check("db", json(await ctx.db.row("profiles", kin.id), 4000) === rowBefore, "the person's own row is untouched by being looked at");
      });
    }
    await part(ctx, "set_dashboard_scope — back to Everyone", async () => {
      const c0 = await census(ctx);
      const t = await say(ctx, "Switch to the Everyone view on my dashboard.");
      ctx.check("action", everyone(t), "the answer to \"Everyone\" carries the everyone scope", json({ results: t.data?.results }, 300));
      ctx.same("db", moved(c0, await census(ctx)), {}, "and nothing was written");
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.profiles",
  title: "Chat: a profile edited, linked, repaired, merged in two steps and deleted; a custom domain removed",
  area: "AI Chat",
  chat: true,
  covers: ["profile.edit.chat", "profile.transfer.chat", "profile.delete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const kin = await mk(ctx, { type: "person", name: `Kin ${T}`, fields: { relationship: "sibling" } });
    const livePeople = () => ctx.db.count("profiles", "type=eq.person&deleted_at=is.null");

    await part(ctx, "update_profile", async () => {
      const n0 = await ctx.db.count("profiles", "deleted_at=is.null");
      await settle();
      const t = await say(ctx, `Update "${kin.name}": the phone number is 555-0142.`);
      const row = await ctx.db.row("profiles", kin.id);
      const ok = ctx.check("db", String(row?.fields?.phone ?? "").replace(/\D/g, "").endsWith("5550142") && row.name === kin.name && row.type === "person" && row.fields?.relationship === "sibling", "the same profile row holds the phone number; name, type and relationship are untouched", json(row?.fields));
      report(ctx, ok, "bug", "Chat: a profile field it confirms is not in the profile's row under its own key", t, json(row?.fields), "L2, I16");
      ctx.check("db", (await ctx.db.count("profiles", "deleted_at=is.null")) === n0, "no profile was created for the edit");
      const detail = must(await ctx.api("GET", `/profiles/${kin.id}/detail`), "detail");
      ctx.check("derived", json(detail, 200000).replace(/\D/g, "").includes("5550142"), "the profile's page shows the number");
    });

    await part(ctx, "a task filed under a person (link_entities or update_task)", async () => {
      const task = must(await ctx.api("POST", "/tasks", { title: `Call plumber ${T}`, dueDate: O.addDays(ctx.today, 6) }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      const c0 = await census(ctx, ["tasks", "profiles", "events"]);
      await settle();
      const t = await say(ctx, `Link the task "Call plumber ${T}" to "${kin.name}".`);
      const row = await ctx.db.row("tasks", task.id);
      const edges = await ctx.db.rows("entity_links", `or=(source_id.eq.${task.id},target_id.eq.${task.id})`).catch(() => [] as any[]);
      const ok = ctx.check("db", (row?.linked_profiles || []).includes(kin.id), "the task row is filed under that person", json({ linked: row?.linked_profiles, edges: edges.length }));
      report(ctx, ok, "discrepancy", "Chat: a task \"linked\" to a person through link_entities is not filed under them (through update_task it is)", t, `task.linked_profiles=${json(row?.linked_profiles)} (the person is ${kin.id}); entity_links rows touching the task: ${json(edges.map((e: any) => [e.source_type, e.source_id === kin.id ? "person" : e.source_id === task.id ? "task" : e.source_id, e.target_type, e.target_id === kin.id ? "person" : e.target_id === task.id ? "task" : e.target_id, e.relationship]))}`, "Rule 9 (ownership has one writer), I16");
      ctx.check("db", row?.title === `Call plumber ${T}` && row.due_date === O.addDays(ctx.today, 6) && row.status === "todo", "the task itself (title, date, status) is untouched");
      ctx.same("db", moved(c0, await census(ctx, ["tasks", "profiles", "events"])), {}, "no task, profile or event was created");
      const scoped = listOf(must(await ctx.api("GET", `/tasks?profileIds=${kin.id}`), "tasks for the person"));
      ctx.check("derived", scoped.some((x: any) => x.id === task.id), "the person's own task list now includes it");
    });

    await part(ctx, "link_entities (an expense and a document)", async () => {
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const doc = must(await ctx.api("POST", "/documents", { name: `Warranty ${T}`, type: "warranty", mimeType: "image/png", fileData: PNG, linkedProfiles: [ctx.self.id] }), "document");
      ctx.cleanup(() => ctx.api("POST", `/documents/${doc.id}/purge`).then(() => ctx.api("DELETE", `/documents/${doc.id}`)));
      const exp = must(await ctx.api("POST", "/expenses", { description: `Fridge repair ${T}`, amount: 84, category: "home", date: ctx.today }), "expense");
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${exp.id}`));
      const edges = () => ctx.db.rows("entity_links", `or=(and(source_id.eq.${exp.id},target_id.eq.${doc.id}),and(source_id.eq.${doc.id},target_id.eq.${exp.id}))`);
      ctx.cleanup(async () => { for (const e of await edges().catch(() => [])) await ctx.api("DELETE", `/entity-links/${e.id}`); });
      const c0 = await census(ctx, ["expenses", "documents", "profiles", "tasks"]);
      await settle();
      const t = await say(ctx, `Link the expense "Fridge repair ${T}" to the document "Warranty ${T}" — that document is for that expense.`);
      const rows = await edges();
      const ok = ctx.check("db", rows.length === 1, "one link row joins that expense and that document", json(rows.map((e: any) => [e.source_type, e.target_type, e.relationship])));
      const claimed = /\b(linked|connected|attached)\b/i.test(t.reply) && !/couldn.t|could not|can.t|cannot|unable|didn.t/i.test(t.reply);
      report(ctx, ok || !claimed, "bug", "Chat says it linked two records, and no link row joins them", t, `${rows.length} entity_links row(s) between the expense and the document`, "I16");
      const e2 = await ctx.db.row("expenses", exp.id);
      ctx.check("db", close(e2?.amount, 84) && e2.description === `Fridge repair ${T}` && e2.deleted_at == null, "the expense itself is untouched");
      ctx.same("db", moved(c0, await census(ctx, ["expenses", "documents", "profiles", "tasks"])), {}, "nothing was created or removed to make the link");
      ctx.check("derived", !ok || json(must(await ctx.api("GET", `/entity-links/expense/${exp.id}/related`), "related"), 20000).includes(doc.id), "the expense's related records include the document");
    });

    await part(ctx, "repair_profile_types (preview, then confirm)", async () => {
      const thing = await mk(ctx, { type: "person", name: `my Projector ${T}`, fields: {} });
      let row = await ctx.db.row("profiles", thing.id);
      if (row?.type !== "person") { await ctx.api("PATCH", `/profiles/${thing.id}`, { type: "person" }); row = await ctx.db.row("profiles", thing.id); }
      const misfiled = row?.type === "person";
      ctx.step(misfiled ? "an object is filed as a person" : `the app's own doors refuse to file an object as a person (the row is "${row?.type}"): the repair has nothing of ours to fix`);
      const people0 = await livePeople();
      const c0 = await census(ctx, ["profiles", "tasks", "events"]);
      await settle();
      const first = await chat(ctx, "Fix my profile types — there are objects in my profile list that got filed as people.");
      if (!misfiled) {
        // Nothing misfiled can be set up through the API, so what is verified
        // here is only that the tool looks, says what it found, and changes nothing.
        const after = await ctx.db.row("profiles", thing.id);
        ctx.check("db", json(after, 4000) === json(row, 4000) && (await livePeople()) === people0, "with nothing misfiled, the repair changed no profile", json({ type: after?.type, name: after?.name }));
        ctx.same("db", moved(c0, await census(ctx, ["profiles", "tasks", "events"])), {}, "and created or removed nothing");
        ctx.check("action", !/\b(fixed|retyped|converted|repaired)\s+\d*[1-9]/i.test(first.reply), "the reply does not claim a repair it did not make", first.reply.replace(/\s+/g, " ").slice(0, 200));
        return;
      }
      row = await ctx.db.row("profiles", thing.id);
      const asked = row?.type === "person" && row.deleted_at == null;
      ctx.check("db", asked || row?.type === "asset", "the first message either only previews (the row is still as it was) or has already retyped it", json({ type: row?.type, name: row?.name }));
      ctx.check("action", !asked || first.reply.includes("Projector"), "the preview names what it found before changing anything", first.reply.replace(/\s+/g, " ").slice(0, 200));
      const t = asked ? await yes(ctx, first, "Yes, fix them.") : first;
      row = await ctx.db.row("profiles", thing.id);
      const ok = ctx.check("db", !!row && row.deleted_at == null && row.type === "asset" && row.name === `Projector ${T}`, "after the yes, the same row is an asset named without the \"my\"", json({ type: row?.type, name: row?.name, deleted_at: row?.deleted_at }));
      report(ctx, ok, "bug", "Chat: an object filed as a person is not retyped after the repair was confirmed", t, json({ type: row?.type, name: row?.name, deleted_at: row?.deleted_at }), "I16");
      const kinRow = await ctx.db.row("profiles", kin.id);
      ctx.check("db", kinRow?.type === "person" && kinRow.deleted_at == null && kinRow.name === kin.name, "a real person was not touched by the repair");
      ctx.near("derived", await livePeople(), people0 - 1, "the people list is shorter by exactly the one misfiled object");
    });

    await part(ctx, "repair_relations", async () => {
      const c0 = await census(ctx);
      const kin0 = json(await ctx.db.row("profiles", kin.id), 4000);
      const t = await say(ctx, "Repair my data — fix any broken ownership links.");
      ctx.same("db", moved(c0, await census(ctx)), {}, "a repair creates and deletes nothing (thirteen tables)");
      ctx.check("db", json(await ctx.db.row("profiles", kin.id), 4000) === kin0, "a correctly owned profile is left exactly as it was");
      const claimed = Number((t.reply.match(/(\d+)\s+of\s+\d+/) || [])[1] ?? NaN);
      ctx.check("action", t.reply.length > 0 && (Number.isNaN(claimed) || claimed >= 0), "the reply reports what the repair found", t.reply.replace(/\s+/g, " ").slice(0, 200));
    });

    await part(ctx, "merge_profiles → execute_bulk_action (preview, then confirm)", async () => {
      const src = await mk(ctx, { type: "person", name: `Mika ${T}`, fields: { relationship: "friend", email: `mika-${T.toLowerCase()}@example.com` } });
      const dst = await mk(ctx, { type: "person", name: `Mikaela ${T}`, fields: { relationship: "friend" } });
      const task = must(await ctx.api("POST", "/tasks", { title: `Gift idea ${T}`, linkedProfiles: [src.id] }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      const c0 = await census(ctx, ["tasks", "events", "expenses", "documents"]);
      await settle();
      const first = await chat(ctx, `Merge the profile "${src.name}" into "${dst.name}" — they are the same person.`);
      const s1 = await ctx.db.row("profiles", src.id);
      const t1 = await ctx.db.row("tasks", task.id);
      const okPreview = ctx.check("db", s1?.deleted_at == null && json(t1?.linked_profiles) === json([src.id]), "the first message is a preview: the source is still live and its task still its own", json({ deleted_at: s1?.deleted_at, linked: t1?.linked_profiles }));
      report(ctx, okPreview, "bug", "Chat merged two profiles without waiting for the confirmation", first, json({ source_deleted_at: s1?.deleted_at, task_links: t1?.linked_profiles }), "Rule 8 (two steps)");
      ctx.check("action", /\?/.test(first.reply) || /confirm|preview/i.test(first.reply), "the preview asks before merging", first.reply.replace(/\s+/g, " ").slice(0, 200));
      const t = await yes(ctx, first, "Yes, merge them.");
      const s2 = await ctx.db.row("profiles", src.id);
      const d2 = await ctx.db.row("profiles", dst.id);
      const t2 = await ctx.db.row("tasks", task.id);
      const ok = ctx.check("db", gone(s2) && !gone(d2) && json(t2?.linked_profiles) === json([dst.id]), "after the yes: the source is archived, the target lives, and the task now belongs to the target only", json({ source: s2?.deleted_at, target: d2?.deleted_at, linked: t2?.linked_profiles }));
      report(ctx, ok, "bug", "Chat: a confirmed merge did not archive the source and move its records to the target", t, json({ source_deleted_at: s2?.deleted_at, target_deleted_at: d2?.deleted_at, task_links: t2?.linked_profiles }), "Rule 9, I16");
      ctx.check("db", d2?.fields?.email === `mika-${T.toLowerCase()}@example.com` && d2?.fields?.relationship === "friend", "the target gained the value it lacked (the e-mail) and kept its own", json(d2?.fields));
      ctx.same("db", moved(c0, await census(ctx, ["tasks", "events", "expenses", "documents"])), {}, "no record was created or lost in the merge");
      const mine = listOf(must(await ctx.api("GET", `/tasks?profileIds=${dst.id}`), "the target's tasks"));
      ctx.check("derived", mine.some((x: any) => x.id === task.id), "the target's task list includes the task that was the source's");
    });

    await part(ctx, "delete_profile (a person)", async () => {
      const task = must(await ctx.api("POST", "/tasks", { title: `Shared errand ${T}`, linkedProfiles: [kin.id, ctx.self.id] }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      const people0 = await livePeople();
      await settle();
      const t = await say(ctx, `Delete the profile "${kin.name}".`);
      const row = await ctx.db.row("profiles", kin.id);
      const ok = ctx.check("db", gone(row), "the person's row is deleted", json({ deleted_at: row?.deleted_at }));
      report(ctx, ok, "bug", "Chat: asked to delete a person (and told yes), the profile is still there", t, json({ deleted_at: row?.deleted_at }), "I16");
      ctx.near("derived", await livePeople(), people0 - 1, "the people list is shorter by exactly one");
      const shared = await ctx.db.row("tasks", task.id);
      ctx.check("db", !!shared && shared.deleted_at == null && (shared.linked_profiles || []).includes(ctx.self.id), "a task shared with the account holder survives, still filed under them (Rule 9)", json(shared?.linked_profiles));
      const orphans = (await ctx.db.count("asset_party_links", `party_profile_id=eq.${kin.id}`)) + (await ctx.db.count("liability_profile_links", `party_profile_id=eq.${kin.id}`));
      ctx.check("db", orphans === 0, "no ownership row names the deleted person", `${orphans}`);
    });

    await part(ctx, "delete_domain", async () => {
      const dn = `Cellar ${T}`;
      const domains = () => ctx.db.rows("domains", `name=ilike.*${encodeURIComponent(dn)}*`);
      ctx.cleanup(async () => { if ((await domains().catch(() => [])).length) await chat(ctx, `Delete the "${dn}" domain. Yes, I am sure.`); });
      const n0 = await ctx.db.count("domains", "id=not.is.null");
      await say(ctx, `Create a custom domain called "${dn}" for tracking wine bottles.`);
      const made = await domains();
      if (made.length !== 1) throw new Error(`setup through chat: expected one "${dn}" domain, found ${made.length}`);
      const t = await say(ctx, `Delete the "${dn}" domain.`);
      const left = (await domains()).filter((d: any) => d.deleted_at == null);
      const ok = ctx.check("db", left.length === 0 && (await ctx.db.count("domains", "id=not.is.null&deleted_at=is.null").catch(() => ctx.db.count("domains", "id=not.is.null"))) <= n0, "the domain's row is gone, and no other domain with it", json(left.map((d: any) => d.name)));
      report(ctx, ok, "bug", "Chat: asked to delete a custom domain (and told yes), the domain is still there", t, json(left.map((d: any) => d.name)), "I16");
    });
    ctx.check("action", true, "chat answered each message");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "chat-tools.bulk-and-undo",
  title: "Chat: a bulk delete previews before it deletes; undo reverses only the last action; what chat cannot do, it says",
  area: "AI Chat",
  chat: true,
  covers: ["chat.edit.chat", "chat.cancel.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;

    await part(ctx, "preview_bulk_action → execute_bulk_action", async () => {
      const word = `Bulk${T}`;
      const ids: string[] = [];
      for (const n of ["one", "two", "three"]) {
        const task = must(await ctx.api("POST", "/tasks", { title: `${word} ${n}`, dueDate: O.addDays(ctx.today, 20) }), "task");
        ids.push(task.id);
        ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      }
      const keep = must(await ctx.api("POST", "/tasks", { title: `Keeper ${T}`, dueDate: O.addDays(ctx.today, 20) }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${keep.id}`));
      const liveTasks = () => ctx.db.count("tasks", "deleted_at=is.null");
      const n0 = await liveTasks();
      const c0 = await census(ctx, ["events", "expenses", "profiles", "habits"]);
      await settle();
      const first = await chat(ctx, `Delete all my tasks whose title contains "${word}".`);
      const stillLive = (await Promise.all(ids.map((id) => ctx.db.row("tasks", id)))).filter((r) => !gone(r)).length;
      const okPreview = ctx.check("db", stillLive === 3 && (await liveTasks()) === n0, "the first message is a preview: all three tasks are still there", `${stillLive} of 3 live`);
      report(ctx, okPreview, "bug", "Chat ran a bulk delete without waiting for the confirmation", first, `${stillLive} of 3 tasks still live after the first message`, "Rule 8 (two steps)");
      ctx.check("action", /\b3\b|three/i.test(first.reply), "the preview says how many records it would delete (3)", first.reply.replace(/\s+/g, " ").slice(0, 200));
      const t = await yes(ctx, first, "Yes, delete them.");
      const left = (await Promise.all(ids.map((id) => ctx.db.row("tasks", id)))).filter((r) => !gone(r)).length;
      const ok = ctx.check("db", left === 0, "after the yes, all three task rows are deleted", `${left} of 3 still live`);
      report(ctx, ok, "bug", "Chat: a confirmed bulk delete left matching records in place", t, `${left} of 3 tasks still live`, "I16");
      const k = await ctx.db.row("tasks", keep.id);
      ctx.check("db", !gone(k) && k.title === `Keeper ${T}`, "the task that did not match is untouched");
      ctx.near("derived", await liveTasks(), n0 - 3, "the task list is shorter by exactly three");
      ctx.same("db", moved(c0, await census(ctx, ["events", "expenses", "profiles", "habits"])), {}, "nothing of another kind was created or removed");
      ctx.check("derived", !listOf(must(await ctx.api("GET", "/tasks"), "tasks")).some((x: any) => String(x.title).includes(word)), "none of them is in the task list any more");
    });

    await part(ctx, "undo_last_action", async () => {
      const s0 = await snapshot(ctx);
      const live = (w: string) => ctx.db.rows("expenses", `description=ilike.*${encodeURIComponent(w)}*&deleted_at=is.null`);
      await say(ctx, `I spent $11.11 today. Call the expense "First ${T}".`);
      await say(ctx, `I spent $22.22 today. Call the expense "Second ${T}".`);
      const a0 = await live(`First ${T}`), b0 = await live(`Second ${T}`);
      for (const e of [...a0, ...b0]) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      if (a0.length !== 1 || b0.length !== 1) throw new Error(`setup through chat: expected one expense each, found ${a0.length} and ${b0.length}`);
      const c0 = await census(ctx, ["tasks", "events", "profiles", "incomes"]);
      let t = await say(ctx, "Undo my last action.");
      let a = await live(`First ${T}`), b = await live(`Second ${T}`);
      let ok = ctx.check("db", b.length === 0 && a.length === 1 && a[0].id === a0[0].id && close(a[0].amount, 11.11), "only the LAST action is reversed: the second expense is gone, the first is untouched", json({ first: a.map((e: any) => e.amount), second: b.map((e: any) => e.amount) }));
      report(ctx, ok, "bug", "Chat: \"undo my last action\" did not reverse exactly the last action", t, json({ first: a.map((e: any) => e.amount), second: b.map((e: any) => e.amount) }), "I16");
      ctx.near("derived", O.cents((await snapshot(ctx)).totalMonthlySpend - s0.totalMonthlySpend), 11.11, "this month's spending holds the first expense only");

      // an update is undone to the value it had
      await say(ctx, `Change the "First ${T}" expense to $15.`);
      a = await live(`First ${T}`);
      if (!(a.length === 1 && close(a[0].amount, 15))) throw new Error(`setup through chat: the expense should read 15, got ${json(a.map((e: any) => e.amount))}`);
      t = await say(ctx, "Undo that.");
      a = await live(`First ${T}`); b = await live(`Second ${T}`);
      ok = ctx.check("db", a.length === 1 && a[0].id === a0[0].id && close(a[0].amount, 11.11) && b.length === 0, "an edit is undone to the value it had (11.11), on the same row; the earlier undo is not itself undone", json({ first: a.map((e: any) => e.amount), second: b.length }));
      report(ctx, ok, "bug", "Chat: undoing an edit did not put the previous value back", t, json({ first: a.map((e: any) => e.amount), second: b.length }), "I16");
      ctx.near("derived", O.cents((await snapshot(ctx)).totalMonthlySpend - s0.totalMonthlySpend), 11.11, "this month's spending is back to the first expense at its original amount");
      ctx.same("db", moved(c0, await census(ctx, ["tasks", "events", "profiles", "incomes"])), {}, "neither undo created or removed anything else");
    });

    await part(ctx, "refresh_financial_data (no bank connection) and upload_document (needs a file)", async () => {
      const tables = [...CENSUS, "finance_imports"];
      const c0 = await census(ctx, tables);
      const t = await say(ctx, "Refresh my bank data — sync my connected accounts now.");
      ctx.same("db", moved(c0, await census(ctx, tables)), {}, "with no bank connected, a refresh writes nothing (fourteen tables)");
      const figs = /\b(synced|imported|pulled in|added|updated)\s+\d+\s+(new\s+)?(transaction|account)/i.test(t.reply);
      const ok = ctx.check("action", !figs && /(no|not|n't|isn.t|aren.t|don.t|without|unable|can.t|cannot)\b[^.]{0,120}(connect|link|set up|configured|available|bank|sync)/i.test(t.reply), "the reply says there is nothing connected to refresh — it claims no sync", t.reply.replace(/\s+/g, " ").slice(0, 260));
      report(ctx, ok, "bug", "Chat claims a bank refresh with no bank connected", t, "no row changed in fourteen tables", "I16");
      const d0 = await ctx.db.count("documents", "id=not.is.null");
      const u = await say(ctx, "Upload my passport scan to my profile.");
      ctx.check("db", (await ctx.db.count("documents", "id=not.is.null")) === d0, "asked to upload with no file attached, no document row is made");
      ctx.check("action", !/\b(uploaded|saved|attached)\b[^.]{0,60}\b(passport|document|file|scan)\b/i.test(u.reply) || /(paperclip|attach|button|can.t|cannot|unable)/i.test(u.reply), "the reply does not claim an upload it could not have made", u.reply.replace(/\s+/g, " ").slice(0, 220));
    });
    ctx.check("action", true, "chat answered each message");
  },
});
