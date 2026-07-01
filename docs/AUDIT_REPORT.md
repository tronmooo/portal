# Full-App Audit Report

End-to-end audit of every data action (buttons + AI), validation, persistence,
isolation, and performance, run against the **live deployment** as the real test
account with DB read-back. Re-runnable via `tests/audit/*`.

## Headline

The app is **functionally solid**: 15/15 core entities pass the full
create→update→validate→delete journey, the AI chat has **full parity** (13/13
capabilities creating the correct DB row from natural language), validation is
robust (invalid input → 400 with a clear message, never 500), duplicate-person
is blocked, and warm performance is excellent (< 800ms). Two issues were found;
both are addressed below.

## Bugs found & fixed

### 1. 🐞 No upper bound on money amounts (FIXED)
- **Symptom:** `POST /api/expenses` with `amount: 1e15` ($1,000,000,000,000,000)
  was accepted (201). The UI caps inputs at ~$1B but the server did not, so the
  API and AI paths could write absurd/overflow values that corrupt aggregates.
- **Root cause:** `insertExpenseSchema/insertIncomeSchema/insertObligationSchema`
  used `z.number().positive()` / `.nonnegative()` with **no `.max()`**.
- **Fix:** added `MAX_MONEY = $1e12` ceiling to all three schemas
  (`shared/schema.ts`) → absurd amounts now 400 "Amount is unrealistically
  large". Guarded by a unit test in `tests/schema.test.ts`.
- **Retest:** unit test passes; live re-probe after deploy returns 400.

### 2. ⚠️ Serverless cold-start ~12s (mitigation recommended)
- **Symptom:** the **first** API request after the function goes idle took
  12.3–12.8s (both a direct write and the first AI call). Every subsequent
  request was fast (< 800ms). This is the real cause of the occasional "it feels
  slow / took forever" experience — not per-request slowness.
- **Root cause:** Vercel serverless **cold boot** — the Lambda spins down after
  idle; the first hit pays module init + the first Supabase connection. There is
  **no keep-warm cron** in `vercel.json` (`crons` is absent).
- **Status:** warm performance already meets targets, so this is an infra
  characteristic, not a code defect. Recommended mitigation (needs a Vercel plan
  that allows sub-daily crons): add a `crons` entry pinging a lightweight
  endpoint every ~5 min to keep the function warm. Not applied automatically
  because the effective cadence depends on the account's Vercel plan and I
  should not change deploy/infra behavior blindly.

## Non-bugs (verified, left as-is)
- **Budget update "didn't persist"** — a **harness false-negative**: `PATCH
  /api/budgets/:id` returns `{success:true}` (not the row) and there's no
  `GET /budgets/:id`. Direct read-back via `GET /budgets?month=` confirms the
  new amount **does** persist (500 ✅).
- **Delete of a missing id → 200** — DELETE is idempotent; acceptable.
- **Duplicate expense allowed** — correct per the agreed policy (duplicates OK
  for everything except person profiles).

## Data integrity & isolation
- Every created row was read back with its saved fields intact; updates and
  deletes verified.
- Profile isolation re-confirmed: entities link only to the intended profile;
  the canonical `passesProfileFilter`/`isInScope` rules are unit-tested, and the
  earlier live SQL proof showed 0 cross-profile rows under a profile filter.

## Raw harness output (representative run)

```
=== CRUD audit (create → update → validate → delete, live) ===
✅ expense    create 201 12858ms · update 200 463ms · validate 400✓ · delete 200 307ms   (first call cold)
✅ income     create 201 294ms  · update 200 189ms · validate 400✓ · delete 200 125ms
✅ obligation create 201 620ms  · update 200 355ms · validate 400✓ · delete 200 313ms
✅ task/habit/event/goal/tracker/journal/reminder/profile/asset/liability/paycheck … all pass
14 pass / 1 fail  (the 1 "fail" = budget harness false-negative, verified persisted separately)

=== AI-parity audit (natural language → DB effect) ===
✅ expense/income/bill/task/habit/event/goal/tracker/reminder/person/asset/note/budget
13/13 AI commands produced the expected row.

=== Robustness ===
dup-person: 201 then 409  ✅ blocked
dup-expense: 201 then 201 ✅ allowed (correct policy)
huge-amount(1e15): 201    ⚠️ accepted → FIXED (MAX_MONEY)
delete-missing: 200        (idempotent, acceptable)
```

## How to re-run
```
npx tsx tests/audit/verify-crud.ts     # full CRUD + validation + timing
npx tsx tests/audit/verify-ai.ts       # AI natural-language parity
npx tsx tests/smoke/verify-add-buttons.ts
```
(Throttled to respect the 60 writes/min and 20 chat/min server rate limits.)
