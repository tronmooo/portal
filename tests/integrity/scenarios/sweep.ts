// The API doors a test names but nothing had verified against the database:
// each operation here is followed by the stored row and whatever depends on it.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";
import { snapshot } from "./money";

const mkProfile = async (ctx: Ctx, body: any) => {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}?deleteHistory=1`));
  return p;
};
const gone = (row: any) => row === null || row.deleted_at != null;
const pref = async (ctx: Ctx, key: string) => (await ctx.db.rows("preferences", `key=eq.${encodeURIComponent(key)}`))[0]?.value ?? null;

scenario({
  id: "sweep.payment-edit-and-status",
  title: "Editing a recorded loan payment re-splits it; marking it missed reverses it and says so",
  area: "Liabilities",
  covers: ["liabilityPayment.edit.api", "liabilityPayment.cancel.api", "liabilityPayment.complete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const balance = ctx.int(40, 90) * 100, apr = ctx.pick([6, 9.5, 18]);
    const loan = await mkProfile(ctx, { type: "liability", type_key: "personal_loan", name: `${ctx.tag} Edit Loan`, fields: { balance, monthlyPayment: 300, dueDay: 12, interestRate: apr, _interestRateUnit: "percent" } });
    const p = must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 300, paymentDate: ctx.today, idempotencyKey: `${ctx.tag}-edit-1` }), "pay");
    const first = O.splitPayment(balance, apr, 300);
    ctx.near("derived", p.remainingBalanceAfter, first.newBalance, "balance after paying 300");

    // edit the amount: the split and the balance follow
    const edited = await ctx.api("PATCH", `/liability-payments/${p.id}`, { amount: 350 });
    ctx.check("action", edited.ok, "changing the payment to 350 is accepted", `${edited.status} ${JSON.stringify(edited.data).slice(0, 200)}`);
    const want = O.splitPayment(balance, apr, 350);
    const row = await ctx.db.row("liability_payments", edited.data?.id ?? p.id) ?? (await ctx.db.rows("liability_payments", `liability_profile_id=eq.${loan.id}`))[0];
    ctx.near("db", Number(row?.amount), 350, "the ledger row's amount");
    ctx.near("derived", Number(row?.interest_portion), want.interest, "its interest is still one month's interest");
    ctx.near("derived", Number(row?.principal_portion), want.principal, "its principal is the rest");
    ctx.near("db", (await ctx.db.row("profiles", loan.id)).fields.balance, want.newBalance, "the loan's stored balance follows the edit");
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`)) === 1, "still one ledger row (the edit is not a second payment)");
    const cost = await ctx.db.rows("expenses", `tags=cs.${encodeURIComponent(JSON.stringify([`liability:${loan.id}`]))}&deleted_at=is.null`);
    ctx.check("db", cost.length <= 1 && (want.interest === 0 || Math.abs(Number(cost[0]?.amount) - want.interest) < 0.005), "one interest expense, of the interest", JSON.stringify(cost.map((c: any) => c.amount)));

    const bad = await ctx.api("PATCH", `/liability-payments/${p.id}`, { amount: -5 });
    ctx.check("action", bad.status >= 400 && bad.status < 500, "a negative amount is refused", `${bad.status}`);
    ctx.near("db", (await ctx.db.row("profiles", loan.id)).fields.balance, want.newBalance, "and the balance stays");

    // mark it missed: the money comes back, the payment reads missed
    const liveId = (await ctx.db.rows("liability_payments", `liability_profile_id=eq.${loan.id}`))[0]?.id;
    const missed = await ctx.api("POST", `/liability-payments/${liveId}/status`, { status: "missed" });
    ctx.check("action", missed.ok, "marking the payment missed is accepted", `${missed.status} ${JSON.stringify(missed.data).slice(0, 200)}`);
    ctx.near("db", (await ctx.db.row("profiles", loan.id)).fields.balance, balance, "the balance is back to what it was before the payment");
    const left = await ctx.db.rows("expenses", `tags=cs.${encodeURIComponent(JSON.stringify([`liability:${loan.id}`]))}&deleted_at=is.null`);
    ctx.check("db", left.length === 0, "its interest expense is gone", `${left.length} live`);
    const sched = must(await ctx.api("GET", `/liabilities/${loan.id}/schedule`), "schedule");
    ctx.check("derived", (sched.occurrences || []).some((o: any) => o.paymentStatus === "missed"), "the schedule shows a missed payment", JSON.stringify((sched.occurrences || []).map((o: any) => o.paymentStatus)));
  },
});

scenario({
  id: "sweep.bill-edit-and-move",
  title: "A bill's amount, one occurrence's charge and one occurrence's date change that thing only",
  area: "Bills & Auto Pay",
  covers: ["bill.edit.api", "bill.reschedule.api", "bill.edit.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const first = O.addDays(ctx.today, 6);
    const bill = await mkProfile(ctx, { type: "liability", type_key: "utility", name: `${ctx.tag} Power`, fields: { amount: 60, frequency: "monthly", dueDate: first } });
    const second = O.addMonthsAnchored(first, 1), third = O.addMonthsAnchored(first, 2);
    const to = O.addDays(third, 5);
    const dates = async () => listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${to}`), "timeline")).filter((i: any) => i.sourceId === bill.id).map((i: any) => i.date).sort();
    ctx.same("derived", await dates(), [first, second, third], "three monthly dates");

    // the amount, through the obligations door
    const ed = await ctx.api("PATCH", `/obligations/${bill.id}`, { amount: 72.4 });
    ctx.check("action", ed.ok, "changing the amount to 72.40 is accepted", `${ed.status} ${JSON.stringify(ed.data).slice(0, 160)}`);
    const row = await ctx.db.row("profiles", bill.id);
    ctx.check("db", Number(row.fields.amount) === 72.4 && row.fields.frequency === "monthly" && String(row.fields.dueDate).slice(0, 10) === first, "the row holds the new amount and the same schedule", JSON.stringify({ a: row.fields.amount, f: row.fields.frequency, d: row.fields.dueDate }));
    const snap = await snapshot(ctx);
    const up = (snap.billsTimeline?.upcoming || []).find((r: any) => r.billId === bill.id);
    ctx.near("derived", up?.amount, 72.4, "the bills timeline quotes the new amount");

    // one occurrence's extra charge
    const ch = await ctx.api("POST", `/liabilities/${bill.id}/occurrences/${first}/charges`, { amount: 5.6, kind: "fee", label: "Late fee" });
    ctx.check("action", ch.ok, "a 5.60 fee on the first date is accepted", `${ch.status}`);
    const sched = must(await ctx.api("GET", `/liabilities/${bill.id}/schedule`), "schedule");
    const occ = (d: string) => (sched.occurrences || []).find((o: any) => o.date === d);
    ctx.near("derived", occ(first)?.amount, O.cents(72.4 + 5.6), "the first date's total is amount + fee");
    ctx.near("derived", occ(second)?.amount, 72.4, "the second date is untouched by the first date's fee");

    // move ONE date
    const movedTo = O.addDays(second, 3);
    const mv = await ctx.api("PATCH", `/liabilities/${bill.id}/occurrences/${second}`, { movedTo });
    ctx.check("action", mv.ok, `moving ${second} to ${movedTo} is accepted`, `${mv.status} ${JSON.stringify(mv.data).slice(0, 200)}`);
    const after = await dates();
    ctx.check("derived", after.includes(first) && after.includes(third) && after.includes(movedTo) && !after.includes(second), "the calendar shows the moved date, and the first and third where they were", JSON.stringify(after));
    const row2 = await ctx.db.row("profiles", bill.id);
    ctx.check("db", String(row2.fields.dueDate).slice(0, 10) === first && Number(row2.fields.amount) === 72.4, "moving one date did not change the bill's own date or amount", JSON.stringify({ d: row2.fields.dueDate, a: row2.fields.amount }));
    const junk = await ctx.api("PATCH", `/liabilities/${bill.id}/occurrences/${third}`, { movedTo: "2027-02-31" });
    ctx.check("action", junk.status >= 400 && junk.status < 500, "moving a date to Feb 31 is refused", `${junk.status}`);
  },
});

scenario({
  id: "sweep.ownership-links",
  title: "Removing one owner's link hands the whole thing back; the link rows say so",
  area: "Ownership",
  covers: ["asset.cancel.api", "liability.cancel.api", "asset.transfer.api", "liability.transfer.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const partner = await mkProfile(ctx, { type: "person", name: `${ctx.tag} Co-owner`, fields: {} });
    const art = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} Painting`, fields: { currentValue: 8000 } });
    const loan = await mkProfile(ctx, { type: "liability", type_key: "personal_loan", name: `${ctx.tag} Shared Loan`, fields: { balance: 3000, monthlyPayment: 100, dueDay: 4 } });
    const scoped = async () => must(await ctx.api("GET", `/dashboard-enhanced?profileIds=${partner.id}`), "scoped").financeSnapshot;
    must(await ctx.api("PUT", `/profiles/${art.id}/owners`, { owners: [{ partyProfileId: ctx.self.id, ownershipPercentage: 75 }, { partyProfileId: partner.id, ownershipPercentage: 25 }] }), "split asset");
    must(await ctx.api("PUT", `/profiles/${loan.id}/owners`, { owners: [{ partyProfileId: ctx.self.id, ownershipPercentage: 50 }, { partyProfileId: partner.id, ownershipPercentage: 50 }] }), "split loan");
    let s = await scoped();
    ctx.near("derived", s.totalAssetValue, 2000, "the co-owner holds 25% of the painting");
    ctx.near("derived", s.totalLiabilities, 1500, "and half the loan");

    const aLinks = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${art.id}`);
    const mine = aLinks.find((l: any) => l.party_profile_id === partner.id);
    const del = await ctx.api("DELETE", `/asset-party-links/${mine?.id}`);
    ctx.check("action", del.ok, "removing the co-owner's link to the painting is accepted", `${del.status} ${JSON.stringify(del.data).slice(0, 160)}`);
    const aAfter = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${art.id}`);
    ctx.check("db", !aAfter.some((l: any) => l.party_profile_id === partner.id), "no link row names the co-owner on the painting");
    const total = aAfter.reduce((n: number, l: any) => n + Number(l.ownership_percentage), 0);
    const okTotal = ctx.check("db", aAfter.length === 0 || Math.abs(total - 100) < 0.06, "what remains is 100% (or no explicit owner, which means 100% the account holder's)", `${aAfter.length} rows totalling ${total}`);
    if (!okTotal) ctx.finding({ severity: "discrepancy", title: "Removing one owner's link leaves the others short of 100%", detail: `asset_party_links for the asset total ${total}% after one owner was removed` });
    s = await scoped();
    ctx.near("derived", s.totalAssetValue, 0, "the co-owner no longer holds any of the painting");
    const all = await snapshot(ctx);
    ctx.check("derived", (all.assetBreakdown || []).some((r: any) => r.id === art.id && Math.abs(r.value - 8000) < 0.5), "the household still counts the whole painting");

    const lLinks = await ctx.db.rows("liability_profile_links", `liability_profile_id=eq.${loan.id}`);
    const lMine = lLinks.find((l: any) => l.party_profile_id === partner.id);
    const delL = await ctx.api("DELETE", `/liability-profile-links/${lMine?.id}`);
    ctx.check("action", delL.ok, "removing the co-owner's link to the loan is accepted", `${delL.status}`);
    s = await scoped();
    ctx.near("derived", s.totalLiabilities, 0, "the co-owner no longer owes any of the loan");
    ctx.check("db", !(await ctx.db.rows("liability_profile_links", `liability_profile_id=eq.${loan.id}`)).some((l: any) => l.party_profile_id === partner.id), "no link row names the co-owner on the loan");
  },
});

scenario({
  id: "sweep.income-and-budget-copy",
  title: "Income, paychecks and copying a month's budgets",
  area: "Budgets & spending",
  covers: ["income.create.api", "income.edit.api", "income.delete.api", "income.complete.api", "budget.duplicate.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const inc = must(await ctx.api("POST", "/incomes", { description: `${ctx.tag} consulting`, amount: 900, category: "freelance", frequency: "once", date: ctx.today, allowDuplicate: true }), "income");
    ctx.cleanup(() => ctx.api("DELETE", `/incomes/${inc.id}`));
    let row = await ctx.db.row("incomes", inc.id);
    ctx.check("db", Number(row?.amount) === 900 && row.date === ctx.today, "the income row stores amount and day", JSON.stringify(row).slice(0, 200));
    must(await ctx.api("PATCH", `/incomes/${inc.id}`, { amount: 950.5 }), "edit income");
    row = await ctx.db.row("incomes", inc.id);
    ctx.check("db", Number(row.amount) === 950.5 && row.description === `${ctx.tag} consulting` && row.category === "freelance" && row.date === ctx.today, "the edit changed the amount and nothing else", JSON.stringify({ a: row.amount, c: row.category, d: row.date }));
    ctx.check("derived", listOf(must(await ctx.api("GET", "/incomes"), "incomes")).find((i: any) => i.id === inc.id)?.amount === 950.5, "the income list shows the new amount");
    const bad = await ctx.api("PATCH", `/incomes/${inc.id}`, { amount: "lots" });
    ctx.check("action", bad.status >= 400 && bad.status < 500, "an amount of \"lots\" is refused", `${bad.status}`);
    must(await ctx.api("DELETE", `/incomes/${inc.id}`), "delete income");
    ctx.check("db", gone(await ctx.db.row("incomes", inc.id)), "the income row is deleted or marked deleted");
    ctx.check("action", !listOf(must(await ctx.api("GET", "/incomes"), "incomes")).some((i: any) => i.id === inc.id), "and it left the list");

    // paycheck: expected → confirmed at another amount → deleted
    const pc = must(await ctx.api("POST", "/paychecks", { source: `${ctx.tag} Employer`, amount: 1234.56, expected_date: ctx.today }), "paycheck");
    ctx.cleanup(() => ctx.api("DELETE", `/paychecks/${pc.id}`));
    const inList = async () => listOf(must(await ctx.api("GET", "/paychecks"), "paychecks")).find((x: any) => x.id === pc.id);
    const conf = await ctx.api("PATCH", `/paychecks/${pc.id}/confirm`, { actual_amount: 1200 });
    const after = await inList();
    ctx.check("action", conf.ok && after?.confirmed === true && Number(after?.actual_amount) === 1200, "the paycheck is confirmed at the amount received", JSON.stringify(after).slice(0, 200));
    const pcRow = await ctx.db.row("paychecks", pc.id);
    ctx.check("db", pcRow?.confirmed === true && Number(pcRow?.actual_amount) === 1200 && Number(pcRow?.amount) === 1234.56, "the paycheck row is confirmed at 1,200 and keeps the expected 1,234.56", JSON.stringify(pcRow).slice(0, 240));
    must(await ctx.api("DELETE", `/paychecks/${pc.id}`), "delete paycheck");
    ctx.check("db", (await ctx.db.row("paychecks", pc.id)) === null, "the deleted paycheck has no row");

    // copy budgets into a far month, where nothing is expected to exist
    const month = ctx.today.slice(0, 7), next = "2031-03";
    const category = "pets";
    const existing = listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets")).find((b: any) => b.category === category);
    if (existing) throw new Error("a pets budget already exists this month (left by another run)");
    const b = must(await ctx.api("POST", "/budgets", { month, category, amount: 135 }), "budget");
    const budId = b.id ?? b.budget?.id;
    // the category as the app stores it (budget keys are canonical: shared/budget-ledger)
    const stored = String(listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets")).find((x: any) => x.id === budId)?.category ?? "");
    ctx.check("action", stored.length > 0, "the new budget is listed for this month", JSON.stringify(b).slice(0, 160));
    ctx.cleanup(() => ctx.api("DELETE", `/budgets/${budId}?month=${month}`));
    const copy = await ctx.api("POST", "/budgets/copy", { fromMonth: month, toMonth: next });
    ctx.check("action", copy.ok, "copying this month's budgets is accepted", `${copy.status} ${JSON.stringify(copy.data).slice(0, 160)}`);
    const copied = listOf(must(await ctx.api("GET", `/budgets?month=${next}`), "budgets"));
    for (const c of copied) ctx.cleanup(() => ctx.api("DELETE", `/budgets/${c.id}?month=${next}`));
    const mineCopy = copied.find((c: any) => c.category === stored);
    ctx.check("derived", !!mineCopy && Number(mineCopy.amount) === 135, "the copied month has the same limit for the category");
    ctx.check("db", String(await pref(ctx, `budget:${next}`)).includes(stored), "the copy is stored under its own month");
    must(await ctx.api("PATCH", `/budgets/${mineCopy?.id}?month=${next}`, { amount: 10 }), "edit the copy");
    ctx.near("db", listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets")).find((x: any) => x.id === budId)?.amount, 135, "changing the copy leaves the original month's limit");
    const again = await ctx.api("POST", "/budgets/copy", { fromMonth: month, toMonth: next });
    const twice = listOf(must(await ctx.api("GET", `/budgets?month=${next}`), "budgets")).filter((c: any) => c.category === stored);
    ctx.check("db", twice.length === 1 && Number(twice[0].amount) === 10, `copying again (answer ${again.status}) neither duplicates the category nor overwrites the edited limit`, JSON.stringify(twice.map((t: any) => t.amount)));
  },
});

scenario({
  id: "sweep.series-pause-and-renames",
  title: "Pausing a series, renaming a habit and a tracker: stored, and nothing else moves",
  area: "Calendar",
  covers: ["event.archive.api", "habit.edit.api", "tracker.edit.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const start = O.addDays(ctx.today, 2);
    const ev = must(await ctx.api("POST", "/events", { title: `${ctx.tag} standup`, date: start, time: "09:00", recurrence: "weekly" }), "event");
    ctx.cleanup(() => ctx.api("DELETE", `/events/${ev.id}`));
    const to = O.addDays(start, 30);
    const n = async () => listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${to}`), "timeline")).filter((i: any) => i.sourceId === ev.id).length;
    const before = await n();
    ctx.same("derived", before, O.occurrencesBetween(start, "weekly", ctx.today, to).length, "weekly dates in the next month");
    const pause = await ctx.api("POST", `/events/${ev.id}/series-flag`, { flag: "paused", on: true });
    ctx.check("action", pause.ok, "pausing the series is accepted", `${pause.status}`);
    let row = await ctx.db.row("events", ev.id);
    ctx.check("db", row.date === start && row.recurrence === "weekly" && JSON.stringify(row.tags).includes("pause"), "the row keeps its start and rule and carries the pause", JSON.stringify(row.tags));
    const paused = await n();
    ctx.check("derived", paused < before, `a paused series shows fewer upcoming dates (${before} → ${paused})`);
    must(await ctx.api("POST", `/events/${ev.id}/series-flag`, { flag: "paused", on: false }), "resume");
    ctx.same("derived", await n(), before, "resumed, every date is back");
    row = await ctx.db.row("events", ev.id);
    ctx.check("db", !JSON.stringify(row.tags).includes("pause"), "and the pause mark is gone from the row", JSON.stringify(row.tags));
    const badFlag = await ctx.api("POST", `/events/${ev.id}/series-flag`, { flag: "exploded", on: true });
    ctx.check("action", badFlag.status === 400, "an unknown flag is refused", `${badFlag.status}`);

    const habit = must(await ctx.api("POST", "/habits", { name: `${ctx.tag} read`, frequency: "daily" }), "habit");
    ctx.cleanup(() => ctx.api("DELETE", `/habits/${habit.id}`));
    must(await ctx.api("POST", `/habits/${habit.id}/checkin`, {}), "checkin");
    must(await ctx.api("PATCH", `/habits/${habit.id}`, { name: `${ctx.tag} read 20 pages` }), "rename habit");
    const hRow = await ctx.db.row("habits", habit.id);
    ctx.check("db", hRow.name === `${ctx.tag} read 20 pages` && hRow.frequency === "daily", "the habit row has the new name and the same frequency", JSON.stringify({ n: hRow.name, f: hRow.frequency }));
    ctx.check("db", (await ctx.db.count("habit_checkins", `habit_id=eq.${habit.id}`)) === 1, "its check-in survived the rename");
    ctx.same("derived", listOf(must(await ctx.api("GET", "/habits"), "habits")).find((h: any) => h.id === habit.id)?.currentStreak, 1, "and so did its streak");

    const tr = must(await ctx.api("POST", "/trackers", { name: `${ctx.tag} Pushups`, category: "fitness", fields: [{ name: "reps", type: "number", isPrimary: true }] }), "tracker");
    ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tr.id}`));
    must(await ctx.api("POST", `/trackers/${tr.id}/entries`, { values: { reps: 20 } }), "log");
    must(await ctx.api("PATCH", `/trackers/${tr.id}`, { name: `${ctx.tag} Push-ups (strict)` }), "rename tracker");
    const tRow = await ctx.db.row("trackers", tr.id);
    ctx.check("db", tRow.name === `${ctx.tag} Push-ups (strict)` && tRow.category === "fitness" && JSON.stringify(tRow.fields).includes("reps"), "the tracker row has the new name, the same category and fields", JSON.stringify({ n: tRow.name, c: tRow.category }));
    ctx.check("db", (await ctx.db.count("tracker_entries", `tracker_id=eq.${tr.id}`)) === 1, "its entry survived the rename");
    ctx.check("db", (await ctx.db.count("trackers", `name=like.${ctx.tag}*Push*`)) === 1, "the rename made no second tracker");
  },
});

scenario({
  id: "sweep.memory-preferences-links",
  title: "Memories, a preference row and links between records: stored, changed and removed exactly",
  area: "Records",
  covers: ["memory.create.api", "memory.edit.api", "memory.delete.api", "dashboard.edit.api", "profile.transfer.api", "profile.cancel.api", "profile.edit.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const mem = must(await ctx.api("POST", "/memories", { key: `${ctx.tag} wifi name`, value: "Lighthouse-5G" }), "memory");
    ctx.cleanup(() => ctx.api("DELETE", `/memories/${mem.id}`));
    let row = await ctx.db.row("memories", mem.id);
    ctx.check("db", JSON.stringify(row).includes("Lighthouse-5G"), "the memory row holds the value", JSON.stringify(row).slice(0, 200));
    must(await ctx.api("PATCH", `/memories/${mem.id}`, { value: "Lighthouse-6G" }), "edit memory");
    row = await ctx.db.row("memories", mem.id);
    ctx.check("db", JSON.stringify(row).includes("Lighthouse-6G") && JSON.stringify(row).includes(`${ctx.tag} wifi name`), "the edit changed the value and kept the key");
    must(await ctx.api("DELETE", `/memories/${mem.id}`), "delete memory");
    ctx.check("db", gone(await ctx.db.row("memories", mem.id)), "the memory row is gone");

    // a preference
    const key = `integrity_probe_${ctx.tag.toLowerCase()}`;
    must(await ctx.api("PUT", `/preferences/${key}`, { value: "on" }), "set preference");
    ctx.cleanup(() => ctx.api("PUT", `/preferences/${key}`, { value: "" }));
    ctx.same("db", await pref(ctx, key), "on", "the preference row");
    must(await ctx.api("PUT", `/preferences/${key}`, { value: "off" }), "change preference");
    ctx.same("db", await pref(ctx, key), "off", "the preference row after the change");
    ctx.check("db", (await ctx.db.count("preferences", `key=eq.${key}`)) === 1, "one row for the key, not one per write");
    for (const [reserved, why] of [["detail_definitions", "the characteristics catalog"], ["ai_memory:journal", "an assistant's memory"], [`versions:note:${ctx.self.id}`, "a version history"], [`details:profile:${ctx.self.id}`, "a record's characteristics"]] as const) {
      const before = await pref(ctx, reserved);
      const r = await ctx.api("PUT", `/preferences/${encodeURIComponent(reserved)}`, { value: "[]" });
      ctx.check("action", r.status >= 400 && r.status < 500, `${why} cannot be written through the generic preferences door`, `${r.status}`);
      ctx.same("db", await pref(ctx, reserved), before, `…and ${why} is unchanged`);
    }

    // links between records
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} service the bike` }), "task");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    const bike = must(await ctx.api("POST", "/profiles", { type: "asset", name: `${ctx.tag} Bike`, fields: { currentValue: 400 } }), "asset");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${bike.id}`));
    const link = must(await ctx.api("POST", "/entity-links", { sourceType: "task", sourceId: task.id, targetType: "profile", targetId: bike.id, relationship: "related_to" }), "link");
    const linkId = link.id ?? link.link?.id;
    const lRow = await ctx.db.row("entity_links", linkId);
    ctx.check("db", lRow?.source_id === task.id && lRow?.target_id === bike.id, "the link row joins the task and the asset", JSON.stringify(lRow).slice(0, 200));
    const twin = await ctx.api("POST", "/entity-links", { sourceType: "task", sourceId: task.id, targetType: "profile", targetId: bike.id, relationship: "related_to" });
    ctx.check("db", (await ctx.db.count("entity_links", `source_id=eq.${task.id}&target_id=eq.${bike.id}`)) === 1, `linking the same pair again (answer ${twin.status}) makes no second link`);
    const ghost = await ctx.api("POST", "/entity-links", { sourceType: "task", sourceId: task.id, targetType: "profile", targetId: "00000000-0000-4000-8000-000000000000", relationship: "related_to" });
    ctx.check("action", ghost.status >= 400 && ghost.status < 500, "linking to a record that does not exist is refused", `${ghost.status}`);
    must(await ctx.api("DELETE", `/entity-links/${linkId}`), "unlink");
    ctx.check("db", (await ctx.db.row("entity_links", linkId)) === null, "the link row is gone");
    ctx.check("db", !gone(await ctx.db.row("tasks", task.id)) && !gone(await ctx.db.row("profiles", bike.id)), "and both records it joined are untouched");

    // a person: rename only
    const person = must(await ctx.api("POST", "/profiles", { type: "person", name: `${ctx.tag} Friend`, fields: { relationship: "friend", phone: "555-0100" } }), "person");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${person.id}`));
    must(await ctx.api("PATCH", `/profiles/${person.id}`, { name: `${ctx.tag} Friend II` }), "rename");
    const pRow = await ctx.db.row("profiles", person.id);
    ctx.check("db", pRow.name === `${ctx.tag} Friend II` && pRow.fields.phone === "555-0100" && pRow.fields.relationship === "friend" && pRow.type === "person", "a rename kept the type and every field", JSON.stringify(pRow.fields));
  },
});

scenario({
  id: "sweep.statement-import",
  title: "A statement import: previewed without writing, committed once, undone whole",
  area: "Bank data",
  covers: ["bankLedger.create.api", "bankLedger.cancel.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const payload = { transactions: [
      { unique_id: `${ctx.tag}-t1`, date: ctx.today, amount: 12.34, merchant: `${ctx.tag} Bakery`, category: "food", type: "expense" },
      { unique_id: `${ctx.tag}-t2`, date: ctx.today, amount: 56.78, merchant: `${ctx.tag} Hardware`, category: "home", type: "expense" },
    ] };
    const live = () => ctx.db.rows("expenses", `or=(description.ilike.*${ctx.tag}*,vendor.ilike.*${ctx.tag}*)&deleted_at=is.null`);
    const snap0 = await snapshot(ctx);
    const prev = await ctx.api("POST", "/finance-import/preview", { json: payload });
    ctx.check("action", prev.ok && prev.data?.recordCount === 2, "the preview reads two records", JSON.stringify(prev.data).slice(0, 160));
    ctx.check("db", (await live()).length === 0, "a preview stores nothing");
    const commit = must(await ctx.api("POST", "/finance-import/commit", { json: payload }), "commit");
    let undone = false;
    ctx.cleanup(async () => { if (!undone) await ctx.api("POST", `/finance-import/${commit.batchId}/undo`); });
    const rows = await live();
    ctx.check("db", rows.length === 2 && O.cents(rows.reduce((s: number, r: any) => s + Number(r.amount), 0)) === 69.12, "two expense rows totalling 69.12", JSON.stringify(rows.map((r: any) => r.amount)));
    const snap1 = await snapshot(ctx);
    ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), 69.12, "this month's spending rose by the import");
    const twice = await ctx.api("POST", "/finance-import/commit", { json: payload });
    if (twice.data?.batchId && twice.data.batchId !== commit.batchId) ctx.cleanup(() => ctx.api("POST", `/finance-import/${twice.data.batchId}/undo`));
    ctx.check("db", (await live()).length === 2, `importing the same file again (answer ${twice.status}) adds nothing`);
    const undo = await ctx.api("POST", `/finance-import/${commit.batchId}/undo`);
    undone = undo.ok;
    ctx.check("action", undo.ok, "undo is accepted", `${undo.status}`);
    ctx.check("db", (await live()).length === 0, "both rows are gone");
    ctx.near("derived", (await snapshot(ctx)).totalMonthlySpend, snap0.totalMonthlySpend, "this month's spending is back where it started");
  },
});
