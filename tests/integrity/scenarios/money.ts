// Money: net worth, nested assets, debts and their payments, bills, budgets.
// Every expected figure comes from ../oracle (never from shared/).
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

/** Live expense rows carrying one tag (tags is a json array). */
export const tagQ = (tag: string) => `tags=cs.${encodeURIComponent(JSON.stringify([tag]))}&deleted_at=is.null`;

const RATE_UNIT = "_interestRateUnit"; // the stored marker (CLAUDE.md L3), spelled here on purpose

export async function snapshot(ctx: Ctx) {
  const d = must(await ctx.api("GET", "/dashboard-enhanced"), "dashboard-enhanced");
  const f = d.financeSnapshot;
  if (!f || typeof f.totalAssetValue !== "number" || typeof f.totalLiabilities !== "number") throw new Error("financeSnapshot has no totals");
  return f;
}

async function mkProfile(ctx: Ctx, body: any) {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}`));
  return p;
}

scenario({
  id: "money.net-worth",
  title: "Net worth follows every asset, account and debt, each counted once",
  area: "Net worth",
  covers: ["asset.create.api", "asset.edit.api", "asset.delete.api", "account.create.api", "account.edit.api", "account.delete.api", "liability.create.api", "bill.create.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const before = await snapshot(ctx);
    const car = ctx.int(18, 42) * 1000;
    const rack = ctx.int(3, 19) * 100;
    const cash = ctx.int(1000, 9000) + 0.25;
    const debt = ctx.int(6, 15) * 1000;

    const vehicle = await mkProfile(ctx, { type: "vehicle", name: `${ctx.tag} Wagon`, fields: { currentValue: car, purchasePrice: car + 9000, purchaseDate: "2023-05-27" } });
    const child = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} Roof Rack`, parentProfileId: vehicle.id, fields: { currentValue: rack } });
    const acct = must(await ctx.api("POST", "/accounts", { name: `${ctx.tag} Checking`, accountKind: "checking", balance: cash }), "create account");
    const acctId = acct.id ?? acct.account?.id;
    ctx.cleanup(() => ctx.api("DELETE", `/accounts/${acctId}`));
    const loan = await mkProfile(ctx, { type: "liability", type_key: "auto_loan", name: `${ctx.tag} Car Loan`, fields: { balance: debt, monthlyPayment: 400, dueDay: 15, interestRate: 6, [RATE_UNIT]: "percent" } });
    const bill = await mkProfile(ctx, { type: "liability", type_key: "phone_plan", name: `${ctx.tag} Phone Plan`, fields: { amount: 85, frequency: "monthly", dueDate: ctx.today } });

    // db
    const vRow = await ctx.db.row("profiles", vehicle.id);
    ctx.check("db", vRow?.fields?.currentValue === car && vRow.deleted_at == null, `the vehicle row holds currentValue ${car}`, JSON.stringify(vRow?.fields));
    const cRow = await ctx.db.row("profiles", child.id);
    ctx.check("db", cRow?.parent_profile_id === vehicle.id, "the nested asset's row points at its parent", `parent_profile_id=${cRow?.parent_profile_id}`);
    const lRow = await ctx.db.row("profiles", loan.id);
    ctx.check("db", lRow?.fields?.balance === debt && lRow?.type_key === "auto_loan", `the loan row holds balance ${debt} under type_key auto_loan`, JSON.stringify({ f: lRow?.fields, k: lRow?.type_key }));
    ctx.check("db", (await ctx.db.count("profiles", `name=like.${ctx.tag}*&deleted_at=is.null`)) === 5, "exactly five live rows were created (no duplicates)");

    // derived
    const want = O.netWorth([{ value: car }, { value: rack }, { value: cash }], [{ value: debt }]);
    const after = await snapshot(ctx);
    ctx.near("derived", O.cents(after.totalAssetValue - before.totalAssetValue), want.assets, "assets rose by vehicle + nested item + cash");
    ctx.near("derived", O.cents(after.totalLiabilities - before.totalLiabilities), want.liabilities, "debt rose by the loan only (a recurring bill is not debt)");
    const inAssets = (id: string) => (after.assetBreakdown || []).filter((r: any) => r.id === id).length;
    ctx.check("derived", inAssets(vehicle.id) === 1 && inAssets(child.id) === 1, "parent and nested asset each appear once in the asset breakdown");
    ctx.check("derived", !(after.liabilityBreakdown || []).some((r: any) => r.id === bill.id), "the phone plan is not in the debt breakdown");
    ctx.check("derived", !(after.assetBreakdown || []).some((r: any) => r.id === loan.id), "the loan is not listed among assets");

    // edit → propagates
    must(await ctx.api("PATCH", `/profiles/${vehicle.id}`, { fields: { currentValue: car - 1000 } }), "edit value");
    const edited = await snapshot(ctx);
    ctx.near("derived", O.cents(edited.totalAssetValue - after.totalAssetValue), -1000, "lowering the vehicle's value by 1,000 lowers assets by 1,000");
    const vRow2 = await ctx.db.row("profiles", vehicle.id);
    ctx.check("db", vRow2.fields.currentValue === car - 1000 && vRow2.fields.purchasePrice === car + 9000 && vRow2.fields.purchaseDate === "2023-05-27",
      "the edit changed one field and kept the others", JSON.stringify(vRow2.fields));

    must(await ctx.api("PATCH", `/accounts/${acctId}`, { balance: cash + 100 }), "edit balance");
    const edited2 = await snapshot(ctx);
    ctx.near("derived", O.cents(edited2.totalAssetValue - edited.totalAssetValue), 100, "raising the account balance by 100 raises assets by 100");

    // delete the nested asset: gone from totals, parent untouched
    const del = await ctx.api("DELETE", `/profiles/${child.id}`);
    ctx.check("action", del.ok, "the nested asset is deleted", `${del.status}`);
    const afterDel = await snapshot(ctx);
    ctx.near("derived", O.cents(afterDel.totalAssetValue - edited2.totalAssetValue), -rack, "assets fell by exactly the nested item's value");
    const cGone = await ctx.db.row("profiles", child.id);
    ctx.check("db", cGone === null || cGone.deleted_at != null, "its row is deleted or marked deleted");
    const vStill = await ctx.db.row("profiles", vehicle.id);
    ctx.check("db", vStill?.deleted_at == null, "the parent's row is untouched by its child's deletion");

    const list = listOf(must(await ctx.api("GET", "/profiles"), "profiles"));
    ctx.check("action", !list.some((p: any) => p.id === child.id) && list.some((p: any) => p.id === vehicle.id), "the profile list drops the child and keeps the parent");
  },
});

scenario({
  id: "money.legacy-loan-counted-once",
  title: "A loan-typed profile is a debt, never also an asset",
  area: "Net worth",
  covers: ["liability.create.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const before = await snapshot(ctx);
    const loan = await mkProfile(ctx, { type: "loan", name: `${ctx.tag} Old Loan`, fields: { balance: 20000, interestRate: 5, monthlyPayment: 300 } });
    ctx.check("action", loan.type === "loan", "the profile is stored with the legacy type loan");
    const row = await ctx.db.row("profiles", loan.id);
    ctx.check("db", row?.fields?.balance === 20000, "its row holds the 20,000 balance");
    const after = await snapshot(ctx);
    ctx.near("derived", O.cents(after.totalLiabilities - before.totalLiabilities), 20000, "debt rose by 20,000");
    const ok = ctx.near("derived", O.cents(after.totalAssetValue - before.totalAssetValue), 0, "assets did not move");
    if (!ok) ctx.finding({ severity: "discrepancy", title: "A loan-typed profile's balance is added to assets as well as debts", detail: `assets moved by ${O.cents(after.totalAssetValue - before.totalAssetValue)} for a 20,000 loan; net worth is overstated by the balance` });
  },
});

scenario({
  id: "money.loan-payments",
  title: "Loan payments: interest once a month, principal off the balance, reversal restores everything",
  area: "Liabilities",
  covers: ["liabilityPayment.create.api", "liabilityPayment.delete.api", "liability.edit.api", "liability.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const balance = ctx.int(80, 200) * 100;
    const apr = ctx.pick([3.9, 6, 7.25, 12.5, 22.9]);
    const amount = ctx.int(3, 6) * 100;
    const loan = await mkProfile(ctx, { type: "liability", type_key: "auto_loan", name: `${ctx.tag} Loan`, fields: { balance, monthlyPayment: amount, dueDay: 15, interestRate: apr, [RATE_UNIT]: "percent" } });
    const snap0 = await snapshot(ctx);
    const month = ctx.today.slice(0, 7);
    const spend0 = snap0.totalMonthlySpend;

    // first payment of the month
    const want1 = O.splitPayment(balance, apr, amount);
    const p1 = must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount, paymentDate: ctx.today }), "pay");
    ctx.near("derived", p1.interestPortion, want1.interest, `first payment's interest (${balance} at ${apr}%)`);
    ctx.near("derived", p1.principalPortion, want1.principal, "first payment's principal");
    ctx.near("derived", p1.remainingBalanceAfter, want1.newBalance, "balance after the first payment");
    const row1 = await ctx.db.row("liability_payments", p1.id);
    ctx.check("db", !!row1 && Math.abs(Number(row1.amount) - amount) < 0.005 && Math.abs(Number(row1.principal_portion) - want1.principal) < 0.005,
      "the ledger row stores the amount and the principal", JSON.stringify(row1).slice(0, 300));
    const prof1 = await ctx.db.row("profiles", loan.id);
    ctx.near("db", prof1?.fields?.balance, want1.newBalance, "the loan's stored balance");

    // A4: only interest is spending
    const snap1 = await snapshot(ctx);
    ctx.near("derived", O.cents(snap1.totalMonthlySpend - spend0), want1.interest, "this month's spending rose by the interest only, not the whole payment");
    ctx.near("derived", O.cents(snap0.totalLiabilities - snap1.totalLiabilities), want1.principal, "total debt fell by the principal");
    const costExp = await ctx.db.rows("expenses", tagQ(`payment-cost:${p1.id}`));
    ctx.check("db", costExp.length === 1 && Math.abs(Number(costExp[0].amount) - want1.interest) < 0.005, "one expense row carries the interest, tagged to the payment", `${costExp.length} rows ${JSON.stringify(costExp[0]?.amount)}`);

    // second payment the same month: all principal
    // the same request again within seconds is a double submit: one payment
    const twin = await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount, paymentDate: ctx.today });
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`)) === 1, `the identical request sent again (answer ${twin.status}) adds no second payment`);
    ctx.near("db", (await ctx.db.row("profiles", loan.id))?.fields?.balance, want1.newBalance, "and does not move the balance twice");

    const amount2 = amount + 25;
    const want2 = O.splitPayment(want1.newBalance, apr, amount2, { interestAlreadyCharged: true });
    const p2 = must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: amount2, paymentDate: ctx.today }), "pay again");
    ctx.near("derived", p2.interestPortion, 0, "a second payment in the month carries no interest");
    ctx.near("derived", p2.remainingBalanceAfter, want2.newBalance, "balance after the second payment");
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`)) === 2, "two ledger rows: a second, different same-day payment is its own payment");

    // extra principal
    const want3 = O.splitPayment(want2.newBalance, apr, 50, { extraPrincipal: true });
    const p3 = must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 50, paymentDate: ctx.today, paymentType: "extra_principal" }), "extra principal");
    ctx.near("derived", p3.interestPortion, 0, "extra principal carries no interest");
    ctx.near("derived", p3.remainingBalanceAfter, want3.newBalance, "balance after 50 extra principal");

    // reverse all three, newest first → the opening balance, no expense left
    for (const p of [p3, p2, p1]) {
      const r = await ctx.api("DELETE", `/liability-payments/${p.id}`);
      if (!r.ok) ctx.check("action", false, `payment ${p.id} reversed`, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const prof2 = await ctx.db.row("profiles", loan.id);
    ctx.near("db", prof2?.fields?.balance, balance, "after reversing every payment the stored balance is the opening balance");
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`)) === 0, "no ledger rows remain");
    const left = await ctx.db.rows("expenses", tagQ(`payment-cost:${p1.id}`));
    ctx.check("db", left.length === 0, "the interest expense left with its payment", `${left.length} still live`);
    const snap2 = await snapshot(ctx);
    ctx.near("derived", snap2.totalMonthlySpend, spend0, "this month's spending is back where it started");
    ctx.near("derived", snap2.totalLiabilities, snap0.totalLiabilities, "total debt is back where it started");
    const pays = listOf(must(await ctx.api("GET", `/liabilities/${loan.id}/payments`), "payments"));
    ctx.check("action", pays.length === 0, "the payments list is empty again");

    // refused inputs leave nothing behind
    for (const bad of [{ amount: -5 }, { amount: "abc" }, { amount: 0 }, { amount: 50, paymentDate: "2026-02-31" }]) {
      const r = await ctx.api("POST", `/liabilities/${loan.id}/payments`, bad);
      ctx.check("action", r.status >= 400 && r.status < 500, `a payment of ${JSON.stringify(bad)} is refused`, `${r.status}`);
    }
    const prof3 = await ctx.db.row("profiles", loan.id);
    ctx.near("db", prof3?.fields?.balance, balance, "refused payments left the balance alone");
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`)) === 0, "and wrote no ledger row");
    void month;

    // deleting the debt takes its ledger and its calendar dates, and the debt total follows
    const last = must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 120, paymentDate: ctx.today }), "one more payment");
    const debtBefore = (await snapshot(ctx)).totalLiabilities;
    const owed = (await ctx.db.row("profiles", loan.id)).fields.balance;
    const del = await ctx.api("DELETE", `/profiles/${loan.id}`);
    ctx.check("action", del.ok, "the debt is deleted", `${del.status}`);
    const lRow = await ctx.db.row("profiles", loan.id);
    ctx.check("db", lRow === null || lRow.deleted_at != null, "its row is deleted or marked deleted");
    const orphan = await ctx.db.rows("liability_payments", `id=eq.${last.id}`);
    ctx.check("db", orphan.length === 0 || lRow !== null, "no payment row is left pointing at a debt that has no row", `${orphan.length} payment row(s), debt row ${lRow === null ? "absent" : "kept as deleted"}`);
    ctx.near("derived", O.cents(debtBefore - (await snapshot(ctx)).totalLiabilities), owed, "total debt fell by the deleted debt's balance");
    const dates = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 70)}`), "timeline")).filter((i: any) => i.sourceId === loan.id);
    ctx.check("derived", dates.length === 0, "its payment dates left the calendar", `${dates.length} left`);
  },
});

scenario({
  id: "money.payoff-schedule",
  title: "A loan's next due date and calendar dates come from its payment day",
  area: "Liabilities",
  covers: ["liability.create.api"],
  requires: ["action", "derived"],
  run: async (ctx) => {
    const balance = ctx.int(50, 300) * 100;
    const apr = ctx.pick([4.5, 6, 9.99]);
    const payment = ctx.int(3, 9) * 100;
    const loan = await mkProfile(ctx, { type: "liability", type_key: "personal_loan", name: `${ctx.tag} Payoff Loan`, fields: { balance, monthlyPayment: payment, dueDay: 10, interestRate: apr, [RATE_UNIT]: "percent" } });
    const sched = must(await ctx.api("GET", `/liabilities/${loan.id}/schedule`), "schedule");
    ctx.check("action", sched.family === "amortizing" && sched.amount === payment, "the schedule reads the loan as amortizing with its payment", JSON.stringify({ family: sched.family, amount: sched.amount }));
    // next due: the next 10th on or after today, never a past date (L4)
    const t = O.parseYmd(ctx.today);
    const thisMonth = O.fmtYmd({ y: t.y, m: t.m, d: 10 });
    const wantDue = thisMonth >= ctx.today ? thisMonth : O.addMonthsAnchored(thisMonth, 1);
    ctx.same("derived", sched.nextDue?.date, wantDue, "next due date (day 10, counted from today)");
    ctx.near("derived", sched.annualTotal, payment * 12, "a year of payments");
    // The payoff outlook itself is drawn in the browser from shared/liability-calc;
    // it is held to the oracle by tests/integrity-oracle-properties.test.ts.
    const tl = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 100)}`), "timeline")).filter((i: any) => i.sourceId === loan.id).map((i: any) => i.date).sort();
    const wantTl = O.occurrencesBetween(wantDue, "monthly", ctx.today, O.addDays(ctx.today, 100));
    ctx.same("derived", tl, wantTl, "the calendar's dates for the loan over the next 100 days");
    void apr; void balance;
  },
});

scenario({
  id: "money.bill-cycle",
  title: "A recurring bill: next date, pay, undo, skip — the series keeps its schedule",
  area: "Bills & Auto Pay",
  covers: ["bill.create.api", "bill.pay.api", "bill.unpay.api", "bill.skip.api", "bill.pause.api", "bill.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const amount = ctx.int(20, 180) + 0.5;
    // stored due date well in the past: every list must still name the NEXT date (A7)
    const stored = O.addMonthsAnchored(O.fmtYmd({ ...O.parseYmd(ctx.today), d: 31 > O.daysInMonth(O.parseYmd(ctx.today).y, O.parseYmd(ctx.today).m) ? O.daysInMonth(O.parseYmd(ctx.today).y, O.parseYmd(ctx.today).m) : 31 }), -5);
    const anchor = O.fmtYmd({ ...O.parseYmd(stored), d: Math.min(31, O.daysInMonth(O.parseYmd(stored).y, O.parseYmd(stored).m)) });
    const bill = await mkProfile(ctx, { type: "liability", type_key: "utility", name: `${ctx.tag} Water`, fields: { amount, frequency: "monthly", dueDate: anchor } });
    const wantNext = O.nextBillDate(anchor, "monthly", ctx.today);

    const obs = listOf(must(await ctx.api("GET", "/obligations"), "obligations"));
    const ob = obs.find((o: any) => o.id === bill.id);
    ctx.check("action", !!ob && ob.amount === amount && ob.frequency === "monthly", "the bill is in the obligations list with its amount", JSON.stringify(ob).slice(0, 200));
    const snap = await snapshot(ctx);
    const up = (snap.billsTimeline?.upcoming || []).filter((r: any) => r.billId === bill.id);
    ctx.check("derived", up.length >= 1 && up[0].date === wantNext, `the bills timeline names the next date ${wantNext}, not the stored ${anchor}`, JSON.stringify(up.map((u: any) => u.date)));
    const past = (snap.billsTimeline?.past || []).filter((r: any) => r.billId === bill.id);
    ctx.check("derived", past.every((r: any) => r.state !== "overdue" && r.state !== "late"), "no elapsed date of a recurring bill reads overdue", JSON.stringify(past.map((p: any) => p.state)));
    const tl = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 70)}`), "timeline")).filter((i: any) => i.sourceId === bill.id).map((i: any) => i.date).sort();
    const wantDates = O.occurrencesBetween(anchor, "monthly", ctx.today, O.addDays(ctx.today, 70));
    ctx.same("derived", tl, wantDates, "calendar dates for the bill over the next 70 days");

    // pay the shown occurrence
    const spend0 = snap.totalMonthlySpend;
    const pay = await ctx.api("POST", `/liabilities/${bill.id}/occurrences/${wantNext}/pay`, {});
    ctx.check("action", pay.ok, `paying ${wantNext} is accepted`, `${pay.status} ${JSON.stringify(pay.data).slice(0, 200)}`);
    const payRows = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${bill.id}`);
    ctx.check("db", payRows.length === 1 && Math.abs(Number(payRows[0].amount) - amount) < 0.005, "one payment row of the bill's amount", JSON.stringify(payRows.map((r: any) => r.amount)));
    const exp = payRows[0] ? await ctx.db.rows("expenses", tagQ(`payment:${payRows[0].id}`)) : [];
    ctx.check("db", exp.length === 1 && Math.abs(Number(exp[0].amount) - amount) < 0.005, "one expense row of the whole amount, tagged to the payment (a bill's payment is spending)", `${exp.length} rows`);
    // paying twice must not add a second payment
    const again = await ctx.api("POST", `/liabilities/${bill.id}/occurrences/${wantNext}/pay`, {});
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${bill.id}`)) === 1, `paying the same occurrence again (answer ${again.status}) adds no second payment`);
    const snapPaid = await snapshot(ctx);
    const next2 = O.nextBillDate(anchor, "monthly", ctx.today, [wantNext]);
    const openDates = async () => listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 70)}`), "timeline"))
      .filter((i: any) => i.sourceId === bill.id && !i.completed && !["paid", "skipped"].includes(String(i.meta?.status))).map((i: any) => i.date).sort();
    ctx.same("derived", (await openDates())[0], next2, "after paying, the first open date on the calendar");
    const stillUp = (snapPaid.billsTimeline?.upcoming || []).filter((r: any) => r.billId === bill.id && r.date === wantNext);
    ctx.check("derived", stillUp.length === 0, "the paid date is no longer listed as upcoming", JSON.stringify(stillUp));
    if (wantNext.startsWith(ctx.today.slice(0, 7)) && exp[0]?.date?.startsWith(ctx.today.slice(0, 7))) {
      ctx.near("derived", O.cents(snapPaid.totalMonthlySpend - spend0), amount, "this month's spending rose by the bill");
    }

    // undo
    const undo = await ctx.api("DELETE", `/obligations/${bill.id}/last-payment`);
    ctx.check("action", undo.ok, "undoing the payment is accepted", `${undo.status}`);
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${bill.id}`)) === 0, "the payment row is gone");
    const expLeft = payRows[0] ? await ctx.db.rows("expenses", tagQ(`payment:${payRows[0].id}`)) : [];
    ctx.check("db", expLeft.length === 0, "its expense is gone too", `${expLeft.length} live`);
    const snapUndone = await snapshot(ctx);
    ctx.near("derived", snapUndone.totalMonthlySpend, spend0, "spending is back where it started");

    // skip one occurrence: later dates stay (O1)
    const skipDate = O.nextBillDate(anchor, "monthly", ctx.today);
    const skip = await ctx.api("POST", `/liabilities/${bill.id}/occurrences/${skipDate}/skip`);
    ctx.check("action", skip.ok, `skipping ${skipDate} is accepted`, `${skip.status}`);
    const tl2 = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 70)}`), "timeline")).filter((i: any) => i.sourceId === bill.id && !i.completed && i.meta?.status !== "skipped").map((i: any) => i.date).sort();
    const wantAfterSkip = O.occurrencesBetween(anchor, "monthly", ctx.today, O.addDays(ctx.today, 70), [skipDate]);
    ctx.same("derived", tl2, wantAfterSkip, "open calendar dates after the skip (every later date stays)");
    const billRow = await ctx.db.row("profiles", bill.id);
    ctx.near("db", billRow?.fields?.amount, amount, "the skip did not change the bill's amount");
    ctx.same("db", billRow?.fields?.frequency, "monthly", "nor its frequency");

    // pause / resume
    const pause = await ctx.api("POST", `/liabilities/${bill.id}/pause`, {});
    const resume = await ctx.api("POST", `/liabilities/${bill.id}/resume`);
    ctx.check("action", pause.ok && resume.ok, "pause then resume are accepted", `${pause.status}/${resume.status}`);

    // delete: no orphans
    const del = await ctx.api("DELETE", `/profiles/${bill.id}`);
    ctx.check("action", del.ok, "the bill is deleted");
    const obs2 = listOf(must(await ctx.api("GET", "/obligations"), "obligations"));
    ctx.check("action", !obs2.some((o: any) => o.id === bill.id), "it left the obligations list");
    const tl3 = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 70)}`), "timeline")).filter((i: any) => i.sourceId === bill.id);
    ctx.check("derived", tl3.length === 0, "and the calendar", `${tl3.length} items still there`);
  },
});

scenario({
  id: "money.autopay",
  title: "Auto Pay records nothing before the due day, and one payment on it",
  area: "Bills & Auto Pay",
  covers: ["bill.autopay.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const runToday: string = must(await ctx.api("POST", "/autopay/run"), "autopay run").today;
    ctx.check("action", /^\d{4}-\d{2}-\d{2}$/.test(runToday || ""), "the Auto Pay run names its day", String(runToday));
    const future = await mkProfile(ctx, { type: "liability", type_key: "streaming", name: `${ctx.tag} Stream Later`, fields: { amount: 11.99, frequency: "monthly", dueDate: O.addDays(runToday, 9) } });
    const dueNow = await mkProfile(ctx, { type: "liability", type_key: "streaming", name: `${ctx.tag} Stream Today`, fields: { amount: 14.99, frequency: "monthly", dueDate: runToday } });
    const elapsed = await mkProfile(ctx, { type: "liability", type_key: "streaming", name: `${ctx.tag} Stream Before`, fields: { amount: 9.99, frequency: "monthly", dueDate: O.addDays(runToday, -3) } });
    for (const b of [future, dueNow, elapsed]) {
      const on = await ctx.api("POST", `/liabilities/${b.id}/autopay`, { enabled: true });
      if (!on.ok) ctx.check("action", false, `Auto Pay switched on for ${b.name}`, `${on.status} ${JSON.stringify(on.data).slice(0, 200)}`);
    }
    const stamped = await ctx.db.row("profiles", dueNow.id);
    ctx.check("db", stamped?.fields?.autopay === true && typeof stamped?.fields?.autoRecordSince === "string", "switching Auto Pay on stores the flag and the day it started", JSON.stringify({ a: stamped?.fields?.autopay, s: stamped?.fields?.autoRecordSince }));

    must(await ctx.api("POST", "/autopay/run"), "autopay run");
    const n = async (id: string) => ctx.db.count("liability_payments", `liability_profile_id=eq.${id}`);
    ctx.check("derived", (await n(future.id)) === 0, "a bill due in 9 days is not recorded early");
    ctx.check("derived", (await n(dueNow.id)) === 1, "a bill due today is recorded once");
    ctx.check("derived", (await n(elapsed.id)) === 0, "a due date before Auto Pay was switched on is not recorded");
    must(await ctx.api("POST", "/autopay/run"), "autopay run again");
    ctx.check("db", (await n(dueNow.id)) === 1, "a second run adds no second payment");
    const sched = must(await ctx.api("GET", `/liabilities/${dueNow.id}/schedule`), "schedule");
    const occ = (sched.occurrences || []).find((o: any) => o.date === runToday);
    ctx.check("derived", !!occ && /assumed/.test(String(occ.paymentStatus)), "the recorded payment reads as assumed, not confirmed (A2)", JSON.stringify(occ?.paymentStatus));
    // switching it off stops future recording only
    must(await ctx.api("POST", `/liabilities/${dueNow.id}/autopay`, { enabled: false }), "autopay off");
    ctx.check("db", (await n(dueNow.id)) === 1, "switching Auto Pay off keeps the recorded payment");
  },
});

scenario({
  id: "money.budget",
  title: "Budget progress equals the month's spending in its category",
  area: "Budgets & spending",
  covers: ["expense.create.api", "expense.edit.api", "expense.delete.api", "expense.restore.api", "budget.create.api", "budget.edit.api", "budget.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const month = ctx.today.slice(0, 7);
    const category = "entertainment";
    const read = async () => {
      const d = must(await ctx.api("GET", `/budgets?month=${month}`), "budgets");
      return listOf(d).find((b: any) => b.category === category);
    };
    const pre = await read();
    if (pre) throw new Error(`a ${category} budget already exists for ${month}: leftover from another run`);
    const snap0 = await snapshot(ctx);
    const cat0 = snap0.spendByCategory?.[category] ?? 0;
    const boot0 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;

    const limit = ctx.int(10, 40) * 10;
    const b = must(await ctx.api("POST", "/budgets", { month, category, amount: limit }), "create budget");
    const budId = b.id ?? b.budget?.id;
    ctx.cleanup(() => ctx.api("DELETE", `/budgets/${budId}?month=${month}`));

    const spends = [ctx.int(5, 60) + 0.37, ctx.int(5, 60) + 0.11, ctx.int(5, 60)];
    const ids: string[] = [];
    for (const [i, amount] of spends.entries()) {
      const e = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} show ${i}`, amount, category, date: ctx.today }), "expense");
      ids.push(e.id);
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
    }
    // one in another category and one in another month must not count
    const other = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} fuel`, amount: 33, category: "transport", date: ctx.today }), "expense");
    ctx.cleanup(() => ctx.api("DELETE", `/expenses/${other.id}`));
    const lastMonth = O.addMonthsAnchored(`${month}-15`, -1);
    const old = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} old show`, amount: 77, category, date: lastMonth }), "expense");
    ctx.cleanup(() => ctx.api("DELETE", `/expenses/${old.id}`));

    const wantSpent = O.cents(cat0 + spends.reduce((s, x) => s + x, 0));
    const row = await ctx.db.row("expenses", ids[0]);
    ctx.check("db", !!row && Math.abs(Number(row.amount) - spends[0]) < 0.005 && row.category === category && row.date === ctx.today, "the expense row stores amount, category and day", JSON.stringify(row).slice(0, 200));
    let bud = await read();
    ctx.near("action", bud?.amount, limit, "the budget is listed with its limit");
    // "spent" beside a budget is the month's spending in its category
    const spentNow = async () => (await snapshot(ctx)).spendByCategory?.[category] ?? 0;
    const snap1 = await snapshot(ctx);
    ctx.near("derived", snap1.spendByCategory?.[category] ?? 0, wantSpent, `this month's ${category} spending`);
    const boot1 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
    ctx.near("derived", O.cents(boot1.totalBudget - boot0.totalBudget), limit, "the budget total rose by the new limit");
    ctx.near("derived", O.cents(boot1.remaining), O.cents(boot1.totalBudget - boot1.totalSpent), "remaining = budget − spent");
    ctx.near("derived", O.cents(boot1.totalSpent - boot0.totalSpent), O.cents(spends.reduce((s, x) => s + x, 0) + 33), "the summary's spent rose by this month's expenses");
    ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), O.cents(spends.reduce((s, x) => s + x, 0) + 33), "this month's total rose by this month's four expenses (last month's is left out)");

    // edit one, delete one, restore it
    must(await ctx.api("PATCH", `/expenses/${ids[0]}`, { amount: spends[0] + 10 }), "edit expense");
    ctx.near("derived", await spentNow(), O.cents(wantSpent + 10), "after raising one expense by 10");
    const rowE = await ctx.db.row("expenses", ids[0]);
    ctx.check("db", rowE.category === category && rowE.description === `${ctx.tag} show 0` && rowE.date === ctx.today, "the edit kept description, category and date", JSON.stringify({ c: rowE.category, d: rowE.description }));
    must(await ctx.api("DELETE", `/expenses/${ids[1]}`), "delete expense");
    ctx.near("derived", await spentNow(), O.cents(wantSpent + 10 - spends[1]), "after deleting one expense");
    const delRow = await ctx.db.row("expenses", ids[1]);
    ctx.check("db", delRow === null || delRow.deleted_at != null, "the deleted expense's row is gone or marked deleted");
    const rest = await ctx.api("POST", `/expenses/${ids[1]}/restore`);
    ctx.check("action", rest.ok, "the expense is restored", `${rest.status}`);
    ctx.near("derived", await spentNow(), O.cents(wantSpent + 10), "after restoring it");
    ctx.check("db", (await ctx.db.count("expenses", `description=like.${ctx.tag}*&deleted_at=is.null`)) === 5, "five live expense rows: the restore did not duplicate");

    // budget edit
    must(await ctx.api("PATCH", `/budgets/${budId}?month=${month}`, { amount: limit + 25 }), "edit budget");
    bud = await read();
    ctx.near("action", bud?.amount, limit + 25, "the budget's limit after the edit");
    ctx.near("derived", await spentNow(), O.cents(wantSpent + 10), "the edit left the category's spending alone");
  },
});
