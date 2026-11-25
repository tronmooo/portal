// Live check (production, smoke account): unusual values in the forms the
// first input check did not reach — tracker readings, goals, events with an
// end, a loan's terms, an asset's price, income.
//
// The rule is the first check's: a value the app can hold comes back EXACTLY
// as entered from the list a screen reads; one it cannot hold is refused with
// a reason (a 4xx with `error`) — never a 500, never stored as something else.
// Owner, 2026-11-24: "different combinations … manually to add".
//   npx tsx tests/live-input-variations-2-check.ts
import { api } from "./smoke/fixture/api";
import { detail, list, refused, runWorkflowCheck } from "./helpers/live-workflow";

runWorkflowCheck("live-input-variations-2-check", async ({ tag, check, call, cleanup, section }) => {
  const today: string = (await call("POST", "/autopay/run")).data?.today;
  const year = Number(today.slice(0, 4));
  const inList = async (path: string, id: string) => list((await call("GET", path)).data).find((r) => r.id === id);
  /** Not a crash, and not stored: the answer to a value the app cannot hold. */
  const notA500 = (r: any) => r.status < 500;

  // ── Tracker readings ────────────────────────────────────────────────────
  section("tracker readings");
  const tr = await call("POST", "/trackers", { name: `${tag} Readings`, category: "health", fields: [{ name: "value", type: "number", isPrimary: true }] });
  const trId = tr.data?.id;
  if (trId) cleanup(() => api("DELETE", `/trackers/${trId}`));
  check(tr.ok && !!trId, `a tracker is created (${detail(tr)})`);
  if (trId) {
    const entryCase = async (value: unknown, want: number | "refused", why: string) => {
      const r = await call("POST", `/trackers/${trId}/entries`, { values: { value } });
      if (want === "refused") return check(refused(r), `a reading of ${JSON.stringify(value)} (${why}) is refused with a reason (${detail(r)})`);
      const row = list((await call("GET", "/trackers")).data).find((t) => t.id === trId);
      const stored = (row?.entries || []).find((e: any) => e.id === r.data?.id)?.values?.value;
      if (typeof value === "string") return check(r.ok ? Number(stored) === want : refused(r), `a reading of ${JSON.stringify(value)} (${why}) is stored as ${want} or refused, never as another figure (${r.ok ? JSON.stringify(stored) : detail(r)})`);
      check(r.ok && Number(stored) === want, `a reading of ${JSON.stringify(value)} (${why}) is stored as ${want} (${r.ok ? JSON.stringify(stored) : detail(r)})`);
    };
    await entryCase(0, 0, "zero is a real reading");
    await entryCase(0.1, 0.1, "a small decimal");
    await entryCase(98.6, 98.6, "one decimal");
    await entryCase(99999, 99999, "a large count");
    await entryCase(1234567, "refused", "past the largest reading a tracker holds");
    await entryCase("72", 72, "typed as text");
    await entryCase("abc", "refused", "not a number in a number field");
    await entryCase(null, "refused", "empty");
    const future = await call("POST", `/trackers/${trId}/entries`, { values: { value: 5 }, timestamp: `${year + 5}-01-01T12:00:00.000Z` });
    check(notA500(future), `a reading dated five years from now does not crash (${detail(future)})`);
    const old = await call("POST", `/trackers/${trId}/entries`, { values: { value: 6 }, timestamp: `${year - 3}-06-15T12:00:00.000Z` });
    check(old.ok, `a reading from three years ago is kept (${detail(old)})`);
    const unknown = await call("POST", `/trackers/${trId}/entries`, { values: { nonsense: 5 } });
    check(notA500(unknown), `a reading for a field the tracker does not have does not crash (${detail(unknown)})`);
  }

  // ── Goals ───────────────────────────────────────────────────────────────
  section("goals");
  const goalCase = async (target: unknown, ok: boolean, why: string) => {
    const r = await call("POST", "/goals", { title: `${tag} goal ${String(target)}`, type: "savings", target, unit: "USD" });
    if (r.data?.id) cleanup(() => api("DELETE", `/goals/${r.data.id}`));
    if (!ok) return check(refused(r), `a goal with target ${JSON.stringify(target)} (${why}) is refused with a reason (${detail(r)})`);
    const stored = r.data?.id ? Number((await inList("/goals", r.data.id))?.target) : NaN;
    check(r.ok && stored === target, `a goal with target ${JSON.stringify(target)} (${why}) is kept (${r.ok ? stored : detail(r)})`);
  };
  await goalCase(1, true, "the smallest");
  await goalCase(2500.5, true, "with cents");
  await goalCase(0, false, "zero");
  await goalCase(-100, false, "negative");
  await goalCase(null, false, "missing");
  const noTitle = await call("POST", "/goals", { title: "   ", type: "savings", target: 10, unit: "USD" });
  if (noTitle.data?.id) cleanup(() => api("DELETE", `/goals/${noTitle.data.id}`));
  check(refused(noTitle), `a goal whose title is only spaces is refused (${detail(noTitle)})`);
  const pastGoal = await call("POST", "/goals", { title: `${tag} goal past deadline`, type: "savings", target: 50, unit: "USD", deadline: `${year}-02-30` });
  if (pastGoal.data?.id) cleanup(() => api("DELETE", `/goals/${pastGoal.data.id}`));
  check(refused(pastGoal), `a goal with a deadline of Feb 30 is refused (${detail(pastGoal)})`);

  // ── Events with an end ──────────────────────────────────────────────────
  section("events with an end");
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = tomorrow.toISOString().slice(0, 10);
  const span = await call("POST", "/events", { title: `${tag} trip`, date: today, endDate: next });
  if (span.data?.id) cleanup(() => api("DELETE", `/events/${span.data.id}`));
  check(span.ok && String(span.data?.endDate).slice(0, 10) === next, `an event that ends tomorrow keeps its end date (${detail(span)})`);
  const backwards = await call("POST", "/events", { title: `${tag} backwards`, date: next, endDate: today });
  if (backwards.data?.id) cleanup(() => api("DELETE", `/events/${backwards.data.id}`));
  check(refused(backwards), `an event that ends before it starts is refused (${backwards.ok ? `stored ${String(backwards.data?.date).slice(0, 10)} → ${String(backwards.data?.endDate).slice(0, 10)}` : detail(backwards)})`);
  const endsEarly = await call("POST", "/events", { title: `${tag} ends early`, date: today, time: "15:00", endTime: "14:00" });
  if (endsEarly.data?.id) cleanup(() => api("DELETE", `/events/${endsEarly.data.id}`));
  check(refused(endsEarly), `an event from 15:00 to 14:00 on one day is refused (${endsEarly.ok ? `stored ${endsEarly.data?.time} → ${endsEarly.data?.endTime}` : detail(endsEarly)})`);
  const oddRepeat = await call("POST", "/events", { title: `${tag} odd repeat`, date: today, recurrence: "sometimes" });
  if (oddRepeat.data?.id) cleanup(() => api("DELETE", `/events/${oddRepeat.data.id}`));
  check(refused(oddRepeat), `an event that repeats "sometimes" is refused (${oddRepeat.ok ? `stored recurrence ${oddRepeat.data?.recurrence}` : detail(oddRepeat)})`);

  // ── A loan's terms ──────────────────────────────────────────────────────
  section("a loan's terms");
  const loan = await call("POST", "/profiles", { type: "liability", type_key: "personal_loan", name: `${tag} Loan`, fields: { balance: 5000, interestRate: 0.9, _interestRateUnit: "percent", monthlyPayment: 150, dueDay: 31 } }); // what the form sends (L3)
  const loanId = loan.data?.id;
  if (loanId) cleanup(() => api("DELETE", `/profiles/${loanId}`));
  check(loan.ok && !!loanId, `a loan at 0.9% due on the 31st is created (${detail(loan)})`);
  if (loanId) {
    const read = async () => (await inList("/profiles", loanId))?.fields || {};
    let f = await read();
    check(Number(f.interestRate) === 0.9, `a rate of 0.9 stays 0.9 percent, not 90 (${f.interestRate}, unit ${f._interestRateUnit})`);
    check(Number(f.dueDay) === 31, `due day 31 is kept (${f.dueDay})`);
    const fieldCase = async (fields: Record<string, unknown>, ok: boolean, why: string, same?: (f: any) => boolean) => {
      const before = await read();
      const r = await call("PATCH", `/profiles/${loanId}`, { fields });
      const after = await read();
      const key = Object.keys(fields)[0];
      if (ok) return check(r.ok && (same ? same(after) : after[key] === fields[key]), `${why}: kept (${r.ok ? JSON.stringify(after[key]) : detail(r)})`);
      check(refused(r) && JSON.stringify(after[key]) === JSON.stringify(before[key]), `${why}: refused with a reason and the stored value untouched (${r.ok ? `stored ${JSON.stringify(after[key])}` : detail(r)})`);
    };
    await fieldCase({ balance: 0 }, true, "a balance of 0 (paid off)");
    await fieldCase({ balance: 4321.09 }, true, "a balance with cents");
    await fieldCase({ balance: -50 }, true, "a negative balance (a credit: the lender owes you)");
    await fieldCase({ balance: 4321.09 }, true, "the balance put back");
    await fieldCase({ balance: "lots" }, false, "a balance of \"lots\"");
    await fieldCase({ interestRate: 0 }, true, "a 0% rate");
    await fieldCase({ interestRate: 29.99 }, true, "a 29.99% rate");
    await fieldCase({ interestRate: -3 }, false, "a negative rate");
    await fieldCase({ interestRate: 5000 }, false, "a 5000% rate");
    await fieldCase({ dueDay: 0 }, false, "due day 0");
    await fieldCase({ dueDay: 32 }, false, "due day 32");
    await fieldCase({ dueDay: 1 }, true, "due day 1");
    await fieldCase({ monthlyPayment: -20 }, false, "a negative payment");
    f = await read();
    check(Number(f.balance) === 4321.09 && Number(f.interestRate) === 29.99 && Number(f.dueDay) === 1, `after the refused edits the loan still reads 4321.09 / 29.99% / day 1 (${f.balance} / ${f.interestRate} / ${f.dueDay})`);
  }

  // ── An asset ────────────────────────────────────────────────────────────
  section("an asset");
  const asset = await call("POST", "/profiles", { type: "asset", name: `${tag} Bike`, fields: { purchasePrice: 800, purchaseDate: today } });
  const assetId = asset.data?.id;
  if (assetId) cleanup(() => api("DELETE", `/profiles/${assetId}`));
  check(asset.ok && !!assetId, `an asset is created (${detail(asset)})`);
  if (assetId) {
    const read = async () => (await inList("/profiles", assetId))?.fields || {};
    const neg = await call("PATCH", `/profiles/${assetId}`, { fields: { purchasePrice: -800 } });
    check(refused(neg) && Number((await read()).purchasePrice) === 800, `a negative purchase price is refused and 800 stays (${neg.ok ? `stored ${(await read()).purchasePrice}` : detail(neg)})`);
    const badDate = await call("PATCH", `/profiles/${assetId}`, { fields: { purchaseDate: `${year}-02-30` } });
    check(refused(badDate) && String((await read()).purchaseDate).slice(0, 10) === today, `a purchase date of Feb 30 is refused and the date stays (${badDate.ok ? `stored ${(await read()).purchaseDate}` : detail(badDate)})`);
    const half = await call("PATCH", `/profiles/${assetId}`, { fields: { purchaseDate: "0002-11-25" } });
    check(refused(half) && String((await read()).purchaseDate).slice(0, 10) === today, `a half-typed purchase year (0002) is refused and the date stays (${half.ok ? `stored ${(await read()).purchaseDate}` : detail(half)})`);
    const longName = `${tag} ${"Very long asset name ".repeat(20)}`.trim();
    const renamed = await call("PATCH", `/profiles/${assetId}`, { name: longName });
    const nameNow = (await inList("/profiles", assetId))?.name;
    check(renamed.ok ? nameNow === longName : refused(renamed), `a ${longName.length}-character name is kept whole or refused, never cut short silently (${renamed.ok ? `${String(nameNow).length} characters stored` : detail(renamed)})`);
    const spaces = await call("PATCH", `/profiles/${assetId}`, { name: "   " });
    check(refused(spaces), `a name of only spaces is refused (${detail(spaces)})`);
  }

  // ── Income ──────────────────────────────────────────────────────────────
  section("income");
  const incomeCase = async (amount: unknown, ok: boolean, why: string) => {
    const r = await call("POST", "/incomes", { description: `${tag} income ${String(amount)}`, source: `${tag} income`, amount, date: today });
    if (r.data?.id) cleanup(() => api("DELETE", `/incomes/${r.data.id}`));
    if (!ok) return check(refused(r), `income of ${JSON.stringify(amount)} (${why}) is refused with a reason (${detail(r)})`);
    const stored = r.data?.id ? Number((await inList("/incomes", r.data.id))?.amount) : NaN;
    check(r.ok && stored === amount, `income of ${JSON.stringify(amount)} (${why}) is kept (${r.ok ? stored : detail(r)})`);
  };
  await incomeCase(0.01, true, "one cent");
  await incomeCase(125000, true, "large");
  await incomeCase(0, false, "zero");
  await incomeCase("abc", false, "not a number");
  await incomeCase(10.555, false, "three decimals");
  const badDay = await call("POST", "/incomes", { description: `${tag} income bad day`, source: `${tag} income`, amount: 10, date: `${year}-02-30` });
  if (badDay.data?.id) cleanup(() => api("DELETE", `/incomes/${badDay.data.id}`));
  check(refused(badDay), `income dated Feb 30 is refused (${badDay.ok ? `stored ${badDay.data?.date}` : detail(badDay)})`);
});
