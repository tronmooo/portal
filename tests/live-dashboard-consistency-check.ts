// Live check (production, smoke account) of the dashboard rules of 2026-11-22:
//   - a bill is upcoming financial information, never an overdue backlog or a
//     task, and the Dashboard, Finance and the bell agree on its date (A7);
//   - a dismissed alert stays dismissed across a NEW sign-in, hides both of
//     its shapes, and returns only on Restore ("Done means gone");
//   - a plain Pay on a rolled row settles the date shown, once;
//   - nothing else creates an expense, and no existing task is removed.
//   npx tsx tests/live-dashboard-consistency-check.ts
// Takes the gate lock; deletes what it creates and restores what it dismisses.
import { api, getSmokeToken } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { alertIdOfDateRow } from "../shared/alert-ids";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const iso = (d: Date) => d.toLocaleDateString("en-CA");
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const list = (r: any, what: string): any[] => { if (!Array.isArray(r?.data)) throw new Error(`${what}: expected a list, got ${r?.status}`); return r.data; };

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-dashboard-consistency-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  let billId: string | undefined;
  let docId: string | undefined;
  let dismissedId: string | undefined;
  let paidExpenseIds: string[] = [];
  try {
    console.log(`production is serving ${String((await (await fetch(`${UI_BASE}/api/version`)).json()).sha).slice(0, 7)}`);
    const expenseIdsBefore = new Set(list(await api("GET", "/expenses"), "expenses").map((e) => e.id));
    const tasksBefore = list(await api("GET", "/tasks"), "tasks");

    // ── a bill whose stored date is four months back ─────────────────────
    const billName = `Streaming ${tag}`;
    const bill = await api("POST", "/obligations", { name: billName, amount: 11, frequency: "monthly", category: "subscriptions", nextDueDate: plusDays(-115), autopay: false });
    if (!bill.ok) throw new Error(`could not create the bill: ${bill.status} ${JSON.stringify(bill.data)}`);
    billId = bill.data.id;

    const enh = await api("GET", "/dashboard-enhanced");
    if (!enh.ok) throw new Error(`dashboard-enhanced: ${enh.status}`);
    const snap = enh.data?.financeSnapshot;
    const upcoming = (Array.isArray(snap?.upcomingBills) ? snap.upcomingBills : null) as any[] | null;
    check(upcoming !== null, "the dashboard snapshot carries upcomingBills");
    const mine = (upcoming || []).find((b) => b.id === billId);
    check(!!mine, "Dashboard: the bill is listed (it stays visible as upcoming information)");
    check(!!mine && typeof mine.daysUntil === "number" && mine.daysUntil >= 0 && mine.daysUntil <= 31, `Dashboard: at its NEXT date, not 115 days overdue (daysUntil ${mine?.daysUntil})`);
    check((upcoming || []).every((b) => b.daysUntil >= 0), "Dashboard: no bill in the list is overdue");
    const tl = (Array.isArray(snap?.billsTimeline?.upcoming) ? snap.billsTimeline.upcoming : null) as any[] | null;
    const tlMine = (tl || []).find((r) => r.billId === billId);
    check(!!tlMine && !!mine && String(tlMine.date).slice(0, 10) === String(mine.dueDate).slice(0, 10), `Finance: Bills & Payments shows the same next date (${tlMine?.date})`);

    const notes = list(await api("GET", "/notifications"), "notifications");
    const billNotes = notes.filter((n) => n.entityType === "obligation" && n.entityId === billId);
    check(billNotes.every((n) => !/overdue/i.test(String(n.title))), `Notifications: no "Overdue bill" for it (${billNotes.map((n) => n.title).join(" | ") || "none"})`);

    const tasksAfterBill = list(await api("GET", "/tasks"), "tasks");
    check(!tasksAfterBill.some((t) => String(t.title).includes(billName)), "Tasks: creating the bill made no task");

    // ── "Pay" on the row settles the date it shows, once ─────────────────
    const shownDate = String(mine?.dueDate || "").slice(0, 10);
    const paid = await api("POST", `/obligations/${billId}/pay`, {});
    check(paid.ok, "a plain Pay on the listed bill is accepted");
    const afterPay = ((await api("GET", "/dashboard-enhanced")).data?.financeSnapshot?.upcomingBills || []) as any[];
    const mineAfter = afterPay.find((b) => b.id === billId);
    check(!mineAfter || String(mineAfter.dueDate).slice(0, 10) > shownDate, `the row moves on from ${shownDate} (now ${mineAfter ? String(mineAfter.dueDate).slice(0, 10) : "outside the 30-day window"}) — done means gone`);
    const expensesAfterPay = list(await api("GET", "/expenses"), "expenses");
    paidExpenseIds = expensesAfterPay.filter((e) => !expenseIdsBefore.has(e.id)).map((e) => e.id);
    check(paidExpenseIds.length === 1, `one payment, one expense (${paidExpenseIds.length} new)`);
    const again = await api("POST", `/obligations/${billId}/pay`, {});
    const expensesAfterSecond = list(await api("GET", "/expenses"), "expenses").filter((e) => !expenseIdsBefore.has(e.id));
    check(again.ok && expensesAfterSecond.length === 1, "an immediate second tap records nothing more");
    paidExpenseIds = expensesAfterSecond.map((e) => e.id);

    // ── a document that expired, dismissed from one shape ────────────────
    const doc = await api("POST", "/documents", { name: `Warranty ${tag}`, type: "warranty", mimeType: "text/plain", fileData: "", extractedData: { expirationDate: plusDays(-20) } });
    if (!doc.ok) throw new Error(`could not create the document: ${doc.status} ${JSON.stringify(doc.data)}`);
    docId = doc.data.id;

    const rows = ((await api("GET", "/dashboard-enhanced")).data?.expiringDocuments || []) as any[];
    const row = rows.find((d) => d.documentId === docId);
    check(!!row, "Dashboard: the expired document is in the attention list");
    const id = row ? alertIdOfDateRow(row) : "";
    const bell = list(await api("GET", "/notifications"), "notifications").find((n) => n.entityType === "document" && n.entityId === docId);
    check(!!bell && bell.id === id, `the document row and the bell alert share one id (${id})`);

    const dis = await api("POST", "/notifications/dismiss", { ids: [id] });
    check(dis.ok && Array.isArray(dis.data?.ids) && dis.data.ids.includes(id), "dismiss is stored on the account");
    dismissedId = id;
    check(!list(await api("GET", "/notifications"), "notifications").some((n) => n.id === id), "Notifications: the alert is gone");
    const listed = await api("GET", "/notifications/dismissed");
    check(listed.ok && Array.isArray(listed.data?.alerts) && listed.data.alerts.some((a: any) => a.id === id), "the Dismissed list names it");

    // A NEW sign-in: nothing carried over but the account.
    const fresh = await getSmokeToken(true);
    const pref = await api("GET", "/preferences/dismissed_notifications", undefined, { token: fresh });
    const stored = (() => { try { return JSON.parse(String(pref.data?.value)); } catch { return null; } })();
    check(Array.isArray(stored) && stored.includes(id), "after signing in again: still dismissed");
    check(!list(await api("GET", "/notifications", undefined, { token: fresh }), "notifications").some((n) => n.id === id), "after signing in again: the bell still does not raise it");
    const stillThere = ((await api("GET", "/dashboard-enhanced", undefined, { token: fresh })).data?.expiringDocuments || []) as any[];
    check(stillThere.some((d) => d.documentId === docId), "the document's own date is untouched (dismissing changed no record)");

    const res = await api("POST", "/notifications/restore", { ids: [id] });
    check(res.ok && Array.isArray(res.data?.ids) && !res.data.ids.includes(id), "Restore removes it from the dismissed list");
    dismissedId = undefined;
    check(list(await api("GET", "/notifications"), "notifications").some((n) => n.id === id), "…and the alert shows again");

    // ── nothing was spent, nothing was removed ───────────────────────────
    const newExpenses = list(await api("GET", "/expenses"), "expenses").filter((e) => !expenseIdsBefore.has(e.id));
    check(newExpenses.length === 1, `nothing but the one payment created an expense (${newExpenses.length} new in the whole run)`);
    const tasksNow = list(await api("GET", "/tasks"), "tasks");
    check(tasksBefore.every((t) => tasksNow.some((n) => n.id === t.id)), "every task that existed before is still there");
  } finally {
    if (dismissedId) await api("POST", "/notifications/restore", { ids: [dismissedId] }).catch(() => undefined);
    for (const id of paidExpenseIds) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    if (docId) await api("DELETE", `/documents/${docId}`).catch(() => undefined);
    if (billId) await api("DELETE", `/obligations/${billId}`).catch(() => undefined);
    await release();
  }
  if (failed) { console.error("\nFAILED"); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
