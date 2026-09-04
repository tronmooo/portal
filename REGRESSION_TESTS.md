# Regression-proof Development System

Version 1, shipped 2026-05-28.

This document is the contract. If anything in `tests/smoke/` contradicts what
is written here, **the document wins** — go fix the test. Edit this file in
the same commit as the change so the rule stays authoritative.

## Why this exists

The user reported (paraphrased): "How many times am I gonna be able to have
the same conversation, the same prompt over and over again. It works one day
then it doesn't work the next day. Why does this keep happening?"

Root cause: fixes were verified locally against the developer's own real
account, never against a known-state fixture, and the pre-push gate only ran
`tsc --noEmit`. A regressed endpoint or category-leak bug could ship to
production and only get caught by the user opening the app.

This system replaces ad-hoc verification with three permanent gates:

1. **Pre-push contract suite** — runs `tests/smoke/contracts/**` against the
   live API using a dedicated fixture account. Blocks `git push origin main`
   if anything fails.
2. **Append-only regression ledger** — every shipped user-visible bug fix
   adds a permanent `it("BUG-YYYYMMDD-…")` test that fails before the fix and
   passes after. The same bug must not recur.
3. **Post-deploy production probe** — `npm run smoke:post-deploy` runs a
   small set of fast HTTP checks against the live Vercel URL; wired into a
   GitHub Action (separate PR) so failed deploys are visible in seconds.

## Smoke fixture account

| field | value |
|---|---|
| email | `portol-smoke@aol.com` |
| user_id | `229685c4-8dcb-4349-8448-57fc38e6e3d2` |
| purpose | reset + reseeded by the suite; never store real data here |

The fixture's exact shape is in `tests/smoke/fixture/seed.ts` under
`FIXTURE`. If you change a value there, you MUST update the matching
assertions in `tests/smoke/contracts/`.

## Layout

```
tests/smoke/
├── fixture/
│   ├── account.ts     ← shared constants (email, IDs, API base, supabase URL)
│   ├── api.ts         ← getSmokeToken(), api(), expectOk()
│   ├── seed.ts        ← FIXTURE constant + wipeAll + seed (+ CLI)
│   ├── reset.ts       ← wipe-only helper
│   └── setup.ts       ← ensureSeeded() — runs once across all contract files
└── contracts/
    ├── invariants.test.ts    ← rules that must always hold
    ├── crud.test.ts          ← round-trip create/read/update/delete
    ├── isolation.test.ts     ← user A never sees user B's data
    ├── dashboard.test.ts     ← stat math matches profile sums
    ├── cache.test.ts         ← mutations are reflected on the next GET
    └── regressions.test.ts   ← APPEND-ONLY ledger of fixed bugs
```

## Commands

| Command | What it does |
|---|---|
| `npm run test:contracts` | Run the full smoke contract suite (~60-120s) |
| `npm run smoke:seed` | Reset and reseed the fixture account |
| `npm run smoke:reset` | Wipe-only (without reseeding) |
| `npm run smoke:verify` | Print fixture counts (sanity check) |
| `npm run smoke:post-deploy` | Fast probe against the live Vercel URL |
| `npm run test:multiaction` | Multi-action AI chat regression tiers (5/10/20/50 actions per message) against a live deployment — verifies every action writes to the DB, feeds the dashboard, survives refresh, and is individually editable/deletable. Env: `MULTIACTION_BASE_URL` (default `https://portol.me/api`), `MULTIACTION_EMAIL`/`MULTIACTION_PASSWORD`. Needs a server with `ANTHROPIC_API_KEY`; not part of gating `npm test`. Deterministic companions `tests/action-split.test.ts` + `tests/bulk-extraction-normalize.test.ts` ARE gating. |

## Pre-push gate

`.githooks/pre-push` runs, in order:

0. `npm audit --omit=dev --audit-level=high`  (skip with `SKIP_AUDIT=1`)
1. `tsc --noEmit`  (skip with `SKIP_TSC=1`)
2. `npm run test:contracts`  (skip with `SKIP_TESTS=1`)

`SKIP_ALL=1` skips all three. The same audit runs in CI
(`.github/workflows/ci.yml`), so bypassing it locally only defers the failure
to the pull request.

All three gates are **strict** — push is blocked if any fails. The skips exist
only for emergency hotfixes; use sparingly and note them in the commit message.

A note on the audit gate: it fails on the whole dependency tree, not on your
diff, so it can block a push that changed nothing about dependencies. When that
happens the fix is to clear the advisory, not to bypass it — and prefer a range
over an exact pin. Two `overrides` entries pinning `brace-expansion` to an
exact `5.0.7` were the safe version when written, and became the reason the
gate failed once the advisory range widened to include it.

## How to add a regression test (every bug fix needs one)

1. Open `tests/smoke/contracts/regressions.test.ts`.
2. Add a new `it()` block at the bottom (do not delete existing ones).
3. Naming: `BUG-YYYYMMDD-short-kebab` where the date is when the bug was
   *reported*, not the date you fixed it.
4. The assertion should reproduce the failure mode through the public API.
   If the bug is purely visual, add a Playwright spec in `tests/smoke/ui/`
   instead (or in addition).
5. Run the contract suite — your new test should FAIL.
6. Ship the fix (smallest possible change, no unrelated refactors).
7. Re-run — your test should now PASS.
8. Push. The pre-push gate keeps the test running on every future change.

### Hard rules

- **Never delete** a regressions ledger entry. If the same bug recurs, do
  not add a second entry — strengthen the existing one.
- **Never weaken** an assertion to make a failing test pass. If the contract
  is actually wrong, change the assertion AND document why in this file.
- **Never bypass** with `SKIP_TESTS=1`, `SKIP_TSC=1`, `SKIP_AUDIT=1` or
  `SKIP_ALL=1` without recording it in the commit message body.

## Hidden tracker categories (BUG-20260528-finance-tracker pattern)

Money does not belong in `/trackers`. The single source of truth is
`shared/hidden-tracker-categories.ts`:

```ts
export const HIDDEN_TRACKER_CATEGORIES = new Set<string>([
  "finance", "budget", "savings", "investment", "money", "spending",
]);
```

Both the server (`server/routes.ts` POST and GET handlers) and the client
import from there. Adding to this set requires:

1. Update the set in `shared/hidden-tracker-categories.ts`.
2. Add an `it("BUG-…")` entry in `regressions.test.ts`.
3. Add the category to the matching test in `invariants.test.ts`
   (`HIDDEN_TRACKER_CATEGORIES` literal there).

## Active ledger entries (as of 2026-05-28)

| Bug ID | Surface affected | Server/Client | Test |
|---|---|---|---|
| BUG-20260528-finance-tracker | Trackers list | Both | `regressions.test.ts` + `invariants.test.ts` |
| BUG-20260528-upcoming-window | /stats vs dashboard popup | Server | `regressions.test.ts` |
| BUG-20260528-asset-resolver-duplication | profile-detail Financial Overview vs dashboard | Client | `regressions.test.ts` |
| BUG-20260528-monthly-multipliers | /stats monthly totals vs /dashboard-enhanced | Server | `regressions.test.ts` |
| BUG-20260528-obligation-patch-materialize | Calendar after obligation edit | Server | `regressions.test.ts` |
| BUG-20260528-fabricated-sparkline | Net Worth tile sparkline | Client | `regressions.test.ts` |
| BUG-20260903-forgot-password-history | Logged-out Forgot Password / browser Back | Client | `public-auth-ui.dom.test.tsx` |
| BUG-20260903-public-feature-carousel | Logged-out What Portol Does carousel | Client | `public-auth-ui.dom.test.tsx` |

Client-only fixes (mutation onMutate/rollback, useMemo wrappers, query key
shape consolidation) are validated indirectly through the CRUD and CACHE
suites because their failure mode is a stale render, not a wrong API
response. See ARCHITECTURE.md section 5.3 and section 3 for the canonical
rules those changes were guided by.

## Known limitations of the v1 suite

These are deliberate trade-offs, recorded so the next agent doesn't redo
them:

- The contract suite runs against the **live production API**. We considered
  spinning up a separate ephemeral Vercel deploy per push; it was too slow
  for a pre-push gate. Mitigation: smoke account is dedicated, fixture is
  small, suite is sequential.
- ISO-delete asserts only that the row survives — not that the response
  code is 4xx. The server returns idempotent 200 to non-owners (deliberate);
  the *data* is isolated. Tightening this is a separate change.
- Playwright UI specs (`tests/smoke/ui/`) are not yet in the pre-push gate;
  they run post-deploy only. Adding them pre-push means installing browsers
  in CI — deferred.
