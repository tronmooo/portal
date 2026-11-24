// Live check (production, smoke account) for the bill workflows no test drove
// before the workflow matrix (docs/WORKFLOW_MATRIX.md, 2026-11-24):
//
//   one date  add a charge → the date's amount includes it → remove it
//             pay it → a payment and an expense exist → undo the last payment → both gone
//             skip the next date → the series moves on, later dates stay (O1)
//   series    pause → resume
//   links     link a task to the bill → listed → unlink
//
// Every write is read back from what a screen reads; a bad input is a 4xx
// with a reason. Takes the gate lock and removes what it creates.
//   npx tsx tests/live-bills-workflows-check.ts
import { api } from "./smoke/fixture/api";
import { NO_SUCH_ID, detail, list, refused, runWorkflowCheck } from "./helpers/live-workflow";

const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.005;

runWorkflowCheck("live-bills-workflows-check", async ({ tag, check, call, cleanup, section }) => {
  // The server's "today" for this account.
  const today: string = (await call("POST", "/autopay/run")).data?.today;
  check(/^\d{4}-\d{2}-\d{2}$/.test(String(today)), `the server says today is ${today}`);

  const made = await call("POST", "/profiles", { type: "liability", type_key: "phone_plan", name: `${tag} Phone Plan`, fields: { amount: 85, frequency: "monthly", dueDate: today } });
  check(made.ok && !!made.data?.id, `create a monthly bill due today (${detail(made)})`);
  const bill: string = made.data?.id;
  if (!bill) return;
  cleanup(() => api("DELETE", `/profiles/${bill}`));

  const schedule = async () => (await call("GET", `/liabilities/${bill}/schedule?months=4`)).data;
  const occ = (s: any, date: string) => (s?.occurrences || []).find((o: any) => o.date === date);
  const payments = async () => list((await call("GET", `/liabilities/${bill}/payments`)).data);
  const expenses = async () => list((await call("GET", "/expenses")).data).filter((e) => Array.isArray(e.tags) && e.tags.includes(`liability:${bill}`));

  const s0 = await schedule();
  const dates: string[] = (s0?.occurrences || []).map((o: any) => o.date);
  check(dates[0] === today && dates.length >= 3, `its schedule starts today and runs on (${dates.slice(0, 4).join(", ")})`);
  check(near(occ(s0, today)?.amount, 85), `today's amount is 85 (got ${occ(s0, today)?.amount})`);

  // ── A charge on one date ────────────────────────────────────────────────
  section("a charge on one date");
  const charge = await call("POST", `/liabilities/${bill}/occurrences/${today}/charges`, { amount: 12.5, kind: "fee", label: "Late fee" });
  const withCharge = occ(charge.data, today);
  const chargeId = withCharge?.charges?.[0]?.id;
  check(charge.ok && withCharge?.charges?.length === 1 && near(withCharge?.chargeTotal, 12.5), `add a 12.50 fee to today (${charge.status}; charges ${JSON.stringify(withCharge?.charges)?.slice(0, 120)})`);
  check(near(occ(await schedule(), today)?.amount, 97.5), `today's amount is now 97.50 (got ${occ(await schedule(), today)?.amount})`);
  check(near(occ(await schedule(), dates[1])?.amount, 85), "next month's amount is still 85");
  check(refused(await call("POST", `/liabilities/${bill}/occurrences/${today}/charges`, { amount: 0 })), "a zero charge is refused");
  check(refused(await call("POST", `/liabilities/${bill}/occurrences/not-a-date/charges`, { amount: 5 })), "a charge on a junk date is refused");
  const unc = await call("DELETE", `/liabilities/${bill}/occurrences/${today}/charges/${chargeId}`);
  check(unc.ok && near(occ(await schedule(), today)?.amount, 85), `remove the fee → today is 85 again (${unc.status})`);

  // ── Pay one date, then undo ─────────────────────────────────────────────
  section("pay, then undo");
  const pay = await call("POST", `/liabilities/${bill}/occurrences/${today}/pay`, {});
  check(pay.ok && occ(pay.data, today)?.status === "paid", `pay today → the schedule says paid (${pay.status}, status ${occ(pay.data, today)?.status})`);
  const paid = await payments();
  check(paid.length === 1 && near(paid[0]?.amount, 85), `one payment of 85 is on the bill (got ${paid.map((p) => p.amount).join(", ") || "none"})`);
  const exp = await expenses();
  check(exp.length === 1 && near(exp[0]?.amount, 85), `one expense of 85 is in Finance (got ${exp.map((e) => e.amount).join(", ") || "none"})`);
  const again = await call("POST", `/liabilities/${bill}/occurrences/${today}/pay`, {});
  check((await payments()).length === 1 && (await expenses()).length === 1, `paying the same date again adds nothing (${again.status})`);
  check(refused(await call("POST", `/liabilities/${bill}/occurrences/${today}/pay`, { amount: -5 })), "a negative payment is refused");

  const undo = await call("DELETE", `/obligations/${bill}/last-payment`);
  check(undo.ok, `undo the last payment (${detail(undo)})`);
  check((await payments()).length === 0, "the payment is gone from the bill");
  check((await expenses()).length === 0, "its expense is gone from Finance");
  check(occ(await schedule(), today)?.status !== "paid", `today is no longer paid (now ${occ(await schedule(), today)?.status})`);
  check((await call("DELETE", `/obligations/${bill}/last-payment`)).status === 404, "with nothing left to undo, undo is a 404");

  // ── Skip one date ───────────────────────────────────────────────────────
  section("skip one date");
  const skipDate = dates[1];
  const skip = await call("POST", `/liabilities/${bill}/occurrences/${skipDate}/skip`);
  const sSkip = await schedule();
  check(skip.ok && occ(sSkip, skipDate)?.status === "skipped", `skip ${skipDate} → it reads skipped (${skip.status}, status ${occ(sSkip, skipDate)?.status})`);
  check(!!occ(sSkip, dates[2]) && occ(sSkip, dates[2])?.status !== "skipped", `${dates[2]} is still on the schedule`);
  check((await payments()).length === 0 && (await expenses()).length === 0, "a skip recorded no payment and no expense");

  // ── Pause and resume ────────────────────────────────────────────────────
  section("pause and resume");
  const pause = await call("POST", `/liabilities/${bill}/pause`, {});
  const pausedFields = (await call("GET", `/profiles/${bill}`)).data?.fields;
  check(pause.ok && pausedFields?.paused === true, `pause → the bill is paused (${pause.status})`);
  check(near(pausedFields?.amount, 85), "pausing left its amount alone");
  check(refused(await call("POST", `/liabilities/${bill}/pause`, { until: "soon" })), "pausing until \"soon\" is refused");
  const resume = await call("POST", `/liabilities/${bill}/resume`);
  check(resume.ok && (await call("GET", `/profiles/${bill}`)).data?.fields?.paused === false, `resume → it is active again (${resume.status})`);
  check((await call("POST", `/liabilities/${NO_SUCH_ID}/pause`, {})).status === 404, "pausing a bill that does not exist is a 404");

  // ── A linked record ─────────────────────────────────────────────────────
  section("link a task to the bill");
  const task = await call("POST", "/tasks", { title: `${tag} call the phone company` });
  const taskId = task.data?.id;
  check(task.ok && !!taskId, `create a task (${task.status})`);
  if (taskId) {
    cleanup(() => api("DELETE", `/tasks/${taskId}`));
    const link = await call("POST", "/entity-links", { sourceType: "task", sourceId: taskId, targetType: "profile", targetId: bill, relationship: "related_to" });
    const linkId = link.data?.id;
    check(link.ok && !!linkId, `link the task to the bill (${detail(link)})`);
    const links = async () => list((await call("GET", `/entity-links/profile/${bill}`)).data);
    check((await links()).some((l) => l.id === linkId), "the link is listed on the bill");
    const foreign = await call("POST", "/entity-links", { sourceType: "task", sourceId: taskId, targetType: "profile", targetId: NO_SUCH_ID, relationship: "related_to" });
    check(foreign.status === 404, `a link to a record that is not yours is refused (${foreign.status})`);
    if (linkId) {
      const unlink = await call("DELETE", `/entity-links/${linkId}`);
      check(unlink.ok && !(await links()).some((l) => l.id === linkId), `unlink → gone from the bill (${unlink.status})`);
    }
  }

  // ── Deleting the bill ───────────────────────────────────────────────────
  section("delete");
  const del = await call("DELETE", `/profiles/${bill}`);
  check(del.ok && (await call("GET", `/profiles/${bill}`)).status === 404, `delete the bill → it is gone (${del.status})`);
  check((await call("GET", `/liabilities/${bill}/schedule`)).status === 404, "its schedule is a 404, not an empty schedule");
});
