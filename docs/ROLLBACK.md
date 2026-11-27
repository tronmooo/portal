# Rollback procedure — integrity branch release

For the merge of `claude/gallant-knuth-3cr7u6` into `main` (the integrity run,
its fixes, and the three owner rulings of 2026-11-27).

## What the release changes, and why a rollback is safe

- **Code only.** The branch contains **no database migration** and changes no
  table, column, index, function or policy. Nothing has to be undone in the
  database to go back.
- **Data written by the new code is readable by the old code.** The new code
  writes four things the old code never wrote; each was checked against the
  code production runs today (`374c77a`):

  | New data | Where | What the old code does with it |
  |---|---|---|
  | `_paymentKeys` (recent idempotency keys) | a liability profile's `fields` | Ignored: keys starting with `_` are never listed or read (`AddFieldPanel` skips them). |
  | `from-deleted:<name>` tag | expenses kept when a bill or debt is deleted | An ordinary tag on an ordinary expense. The old code would have deleted these expenses with the bill; after a rollback they simply stay. |
  | Expense / income ids derived from a request key | `expenses.id`, `incomes.id` | Ordinary UUIDs. |
  | Memory keys named by subject | `memories.key` | Ordinary keys; the old code would name new ones by their first three words again. |

- **Behaviour that comes back with a rollback** (so it is a decision, not only
  a button): the same-price duplicate question for expenses, password reset by
  e-mail being refused, the stale dashboard after completing a task, and the
  other defects listed in `docs/INTEGRITY_REPORT.md`.

## Before merging — record the rollback target

The production deployment to go back to (current production, 2026-11-27):

- commit `374c77ab6c7895b787ad601846324822397f475e` (`main`)
- Vercel deployment `dpl_6U9PBztgFRuUU22Fs9q9AaH2csEp`
  (`portal-awupm3l3l-tronmooos-projects.vercel.app`)

Re-check it at merge time (`curl -s https://portol.me/api/version` must report
that commit): if `main` has moved since, the target is whatever production
serves immediately before the merge.

## How to roll back

**1. Instantly, without a build (preferred when something is wrong for users).**
In Vercel → project `portal` → Deployments → the deployment above → **Promote to
Production** (or "Instant Rollback"). Production serves the old build within
seconds; `main` is untouched.

**2. Then make `main` agree**, so the next push does not redeploy the release:

```bash
git checkout main && git pull
git revert -m 1 <merge commit>      # one revert commit; history is kept
git push origin main
```

(A fast-forward merge has no merge commit: revert the range instead,
`git revert --no-commit 374c77a..<release head> && git commit`.)

**3. Verify the rollback.**

```bash
curl -s https://portol.me/api/version          # the old commit (after step 1) or the revert commit (after step 2)
npx tsx tests/live-schema-drift-check.ts       # the schema is what that code expects
npm run test:contracts                         # the contract suite, as the smoke account
```

`Production serves main` (`.github/workflows/deploy-verify.yml`) checks the
version after step 2 and opens an issue if production does not serve it.

## When to roll back

Roll back, rather than fix forward, if after the release any of these is true
and is not explained within minutes:

- `Production serves main` or `Live E2E (deployed app)` is red on the release commit.
- `Integrity (deployed app)` reports a failed scenario in money (`money.*`),
  accounts or isolation (`hardening.account-isolation`).
- Vercel runtime errors (5xx) on `/api/*` rise above their level before the release.
- A user reports data missing, doubled, or shown under the wrong profile.

## What a rollback does not undo

Records users created while the release was live stay exactly as they are
(two identical expenses remain two expenses). There is nothing to migrate back.
