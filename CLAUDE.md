# Portol — working rules for this repository

Personal-life dashboard: React + React Query client (`client/src`), Express API
(`server/`, deployed as Vercel functions), shared pure logic (`shared/`),
Supabase Postgres. Production: https://portol.me (Vercel, deploys from `main`).

The authoritative rule set is `docs/GLOBAL_RULES.md` (with `ARCHITECTURE.md`).
This file is the short version: the rules that, when broken, have shipped
real bugs to the owner. Every rule names the module that implements it and
the test that will fail if you break it.

## Before you push

```bash
npx tsc --noEmit          # what Vercel's prebuild runs
npx vitest run            # local suite; new test files MUST be listed in vitest.config.ts
npm run test:contracts    # the pre-push gate runs this against production with the smoke account
```

The pre-push hook (`.githooks/pre-push`) runs `npm audit`, a secret scan, tsc
and the contract suite. Don't bypass a stage unless the failure is
pre-existing and unrelated, and if you do, say so in the commit message.

## After you push to `main`: verify the deploy

A green CI does not mean production changed. On 2026-10-09, every production
deploy had been failing for two weeks (Vercel retired Node 20) while CI stayed
green. After a push to `main`:

- `curl -s https://portol.me/api/version` must report your commit's `sha`. The
  `Production serves main` workflow (`.github/workflows/deploy-verify.yml`)
  checks this and opens an issue if it doesn't.
- `Live E2E (deployed app)` then runs the scenario suite against production.
  It is green; a red run is a real regression.
- Node version: `.nvmrc` → `package.json` `engines.node` (what Vercel builds
  with) → every workflow (`node-version-file`). Change all of them together;
  `tests/ops-guards.test.ts` enforces it.

## Synchronization rules (user-facing state must never disagree with the data)

1. **One source per value.** An asset's value is `resolveAssetValue`
   (`shared/asset-value.ts`); net worth is `computeNetWorth`
   (`shared/net-worth.ts`); "what is it worth now" on a value card is
   `currentAssetValue` (`shared/valuation/context.ts`). Never write
   `fields.currentValue || fields.value || …`.
   *Guard:* `tests/sync-rules-guards.test.ts`.
2. **Writes propagate everywhere.** Mutations go through `apiRequest`. The
   server's write manifest patches the cache and invalidates the right
   domains. If you add a server payload computed from other records, declare
   its source domains in `DERIVED_ENDPOINT_DEPENDENCIES` (or
   `DERIVED_KEY_SHAPES` for id-keyed keys) in `client/src/lib/cache-bus.ts`.
   *Guards:* `tests/sync-rules-invalidation.test.ts`, `tests/sync-rules-guards.test.ts`.
3. **Navigation never writes.** No `apiRequest("POST"|"PATCH"|"PUT"|"DELETE")`
   inside a mount `useEffect`. A control that changes the profile scope must
   say so (label/title).
   *Guard:* `tests/sync-rules-filters.test.ts`.
4. **Filters can't look like deletion.** Use `useSectionFilter` +
   `showFilterControls` + `ActiveFilterNotice` / `FilteredEmptyState`
   (`client/src/lib/view-filters.ts`, `client/src/components/ActiveFilterNotice.tsx`).
   Never persist a filter that hides rows to local/sessionStorage. Never gate
   a filter row on `options.length > 1`. Never say "No X yet" when a filter
   hid them.
   *Guards:* `tests/sync-asset-navigation.dom.test.tsx`, `tests/sync-rules-filters.test.ts`.
5. **Completed actions resolve their alerts, derived from the records.**
   Alerts come from the date-rule engine (`shared/date-rules.ts`;
   `isAlertDateRule` / `isDocumentAttentionRule`). A reporting period's
   boundaries are history (`isReportingPeriodBoundary`). A newer document of
   the same kind and subject supersedes an older one's alert
   (`markSupersededDocumentRules`). Don't add a stored "resolved" flag.
   *Guard:* `tests/sync-rules-notifications.test.ts`.
6. **No stale overwrite.** Don't merge an older row over a newer one
   (`isOlderRow` in `client/src/lib/cache-patch.ts`). Don't do a client
   read-modify-write of a whole array (tags, lists): add a server endpoint
   that applies the change to the stored row, like
   `POST /api/events/:id/occurrence`.
   *Guards:* `tests/sync-rules-valuation*.test.*`, `tests/sync-rules-followups.test.ts`.
7. **A failed request is not an empty account.** No `queryFn` may turn a
   failure into `[]`/`null`. Let React Query keep the last good data.
   *Guard:* `tests/sync-rules-failed-request.dom.test.tsx`.
8. **Destructive buttons take two taps** (`useConfirmArm`). A "snooze" hides
   an alert (`useAlertSnoozes`, synced across devices). It never moves the
   record's real date.
9. **Ownership has one writer** (`server/ownership-writer.ts`). Profile
   scoping goes through `shared/profile-filter.ts`. Deleting a profile is
   fail-safe: if any cascade step fails, the profile is kept, so no record
   points at a missing owner (`deleteProfile` in `server/supabase-storage.ts`).
10. **Only owned things are estimated.** The valuation engine never touches an
    `account`: its value is its balance (`isValuableProfile` in
    `server/valuation/service.ts`).

Dev-only sync logging: `shared/sync-log.ts` (enable in a browser with
`localStorage.portol_sync_debug = "1"`). Off in production.

## Data and credentials

- This repository is **public**. Never commit a password, token or real
  person's login. Live scripts sign in through `tests/helpers/live-account.ts`
  (env `LIVE_EMAIL`/`LIVE_PASSWORD`, default: the dedicated smoke account).
  *Guard:* `tests/ops-guards.test.ts`.
- Only the smoke account (`tests/smoke/fixture/account.ts`) may be written to
  by tests. Production data of real users is read-only for investigation, and
  only when the owner asks.

## Writing tests

- Prefer a test that renders the real page or drives the real route
  (`tests/helpers/route-harness.ts`) over a test of a helper.
- A negative assertion (`expect(...).toBe(false)` / "not present") must fail
  if the field it reads doesn't exist. Read response shapes through strict
  helpers, not `(x || [])`. A suite that is always red is worse than none:
  fix it or delete it.
- For a bug fix, run the new test against the old code (stash the fix) and
  confirm it fails.
