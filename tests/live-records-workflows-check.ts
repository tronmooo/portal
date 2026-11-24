// Live check (production, smoke account) for record workflows no test drove
// before the workflow matrix (docs/WORKFLOW_MATRIX.md, 2026-11-24):
//
//   artifact  create a checklist → rename → tick an item → duplicate →
//             share → the public link opens → stop sharing → the link is dead → delete
//   goal      create → edit → delete → restore → delete
//   habit     create → check in today → again is not a second completion →
//             uncheck → delete → restore → delete
//   memory    save → listed → recalled → edit → delete → 404s
//   account   create → listed → balance adjust → delete → 404s
//
// Every write is read back from the list a screen reads; every bad input must
// be a 4xx with a reason. Takes the gate lock and removes what it creates.
//   npx tsx tests/live-records-workflows-check.ts
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { NO_SUCH_ID, detail, list, refused, runWorkflowCheck } from "./helpers/live-workflow";

runWorkflowCheck("live-records-workflows-check", async ({ tag, check, call, cleanup, section }) => {
  const today = new Date().toISOString().slice(0, 10);

  // ── Artifact + sharing ──────────────────────────────────────────────────
  section("artifact");
  const art = await call("POST", "/artifacts", { type: "checklist", title: `${tag} packing list`, items: [{ text: "Passport" }, { text: "Charger" }] });
  check(art.status === 201 && !!art.data?.id, `create a checklist (${detail(art)})`);
  const artId = art.data?.id;
  if (artId) {
    cleanup(() => api("DELETE", `/artifacts/${artId}`));
    const inList = (id = artId) => call("GET", "/artifacts").then((r) => list(r.data).find((a) => a.id === id));
    const row = await inList();
    check(row?.items?.length === 2 && row.items.every((i: any) => i.checked === false), "it is in the artifacts list with two unticked items");
    const renamed = await call("PATCH", `/artifacts/${artId}`, { title: `${tag} packing list v2` });
    const afterRename = await inList();
    check(renamed.ok && afterRename?.title === `${tag} packing list v2`, `rename → the list shows the new title (${renamed.status})`);
    check(afterRename?.items?.length === 2, "a rename left the items alone (a PATCH carries only what was sent)");
    check(refused(await call("PATCH", `/artifacts/${artId}`, { title: "   " })), "a blank title is refused");

    const itemId = afterRename?.items?.[0]?.id;
    const toggled = await call("POST", `/artifacts/${artId}/toggle/${itemId}`);
    const afterToggle = await inList();
    check(toggled.ok && afterToggle?.items?.find((i: any) => i.id === itemId)?.checked === true, `tick the first item → the list shows it ticked (${toggled.status})`);
    check(afterToggle?.items?.filter((i: any) => i.checked).length === 1, "… and only that one");
    check((await call("POST", `/artifacts/${artId}/toggle/no-such-item`)).status === 404, "ticking an item that does not exist is a 404");

    const dup = await call("POST", `/artifacts/${artId}/duplicate`);
    const dupId = dup.data?.id;
    check(dup.ok && !!dupId && dupId !== artId, `duplicate (${detail(dup)})`);
    if (dupId) {
      cleanup(() => api("DELETE", `/artifacts/${dupId}`));
      const copy = await inList(dupId);
      check(copy?.title === `${tag} packing list v2 (copy)` && copy?.items?.length === 2, `the copy is in the list as "${copy?.title}" with both items`);
      check(!copy?.shareToken, "the copy is not shared");
      const delDup = await call("DELETE", `/artifacts/${dupId}`);
      check(delDup.ok && !(await inList(dupId)) && !!(await inList()), "delete the copy → gone, the original stays");
    }

    const share = await call("POST", `/artifacts/${artId}/share`);
    const token = share.data?.token;
    check(share.ok && /^[0-9a-f]{64}$/.test(String(token)), `share → a 64-hex token (${share.status})`);
    if (token) {
      const again = await call("POST", `/artifacts/${artId}/share`);
      check(again.data?.token === token, "sharing again answers the same link");
      // The public viewer needs no sign-in.
      const pub = await fetch(`${UI_BASE}/api/public/artifacts/${token}`);
      const pubBody: any = await pub.json().catch(() => null);
      check(pub.status === 200 && pubBody?.title === `${tag} packing list v2`, `the public link opens the artifact without signing in (${pub.status})`);
      check(pubBody && !("userId" in pubBody) && !("user_id" in pubBody), "the public copy carries no account id");
      const unshare = await call("DELETE", `/artifacts/${artId}/share`);
      const dead = await fetch(`${UI_BASE}/api/public/artifacts/${token}`);
      check(unshare.ok && dead.status === 404, `stop sharing → the link is dead (${dead.status})`);
      check(!(await inList())?.shareToken, "… and the list no longer marks it shared");
    }
    const del = await call("DELETE", `/artifacts/${artId}`);
    check(del.ok && !(await inList()), "delete → gone from the list");
    check((await call("DELETE", `/artifacts/${artId}`)).status === 404, "deleting it a second time is a 404");
  }
  check(refused(await call("POST", "/artifacts", { type: "no-such-type", title: `${tag} bad` })), "an artifact of an unknown type is refused");
  check((await call("POST", `/artifacts/${NO_SUCH_ID}/share`)).status === 404, "sharing an artifact that does not exist is a 404");

  // ── Goal ────────────────────────────────────────────────────────────────
  section("goal");
  const goal = await call("POST", "/goals", { title: `${tag} save for a bike`, type: "savings", target: 800, unit: "USD" });
  check(goal.ok && !!goal.data?.id, `create a goal (${detail(goal)})`);
  const goalId = goal.data?.id;
  if (goalId) {
    cleanup(() => api("DELETE", `/goals/${goalId}`));
    const inList = () => call("GET", "/goals").then((r) => list(r.data).find((g) => g.id === goalId));
    check(Number((await inList())?.target) === 800, "it is in the goals list with target 800");
    const patched = await call("PATCH", `/goals/${goalId}`, { target: 950 });
    const after = await inList();
    check(patched.ok && Number(after?.target) === 950 && after?.title === `${tag} save for a bike`, `edit the target → 950, title kept (${patched.status})`);
    const del = await call("DELETE", `/goals/${goalId}`);
    check(del.ok && !(await inList()), "delete → gone from the list");
    const restored = await call("POST", `/goals/${goalId}/restore`);
    check(restored.ok && Number((await inList())?.target) === 950, `restore → back in the list at 950 (${detail(restored)})`);
    check((await call("DELETE", `/goals/${goalId}`)).ok && !(await inList()), "delete again → gone");
  }
  check(refused(await call("POST", "/goals", { title: `${tag} bad`, type: "savings", target: "lots", unit: "USD" })), "a goal with target \"lots\" is refused");
  check((await call("POST", `/goals/${NO_SUCH_ID}/restore`)).status === 404, "restoring a goal that does not exist is a 404");

  // ── Habit ───────────────────────────────────────────────────────────────
  section("habit");
  const habit = await call("POST", "/habits", { name: `${tag} stretch`, frequency: "daily" });
  check(habit.ok && !!habit.data?.id, `create a habit (${detail(habit)})`);
  const habitId = habit.data?.id;
  if (habitId) {
    cleanup(() => api("DELETE", `/habits/${habitId}`));
    const inList = () => call("GET", "/habits").then((r) => list(r.data).find((h) => h.id === habitId));
    const doneToday = (h: any) => (h?.checkins || []).filter((c: any) => String(c.date).slice(0, 10) === serverDay);
    let serverDay = today;
    check(!!(await inList()), "it is in the habits list");
    const ci = await call("POST", `/habits/${habitId}/checkin`, {});
    serverDay = ci.data?.completion?.date || today;
    check(ci.status === 201 && Number(ci.data?.completion?.recorded) === 1, `check in today → one completion recorded (${ci.status} ${JSON.stringify(ci.data?.completion)})`);
    check(doneToday(await inList()).length === 1, "the list shows one check-in today");
    const ci2 = await call("POST", `/habits/${habitId}/checkin`, {});
    check(ci2.data?.completion?.alreadyComplete === true && doneToday(await inList()).length === 1, `checking in again is not a second completion (${JSON.stringify(ci2.data?.completion)})`);
    const future = await call("POST", `/habits/${habitId}/checkin`, { date: "2099-01-01" });
    check(refused(future), `a check-in for a day that has not happened is refused (${future.status})`);
    const checkinId = doneToday(await inList())[0]?.id;
    const un = await call("DELETE", `/habits/${habitId}/checkin/${checkinId}`);
    check(un.ok && doneToday(await inList()).length === 0, `uncheck → today is open again (${un.status})`);
    const del = await call("DELETE", `/habits/${habitId}`);
    check(del.ok && !(await inList()), "delete → gone from the list");
    const restored = await call("PATCH", `/habits/${habitId}/restore`);
    check(restored.ok && (await inList())?.name === `${tag} stretch`, `restore → back in the list (${restored.status})`);
    check((await call("DELETE", `/habits/${habitId}`)).ok && !(await inList()), "delete again → gone");
    // The check-in made a tracker to mirror the habit. It is the habit's, so
    // it leaves with it (2026-11-24: it stayed on the Trackers page).
    const mirrorId = ci.data?.completion?.tracker?.id;
    if (mirrorId) {
      cleanup(() => api("DELETE", `/trackers/${mirrorId}`));
      const trackers = list((await call("GET", "/trackers")).data);
      check(!trackers.some((t) => t.id === mirrorId), "the deleted habit's own tracker is gone from the Trackers list");
    }
  }
  check(refused(await call("POST", "/habits", { name: "" })), "a habit with no name is refused");
  check((await call("PATCH", `/habits/${NO_SUCH_ID}/restore`)).status === 404, "restoring a habit that does not exist is a 404");
  check((await call("POST", `/habits/${NO_SUCH_ID}/checkin`, {})).status === 404, "checking in a habit that does not exist is a 404");

  // ── Memory ──────────────────────────────────────────────────────────────
  section("memory");
  const mem = await call("POST", "/memories", { key: `${tag} wifi name`, value: "Lighthouse-5G" });
  check(mem.status === 201 && !!mem.data?.id, `save a memory (${detail(mem)})`);
  const memId = mem.data?.id;
  if (memId) {
    cleanup(() => api("DELETE", `/memories/${memId}`));
    const inList = () => call("GET", "/memories").then((r) => list(r.data).find((m) => m.id === memId));
    check((await inList())?.value === "Lighthouse-5G", "it is in the memories list");
    const recall = await call("GET", `/memories/recall?q=${encodeURIComponent(`${tag} wifi`)}`);
    check(recall.ok && list(recall.data).some((m) => m.id === memId), `recall "${tag} wifi" finds it (${recall.status})`);
    const patched = await call("PATCH", `/memories/${memId}`, { value: "Lighthouse-6G" });
    const after = await inList();
    check(patched.ok && after?.value === "Lighthouse-6G" && after?.key === `${tag} wifi name`, `edit the value → the list shows it, key kept (${patched.status})`);
    check(refused(await call("PATCH", `/memories/${memId}`, { key: "  " })), "a blank key is refused");
    const del = await call("DELETE", `/memories/${memId}`);
    check(del.ok && !(await inList()), "delete → gone from the list");
    check((await call("DELETE", `/memories/${memId}`)).status === 404, "deleting it a second time is a 404");
    check((await call("PATCH", `/memories/${memId}`, { value: "x" })).status === 404, "editing a memory that is gone is a 404");
  }
  check(refused(await call("POST", "/memories", { key: `${tag} empty`, value: "" })), "a memory with no value is refused");

  // ── Account ─────────────────────────────────────────────────────────────
  section("account");
  const acct = await call("POST", "/accounts", { name: `${tag} Checking`, accountKind: "checking", balance: 1000 });
  check(acct.ok && !!acct.data?.id, `create an account (${detail(acct)})`);
  const acctId = acct.data?.id;
  if (acctId) {
    cleanup(() => api("DELETE", `/accounts/${acctId}`));
    const inList = () => call("GET", "/accounts").then((r) => list(r.data).find((a) => a.id === acctId));
    const bal = (a: any) => Number(a?.balance ?? a?.fields?.balance);
    check(bal(await inList()) === 1000, "it is in the accounts list at 1000");
    const patched = await call("PATCH", `/accounts/${acctId}`, { balance: 1250.5 });
    const after = await inList();
    check(patched.ok && bal(after) === 1250.5 && after?.name === `${tag} Checking`, `edit the balance → 1250.50, name kept (${detail(patched)})`);
    check(refused(await call("PATCH", `/accounts/${acctId}`, { balance: "lots" })), "a balance of \"lots\" is refused");
    const del = await call("DELETE", `/accounts/${acctId}`);
    check(del.ok && !(await inList()), "delete → gone from the list");
    check((await call("DELETE", `/accounts/${acctId}`)).status === 404, "deleting it a second time is a 404");
  }
  check(refused(await call("POST", "/accounts", { name: { x: 1 }, balance: 5 })), "an account whose name is not text is refused");
  check(refused(await call("POST", "/accounts", { name: `${tag} bad`, balance: "lots" })), "an account with balance \"lots\" is refused");
});
