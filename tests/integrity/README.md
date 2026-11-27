# The integrity run

An end-to-end check of the deployed app in which **a success answer is never
enough**. Every scenario performs an action as the smoke account and then owes
evidence of up to four kinds:

| Evidence | What it is | How it is read |
|---|---|---|
| `action` | the request (or the tap) did what was asked | the app's own API, read back |
| `db` | the stored row | **straight from Postgres** (PostgREST with the account's own token — not through the app) |
| `derived` | every figure that depends on the record | compared with `oracle.ts`, a second implementation that imports nothing from the app |
| `screen` | a real browser shows it, without a reload | Chromium, as a desktop mouse and as a phone with touch |

A scenario with a passing check of every kind it declares is **PASS**. One that is
short of a kind is **INCOMPLETE** — never PASS. One failed check is **FAIL**, and
the result carries the steps that led to it and, for browser scenarios, screenshots.

## Run it

```bash
npm run integrity                 # local guards → maps → live run → docs/INTEGRITY_REPORT.md
npm run integrity:local           # local guards and maps only (no network)
npx tsx tests/integrity/run.ts --only money          # scenarios whose id matches
npx tsx tests/integrity/run.ts --no-browser --no-chat
npx tsx tests/integrity/run.ts --seed 42             # the same random data again
npx tsx tests/integrity/run.ts --list
```

Against a branch preview (the preview shares production's database, so this is
still the smoke account under the same gate lock):

```bash
SMOKE_API_BASE=https://<preview>/api SMOKE_UI_BASE=https://<preview> npx tsx tests/integrity/run.ts
```

Results: `test-results/integrity/results.json` (+ `screenshots/`).
`npx tsx scripts/gen-integrity-report.ts [--baseline <dir>]` writes `docs/INTEGRITY_REPORT.md`.

## When it runs by itself

- **Every push and pull request** (`CI`): `npm test` includes the local half —
  `tests/integrity-model.test.ts` (every route and chat tool belongs to a data
  type; no scenario can pass on an answer alone), `tests/integrity-oracle-properties.test.ts`
  (the app's calculations against the oracle on thousands of random inputs) and
  the guards for past findings.
- **After every production deploy, and nightly** (`.github/workflows/integrity.yml`):
  the live run. A red run opens an issue with the failed scenarios, their
  reproduction steps and the command to rerun each with the same seed.

## Rules

- **Only the smoke account is written to** (`tests/smoke/fixture/account.ts`), under
  its gate lock, through `fetchWithRateLimitRetry`. The second account
  (isolation) is only ever asked for the smoke account's rows, which must be refused.
- **Deterministic.** Random amounts and dates come from the seed (default: the
  day number); every record's name carries the run's tag; each scenario removes
  what it made and the run then sweeps anything left carrying the tag.
- **The oracle is independent.** `oracle.ts` must not import from `shared/`,
  `server/` or `client/`. When the app and the oracle disagree, find out which
  is wrong from the owner's stated rule (CLAUDE.md) — do not copy the app's
  answer into the oracle.
- **A finding is not a loosened check.** A deliberate limit goes in `known.ts`
  with its evidence, and the report prints it.

## Adding a scenario

```ts
scenario({
  id: "area.what", title: "…in the words of the rule…", area: "…",
  covers: ["expense.create.api"],          // data type . operation . door — see model.ts
  requires: ["action", "db", "derived"],   // the evidence it owes
  run: async (ctx) => {
    const e = must(await ctx.api("POST", "/expenses", { … }), "create");
    ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
    ctx.check("db", (await ctx.db.row("expenses", e.id))?.amount === 12.5, "the row stores the amount");
    ctx.near("derived", after.totalMonthlySpend - before.totalMonthlySpend, 12.5, "this month's spending rose by it");
  },
});
```

Add the file to `scenarios/index.ts`. `covers` puts it in the coverage matrix
(`docs/INTEGRITY_MAP.md`, `npm run integrity:map`); a key the model does not know
fails `tests/integrity-model.test.ts`.

## Files

- `framework.ts` — scenarios, evidence, direct database reads, the second account, cleanup
- `oracle.ts` — independent expected values (calendar, bills, debts, net worth, budgets, depreciation, streaks)
- `model.ts` — the dependency model: each data type's stores, doors, derived figures and dependents
- `known.ts` — known limits and open questions
- `scenarios/` — `money`, `records`, `hardening`, `assets`, `chat`, `browser`
- `run.ts` — the runner
