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

13. **A name is data, not permission to create a profile.** A person, pet
    or provider profile is created only when the user explicitly asks
    (`hasExplicitProfileCreateIntent`, `shared/profile-intent.ts`;
    `create_profile` refuses otherwise with `PROFILE_NOT_REQUESTED`). The
    original request is completed without one: "Bob's birthday is Sep 30" is
    a yearly event, "Call Mike at 3" a task, "I bought Sarah a gift" an
    expense, all owned by the user. The profile is OFFERED under the reply
    (`server/profile-suggestions.ts` → `ProfileSuggestionCard`), once per
    name, never blocking; No writes nothing. A profile created later picks up
    that person's existing birthday events (re-owned, not copied). Never add a
    prompt line or tool path that auto-creates a person from a mention.
    (2026-11-12: "Bob's birthday…" created a person named Bob.)
    *Guards:* `tests/profile-creation-rules.test.ts`,
    `tests/profile-suggestion-card.dom.test.tsx`.

## Liability rules (a debt reads the same everywhere, and a confirmed change is a stored change)

Every rule below is a bug the owner hit in one session (Liabilities tutorial,
2026-11-18). Read them before touching `client/src/pages/liability-detail.tsx`,
the Liabilities list in `client/src/pages/trackers.tsx`, the debt tools in
`server/ai-engine.ts` or `server/liability-payments.ts`.
*Guard for the page-level rules:* `tests/liability-rules-guards.test.ts`.
*Live check (deployed app, smoke account):* `npx tsx tests/live-liability-forms-check.ts`
and `npx tsx tests/live-assets-liabilities-check.ts`.

**L1. One debt = one record.** A loan or card IS its own bill: its payment
amount and due day are fields on it, and the schedule/calendar are derived
from them (`deriveScheduleFields`, `shared/liability-schedule.ts`). Never
create a second "<name> payment" bill beside a debt, from chat or anywhere
else. ("Wells Fargo Mortgage" + "Wells Fargo Mortgage payment".) BOTH chat
doors hold this: `create_liability` creates nothing beside the debt, and
`create_obligation` for a bill that is the payment of a debt already on file
writes the amount and due day ONTO that debt instead of creating a bill
("an auto loan and a payment" = one card). The two tools share a
`toolInterferenceKey`, so in one model round they take turns.
*Guards:* `tests/chat-liability-one-record.test.ts`, `tests/chat-debt-and-payment-one-card.test.ts`,
`tests/liability-rules-guards.test.ts`. *Live:* `npx tsx tests/live-debt-one-card-check.ts`.

**L2. A change is written under the canonical key.** `balance`,
`interestRate`, `monthlyPayment`, `originalBalance`
(`shared/profile-field-canon.ts`). The storage fold keeps the stored
canonical value when an alias (`currentBalance`, `annualInterestRate`)
disagrees with it, so an alias write is silently discarded — the chat said
"refinanced" and the record kept 6.25% / $311,172. The chat's confirmation is
built from a read-back of the saved record, never from the model's sentence.
*Guards:* `tests/chat-liability-one-record.test.ts`, `tests/profile-field-canon.test.ts`.

**L3. A rate is a percent.** `interestRate` is stored as a percent (6.25).
Read it only through `shared/liability-fields.ts` (`readInterestRatePct` to
show or prefill, `readAnnualRate` for math). Never print the raw field and
never guess the unit at a write (`r > 1 ? r / 100 : r`): a decimal under a
"%" label was shown as "0.1%" and a form labelled "%" opened with 0.0625.
*Guards:* `tests/no-inline-liability-field-chains.test.ts`, `tests/liability-rules-guards.test.ts`.

**L4. The list and the page agree.** A debt's type comes from the `type_key`
column (`liabilityTypeKeyOf`, `shared/liability-types.ts`), not `fields.*`
(a mortgage read "Other"). Its next due date comes from the temporal engine
(`getRecordTemporalStatus` → `nextLoanDueDate`, `shared/loan-facts.ts`),
counted from today and its payment day — never from a stored
`firstPaymentDate`, which is the loan's origin ("1601d overdue" on a loan
added today). A day of the month (`dueDay`) is a number, not a date
("Jan 1, 2001"); a first-payment date is history, not a deadline
(`shared/overview-semantics.ts`). A nested liability is a CHILD
(`parentProfileId`), so a panel that lists them reads children, not only
link-table edges.
*Guards:* `tests/liability-rules-guards.test.ts`, `tests/liability-qa-2026-11-18-followup.test.ts`,
`tests/temporal-status.test.ts`.

**L5. Payments.** The server owns the principal/interest split
(`planDebtPayment`, `server/liability-payments.ts`); the dialog previews the
same rule. A month's interest is charged once (`interestChargedInMonth`,
`shared/liability-calc.ts`) — a second payment in the month is all principal.
"Extra principal" sends the extra alone as `paymentType: "extra_principal"`
and carries no interest. Reversing a payment takes two taps (Rule 8).
*Guards:* `tests/liability-interest-once-per-month.test.ts`, `tests/liability-payment-parity.test.ts`,
`tests/liability-rules-guards.test.ts`.

**L6. A write made elsewhere shows when the profile is reopened.** A payment
recorded in chat can only mark the closed profile's query stale; the detail
query must refetch an invalidated cache on mount (never `refetchOnMount:
false`), or the header keeps the old balance beside a Payments tab that
shows the new one. A bare `YYYY-MM-DD` is a calendar day in the user's zone:
parse it with `parseLocalDate` (`client/src/lib/format.ts`), never
`new Date("2026-11-18")` (Activity said Nov 17).
*Guards:* `tests/liability-rules-guards.test.ts`, `tests/format-full-date.test.ts`.

**L7. An edit saves itself.** An edit form has no Save button to forget: the
Edit dialog saves through `client/src/lib/profile-autosave.ts`, the
loan-terms and bill-details forms through `client/src/hooks/useAutosave.ts`
(after a pause in typing, on Done, and on leaving the page; only what changed
since the last save; nothing on open — Rule 3). A new edit form uses one of
these. After deleting a liability the app returns to the Liabilities list
(`/linked?tab=liabilities`), not the Info tab.
*Guards:* `tests/autosave-edit-forms.dom.test.tsx`, `tests/profile-autosave.test.ts`,
`tests/liability-qa-2026-11-18-followup.test.ts`.

## Auto Pay rules (routine payments record themselves; the books stay honest)

Every liability (bill, subscription, loan, card) has an Auto Pay setting. The
rules are in `shared/autopay.ts`, the operations in `server/autopay.ts`; money
still moves only through `payBillOccurrence` / `unpayBillOccurrence`. Read
them before touching the due-scan cron (`runLiabilityDueScan`,
`server/routes.ts`), `AutoPaySection` or `PaymentStatusControls`.
*Guards:* `tests/autopay-liabilities.test.ts` (car loan, mortgage, phone bill,
subscription over the real pay pipeline), `tests/autopay-controls.dom.test.tsx`.

**A1. Recorded on the due day, once.** `autopayDueOccurrence` is the only
answer to "what does Auto Pay record now": never before the due day, never for
a day before Auto Pay was switched on (`autoRecordSince`, stamped by the
storage layer whichever door flips the switch), never for an occurrence that
is paid, skipped or missed. The occurrence is claimed before the ledger row is
written, so a retry, a second run or a page load cannot add a payment. Only
the cron records; no screen does (Rule 3).

**A2. Assumed is not confirmed.** A payment Auto Pay recorded carries
`verification: "assumed"` on its occurrence stamp, the one place that state
lives; a payment a person or a document recorded is confirmed. Show a payment's
status through `occurrencePaymentStatus` / `PaymentStatusBadge`; never print
"Paid" for an assumed one. Its expense carries `ASSUMED_EXPENSE_TAG` until it
is confirmed.

**A3. One occurrence, not the schedule.** Missed, delayed, partial, confirmed
and back-to-scheduled go through `setOccurrenceStatus`
(`POST …/occurrences/:date/status`, `POST /api/liability-payments/:id/status`).
It never writes the liability's amount, due day or Auto Pay flag. Marking a
recorded payment missed reverses it (expense, balance, account) and takes two
taps (Rule 8); the series moves on, and the missed payment is raised as an
alert derived from the stamp (Rule 5) until it is paid, moved or reopened.

**A4. Principal is not spending.** A loan or card payment lowers the balance
by its principal (L5); only its interest and fees are logged as an expense
(`debtPaymentExpenseAmount`), tagged `payment-cost:<id>`. A recurring bill's
whole payment is the expense, tagged `payment:<id>`. Never log a loan's full
payment as an expense: the principal would count twice.

**A5. One payment, however it is confirmed.** A bank transaction that is an
assumed payment confirms that payment (`reconcileBankTransaction`; the
statement import asks it before creating an expense). It is re-priced to the
bank's amount in place and never becomes a second expense. A transaction id
matched once answers the same payment again and writes nothing.

**A6. Quiet unless something is wrong.** An upcoming Auto Pay bill is not in
Needs Attention and raises no reminder task or due-soon alert
(`isQuietAutoPayBill`, `wantsDueReminders`) unless the user turned "Remind me
anyway" on. An overdue Auto Pay bill and a missed payment are the exceptions
that show. Turning Auto Pay off stops future recording only.

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
