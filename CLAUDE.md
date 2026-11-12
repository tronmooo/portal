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
- Every production gate (Live E2E, the contract suite) writes as the one
  smoke account, which the server limits to 60 writes/min. Gate requests go
  through `fetchWithRateLimitRetry` (`tests/smoke/fixture/api.ts`), which
  waits out a 429, so contention can't turn a gate red. Never call `fetch`
  directly in a gate. The contract suite also WIPES the account when it
  starts, so gate runs take turns: each holds the account's gate lock
  (`acquireGateLock`, `tests/smoke/fixture/gate-lock.ts`) while it writes.
  Any new script that writes as the smoke account must take it too.
  *Guard:* `tests/live-gate-rate-limit.test.ts`.
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
   hid them. The app-wide **profile scope** is a filter too: a list it can
   hide must say so. Every shared `EmptyState` in a file that reads the scope
   declares `scope="global"` (it then names the active scope and offers "Show
   everyone") or `scope="none"`; a page that can count what the scope hides
   (Tasks) shows `ActiveFilterNotice`/`FilteredEmptyState`. The filter chip's
   label comes from `scopeLabel()` over the same `useProfileScope` snapshot
   the lists filter with — a selection is never labelled "Everyone".
   (2026-11-09: "Nothing on your list" while a leftover selection hid the
   user's own two tasks.)
   *Guards:* `tests/sync-asset-navigation.dom.test.tsx`, `tests/sync-rules-filters.test.ts`,
   `tests/sync-rules-scope-empty-states.test.tsx`, `tests/sync-tasks-scope-notice.dom.test.tsx`.
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

11. **One tracker per owner + name.** `createTracker`
    (`server/supabase-storage.ts`) is the only way a tracker is born. It is
    serialized per (user, tracker identity) in-process, and a unique-index
    collision REUSES the colliding row. Never suffix or rename a tracker to
    get an insert through ("Heart Rate 42c7"). A tool that writes to a second
    tracker as a side effect (BP's pulse split-out → Heart Rate) must share a
    `toolInterferenceKey` with that tracker's own calls and must not repeat a
    value another call in the same batch already logs.
    *Guards:* `tests/tracker-create-no-duplicates.test.ts`,
    `tests/bp-heart-rate-split.test.ts`.

12. **A date about a person never shows someone else's name.** Records with
    no owner default to the account holder, so "Jordan's birthday" can be
    stored under Bob. Every screen that prints an owner beside a dated item's
    title goes through `ownerLabelForDatedItem` (`shared/birthday-event.ts`),
    which hides the owner when the title is about another person. The chat
    never files "<Name>'s birthday" under the account holder because the
    model passed `forProfile: "me"`. (2026-11-11: "Jordan's birthday ·
    Birthday · Bob Robertson".)
    *Guards:* `tests/dated-item-owner-guard.test.ts`,
    `tests/birthday-owner-label.dom.test.tsx`.

13. **A restored snapshot is a placeholder.** `hydrateQueryCache`
    (`client/src/lib/queryClient.ts`) may mark restored data fresh only where
    the boot refetch replaces it (the current scope's bootstrap fan-out).
    Everything else paints instantly but is invalidated. An invalidation does
    not survive a reload, so "fresh from localStorage" hid a task created
    seconds before a refresh (2026-11-12, production).
    *Guard:* `tests/reload-after-write-refetches.test.ts`.

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
