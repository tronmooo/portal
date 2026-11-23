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
   **Done means gone, and a dismissal has one store.** A row the user
   completes, pays or dismisses on the dashboard leaves on the tap and stays
   out until the write and its refetch settle (`leaveWhile`,
   `ExecutiveBriefing.tsx`); a failed write brings it back. A dated alert has
   ONE id whatever shape it takes (`dateAlertId`, `shared/alert-ids.ts`): the
   document row and its "Expired: …" alert are dismissed together, into the
   server's `dismissed_notifications` list (`useDismissedAlerts`), and every
   dismissed alert can be restored (`DismissedAlertsList`). Never write a new
   dismissal to localStorage (`lib/docSnooze.ts` is read-only legacy).
   (2026-11-22: a dismissed Home Depot expiration came back as its alert
   twin.)
   *Guards:* `tests/dismiss-stays-dismissed.test.ts`,
   `tests/dashboard-done-means-gone.dom.test.tsx`.
   **Next Important is something on the calendar.** The tile is
   `pickNextImportant` (`shared/next-important.ts`): the nearest dated item,
   same-day items ordered by what they are, never a tracker's reading or
   logging gap, and null (not a filler) when nothing qualifies. "N doses
   unlogged" is raised only for a medication the user switched alerts on for
   (`AttentionConfig.medicationGapTrackerIds`; default none). The Wellness
   Weight row is a BODY weight: never a workout tracker, never a `sets` field
   (`isWorkoutShapedTracker`, `BODY_WEIGHT_FIELD`, `client/src/lib/wellness-metrics.ts`).
   (2026-11-22: "Prilosec: 7 doses unlogged this week" as Next Important;
   "Weight · 3 sets".)
   *Guards:* `tests/next-important.test.ts`, `tests/wellness-metrics.test.ts`,
   `tests/executive-sections-router.test.ts`.
   **The dashboard shows what there is, once.** Schedule and Upcoming are
   ONE Timeline card (today's events, then everything coming up in date
   order; bills stay under Money, expirations under Needs Attention). A card
   with nothing to show folds into the quiet row under the grid
   (`QUIET_CARDS`, `exec-quiet-cards`, `ExecutiveBriefing.tsx`) and opens in
   place on a tap; it folds only once its data has loaded, and the row says
   when a profile filter may be why (Rule 4). Needs Attention, Money and
   Documents always render. Money leads with Assets / Debt / Net worth from
   the snapshot (Rule 1). The Documents card never repeats what Needs
   Attention lists. (Owner, 2026-11-22.)
   Which cards show, their order and their size is the user's
   (`shared/exec-card-prefs.ts`, preference `exec_card_prefs`): quiet mode is
   the DEFAULT (Needs Attention, Tasks, Timeline, Money), and every card the
   preferences hide is named under the grid and opens on a tap
   (`exec-hidden-cards`) — hidden never reads as missing.
   **Customize opens from the ⋮ menu at the end of the Next Important bar
   (whenever the briefing is on the page), never from the tab itself; there
   is no Quick Actions row** (owner, 2026-11-23; 2026-11-22: "at the bottom, the customization shouldn't be
   there"). It is the `ExecCustomizeDialog` (`components/dashboard/ExecCustomize.tsx`),
   built to the owner's design: tabs (Cards & Widgets, My Custom, AI Builder,
   Layout), Quiet Mode, a row per card (drag handle, size, switch, details),
   Widget Ideas, Hidden Cards, and Reset / Cancel / Save. It edits a DRAFT:
   opening writes nothing (Rule 3), Save Changes writes the one preference row,
   Cancel drops it; Reset to Default keeps the cards the user built.
   **A custom card stores no data.** A widget (`shared/exec-widgets.ts`) is a
   typed description — a source, a filter, a row count — rendered from the
   same lists every screen reads (`ExecWidgetBody`; Rule 1), with an error and
   retry when a list fails (Rule 7). The AI Builder
   (`GET /api/exec-widgets/suggest`, `server/exec-widget-builder.ts`) only
   CHOOSES among sources the app can draw: its answer passes `sanitizeWidget`
   or is refused, it writes nothing, and with no model it answers by fixed
   rules (`inferWidgetFromText`). Add a new kind of widget by adding a source
   there, never by letting the model emit markup or queries.
   **Several dashboards, one set of cards** (`shared/exec-dashboards.ts`;
   owner, 2026-11-22: "different customizations for different types of
   executive dashboards"). A dashboard is a named LAYOUT — what shows, order,
   sizes, Quiet Mode — over the eight standard cards and the user's own. The
   stored row holds all of them (`serializeExecDashboards`; a row from before
   reads as the one dashboard "Main"). Screens that draw the tab take
   `activeExecPrefs` and need not know the others exist. A card built while
   editing one dashboard starts hidden on the rest; removing a card removes it
   everywhere; deleting a dashboard (two taps, never the last) keeps the
   cards. New dashboards start from `DASHBOARD_TEMPLATES`. The tab's chip row
   only SWITCHES the active dashboard; arranging them is the dialog.
   Every part of a custom card is editable (`WidgetEditor`): source, kinds,
   text filter, time span, rows, icon, title — each change through
   `sanitizeWidget`. A medium card with nobody beside it on a phone takes the
   row (`lonelyMediumCards`); do not hand-code per-card "wide" exceptions.
   *Guards:* `tests/executive-sections.test.tsx`, `tests/exec-card-prefs.test.ts`,
   `tests/exec-widgets.test.ts`, `tests/exec-dashboards.test.ts`,
   `tests/exec-customize-dialog.dom.test.tsx`.
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

11a. **One food = one entry.** Every separate food or drink the user reports
    is its own Nutrition entry with its own numbers ("a banana and a
    doughnut" = two). The chat prompt asks the model for one log per food,
    and the server does not depend on it: a `log_tracker_entry` whose item
    joins several foods is split per food BEFORE it runs
    (`splitCombinedFoodLog`, `server/meal-split.ts`; the rule is
    `splitSeparateFoods`, `shared/food-split.ts`), in the tool loop and the
    bulk lane alike, so each food has its own card and undo. What was added
    to a food stays with it ("coffee with cream and sugar"), and a single
    dish is one food ("mac and cheese"). Never bring back a "one meal = one
    entry" prompt line. (Owner, 2026-11-22: "Banana + Doughnut, 355 kcal".)
    *Guards:* `tests/one-food-one-entry.test.ts`,
    `tests/chat-one-food-one-entry.test.ts`.

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

**L3. A rate is a percent, and the record says so.** `interestRate` is stored
as a percent (6.25) beside the marker `_interestRateUnit: "percent"`
(`RATE_UNIT_KEY`, `shared/liability-fields.ts`). Read it only through that
module (`readInterestRatePct` to show or prefill, `readAnnualRate` for math —
feed the amortization engine the DECIMAL). Write it with `storedRateFields`
(a "%" input: what is typed is the percent) or, in a chat tool, `chatRatePct`
then `storedRateFields`. Never print the raw field and never guess the unit
at a write (`r > 1 ? r / 100 : r`): the guess cannot hold a rate under 1% —
0.9 typed in the loan-terms form was stored as 90 ("APR 90.00%"). Only an
UNMARKED legacy row is still guessed, and the storage layer marks it the
next time it is written (`stampRateUnit`).
*Guards:* `tests/liability-rate-unit.test.ts`, `tests/no-inline-liability-field-chains.test.ts`,
`tests/liability-rules-guards.test.ts`.

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
A payment the chat reports IS recorded: on a debt, a second chat payment the
same day is its own payment (only the model's double call — same money, same
day, within a minute — is folded, and then the reply says nothing new was
recorded). The confirmation line is the server's, from the ledger row and a
read-back of the balance (`shared/payment-receipt.ts`), never the model's
subtraction ("$1,150" quoted against a stored $1,173.85; "New balance:
$2,671.64" for a payment that was never written).
*Guards:* `tests/liability-interest-once-per-month.test.ts`, `tests/liability-payment-parity.test.ts`,
`tests/chat-payment-recorded.test.ts`, `tests/liability-rules-guards.test.ts`.

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
these. Because there is no Cancel, the form offers "Undo changes" (back to
the values it opened with — `useAutosave().opened`), and Done awaits the
pending save before closing. A saved edit is written into the profile-detail
cache at once so the header does not show the old value until a refetch.
After deleting a liability the app returns to the Liabilities list
(`/linked?tab=liabilities`), not the Info tab.
*Guards:* `tests/autosave-edit-forms.dom.test.tsx`, `tests/profile-autosave.test.ts`,
`tests/liability-qa-2026-11-18-followup.test.ts`, `tests/liability-term-and-status.test.ts`.

**L8. A loan's original term is not its months left.** `termMonths` is the
contract term ("a 36-month loan"); `remainingTermMonths` is only what the
user says is LEFT. "Payments left" has one reader, `loanStoredTermMonths(fields,
today)` (`shared/loan-facts.ts`): an explicit remaining figure, else the term
minus the payments scheduled since the first payment. Never count a stored
term from today (a 36-month loan eight months in showed "36 payments left").
The AI summary of a debt is written from its payments and is stale when the
balance or last payment date changes (`shared/profile-summary-fingerprint.ts`).
*Guard:* `tests/liability-term-and-status.test.ts`.

## Journal and Notes rules (what was written stays written, and chat can read it back)

Every rule below is a bug from one session (Journal tutorial, 2026-11-20).
Read them before touching `client/src/pages/journal.tsx`, `upsertJournalEntry`
(`server/content-service.ts`), the journal/note tools in `server/ai-engine.ts`
or the profile Notes boxes.

**J1. A day holds several entries, and a save never writes over another
entry.** There is no one-entry-per-day rule (owner decision 2026-11-20;
`migrations/20261120_journal_many_per_day_and_title.sql` dropped the unique
index). Every journal write is a new entry (`upsertJournalEntry`, mode
`"new"`); only "add this to today's journal" (`append_journal_entry`, mode
`"append"`) joins the writer's latest entry of that day. A new entry is a
duplicate only when its whole text EQUALS an entry's — never "is contained
in": the composer's first autosave is a fragment (`draft: true`, never
de-duplicated), and matching it to another row handed the composer that row
to overwrite, which is how a manual save once replaced the entry chat wrote.
*Guards:* `tests/journal-entries-routes.test.ts`, `tests/journal-composer.dom.test.tsx`,
`tests/error-hunt-2026-09-03.test.ts` (D290).

**J2. Mood is picked or detected, never a silent default.** A mood the writer
picked is kept (`moodPicked`); any other mood is a guess, and a neutral guess
gives way to `detectMoodFromText` (`shared/mood-detect.ts`) — the chat saved
"frustrated and overwhelmed" as Neutral. Text with no feeling in it leaves the
day's mood alone. Both composers show the mood buttons and say whether the
mood shown was picked or detected.
*Guards:* `tests/journal-entries-routes.test.ts`, `tests/chat-journal-read.test.ts`.

**J3. "Save this as today's journal entry" saves the message.** The entry's
text is the user's own words (`journalFilingContent`, `shared/journal-intent.ts`),
filled in when the model sends an empty or paraphrased entry. The confirmation
comes from the saved row: a new entry is "Saved", text joined onto the day's
entry is "Added to" — never "Updated" for one just created.
*Guards:* `tests/journal-intent.test.ts`, `tests/chat-journal-read.test.ts`.

**J4. A question about the journal or a note is answered from that record.**
"Show me my journal entry from today", "what was my mood earlier today" and
"find my note about …" are answered from the stored rows
(`server/journal-read.ts`) before the document lookup; anything else about
the journal goes through `read_journal`, and a summary is handed the entry's
text. Never answer one with a document. A tool result must not put journal
text under an `entries` key (the result summariser strips it).
*Guard:* `tests/chat-journal-read.test.ts`.

**J5. A note is a Note.** A profile's "New note" box saves a Note record with
a title (`NewNoteForm` → `POST /api/notes`), so it shows under Notes &
Artifacts and chat can find it. `profile.notes` is the profile's memo and is
labelled as one. An entry's "last written" time is `updatedAt`, never its
bare `date` ("Last 18h ago" for an entry saved minutes earlier).
*Guard:* `tests/info-tab-editable.dom.test.tsx`.

**J6. A capture request saves; it does not interpret.** A chat request that
carries `capture: { kind, profileId? }` is saved as that object, word for word
(`captureFromButton`, `server/ai-engine.ts`): the chat model does not run, a
line shaped like a question is still an entry, and nothing the text mentions
is logged. The chat box no longer sends it (its Journal / Notes buttons open
workspaces — see "Workspace rules"); the server path stays for requests that
do. Without it, the word "journal" / "note" still routes as before.
*Guard:* `tests/chat-capture-buttons.test.ts`.

**J7. An entry belongs to one person.** "Bob's journal: …", "Note for Bob: …"
(`parseCaptureTarget`, `shared/capture-target.ts`) or the "For" menu files the
record under that profile; Bob's entry and the writer's on the same day are
separate rows, and "my journal" reads only the writer's own
(`journalEntriesFor`). Only people and pets can own one. A name with no
profile creates none (Rule 13): the text is saved whole under the writer and
the reply says so. Two profiles answering to the name: nothing is saved and
the reply asks which.
*Guard:* `tests/chat-capture-buttons.test.ts`.

**J8. Every entry and note has a title, and a title never costs a save.**
What the writer typed; else the chat model's `title` in its tool call; else
`generateTitle` (`server/content-title.ts`: one small bounded call, used by
the buttons and the manual forms); else the first clause of the text
(`fallbackTitle`). A composer draft is titled when it is saved (`autoTitle`),
not mid-sentence.
*Guards:* `tests/journal-entries-routes.test.ts`, `tests/chat-capture-buttons.test.ts`.

*Live check for J1–J8 (deployed app, smoke account):* `npx tsx tests/live-journal-check.ts` (server).

## Workspace rules (four full-screen tools opened from AI Chat)

Owner request 2026-11-22: "each opens its own dedicated, full-screen workspace
… not four versions of the same chat box". The chat box's **Notes, Journal,
Document and Fill In** buttons navigate (`WORKSPACES`,
`client/src/components/workspace/WorkspaceShell.tsx`); they are not modes of
the chat box. Read these before touching that file, `pages/workspace-*.tsx`,
the workspace branch of `pages/journal.tsx`, `pages/editor.tsx` or
`server/workspace-ai.ts`.
*Guards:* `tests/chat-workspace-buttons.dom.test.tsx`, `tests/workspace-notes.dom.test.tsx`,
`tests/workspace-ai.test.ts`.
*Live check (deployed app, smoke account, real browser):* `npx tsx tests/live-workspaces-ui-check.ts`.

**W1. Full screen means the whole window.** A workspace is mounted on
`<body>` (`WorkspacePortal`): the app's layout is a centred max-width column,
and a fixed box inside it does not reach the window's edges. While one is open
`useFullScreenWorkspace` marks `<html>`/`<body>`, which hides the floating
chrome (`data-app-floating`) and releases the desktop scrollbar gutters. Stay
at `z-40`: menus and dialogs opened inside a workspace portal at `z-50`.
**W2. The X saves, then leaves; it never asks and never discards.** Each
workspace hands `WorkspaceCloseButton` a function that flushes what is pending
and then goes to `/chat`. A failed save keeps the workspace open. The
editor's Back does the same (the old "Unsaved changes. Leave anyway?" is gone).
**W3. Opening writes nothing (Rule 3); typing does.** Notes creates the note on
the first text and updates THAT note after; Journal is the Journal page's
draft autosave; a new document saves itself once it has content, WITHOUT
moving the URL (`quietSaveRef`: the route change remounts the editor and drops
the caret). A new sheet still waits for its first Save.
**W4. A save never adopts another record (J1).** When `POST /api/notes`
answers `deduped`, the Notes workspace does not take that id: it would
overwrite the other note with whatever is typed next.
**W5. The AI proposes; the user applies.** `POST /api/workspace/document/assist`,
`/notes/assist` and `/journal/reflect` (`server/workspace-routes.ts`, on
`READONLY_POST_PATHS`, served by the AI function) write nothing. The workspace
shows the proposal with Use / Add / Discard. The Journal AI only READS: it
returns an answer for a side panel, never a replacement entry, and reads the
writer's own entries (`journalEntriesFor`).
**W6. A document never invents a personal fact.** What is not on file is
written `[Missing: …]`; the blanks shown are read back from the returned text
(`documentBlanks`, `shared/workspace-document.ts`), and the HTML is only what
the editor holds (`sanitizeDocumentHtml`). Secrets (password, SSN, card,
passport keys) are never sent to the model; another person's profile only when
the request names them.
**W7. Fill In is Smart Fill, full screen.** Its review (sources, every field,
what is missing) is the approval step; nothing is saved before it and nothing
is ever submitted anywhere. In the workspace the dialog is not modal and sits
under the workspace header, so the X stays in reach.
*Not built (2026-11-23):* tables, images and page-layout controls in the
document editor; note attachments and rich text (a note is markdown text);
journal photos; Word and spreadsheet forms, and online (browser) form filling,
in Fill In; a Computer mode.

## Auto Pay rules (routine payments record themselves; the books stay honest)

Every liability (bill, subscription, loan, card) has an Auto Pay setting. The
rules are in `shared/autopay.ts`, the operations in `server/autopay.ts`; money
still moves only through `payBillOccurrence` / `unpayBillOccurrence`. Read
them before touching the due-scan cron (`runLiabilityDueScan`,
`server/routes.ts`), `AutoPaySection` or `PaymentStatusControls`.
*Guards:* `tests/autopay-liabilities.test.ts` (car loan, mortgage, phone bill,
subscription over the real pay pipeline), `tests/autopay-controls.dom.test.tsx`,
`tests/chat-autopay.test.ts` (chat: `update_obligation` with `autopay` /
`paymentStatus`, loans included), `tests/autopay-scenarios.test.ts` (credit
card, weekly/quarterly/yearly, paused, month-end, reversals, extra principal,
paired payment bill, statement import).
*Live checks (deployed app, smoke account):* `npx tsx tests/live-autopay-check.ts`,
`npx tsx tests/live-autopay-scenarios-check.ts`.

**A1. Recorded on the due day, once.** `autopayDueOccurrence` is the only
answer to "what does Auto Pay record now": never before the due day, never for
a day before Auto Pay was switched on (`autoRecordSince`, stamped by the
storage layer whichever door flips the switch), never for an occurrence that
is paid, skipped or missed. The occurrence is claimed before the ledger row is
written, so a retry, a second run or a page load cannot add a payment. Only
the cron and the explicit `POST /api/autopay/run` (this user, same rule)
record; no screen does on its own (Rule 3). For a loan or card, "this cycle
is already paid" is `lastPaymentCoversCycle` (`shared/loan-facts.ts`): a late
or delayed payment belongs to the cycle it settled, and an extra-principal
payment is not the instalment. A loan whose "<loan> payment" bill is on Auto
Pay is recorded through the bill only; a one-time debt is recorded once.

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
Reversing a payment Auto Pay recorded (the Reverse button, deleting its
expense in Finance, chat's undo) marks it missed for the same reason: an open
occurrence would simply be recorded again by the next run
(`unpayBillOccurrence`; pass `reopen: true` only when the caller re-records
or sets its own state).

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
Needs Attention and raises no due-soon alert (`isQuietAutoPayBill`) unless
the user turned "Remind me anyway" on. A payment marked missed is the
exception that shows. Turning Auto Pay off stops future recording only.

**A7. A bill is not a task, and a list names its next date.** No bill ever
becomes a task: the due scan creates none and moves the "Bill due: <name>"
tasks it used to generate to Trash (`isGeneratedBillReminderTask`,
`shared/bill-reminders.ts` — the scan's exact fingerprint, never a task a
person typed or edited). A recurring bill's elapsed due date is ASSUMED PAID
(owner, 2026-11-21 for Finance, 2026-11-22 everywhere): every list, the bell
and the month's still-to-pay total read the bill through `rollBillsForward` /
`nextBillDate` (`shared/bills-timeline.ts`), so nothing shows "115d overdue"
or counts five months of a subscription in one month's Expenses. It is a READ
rule: the stored date still moves only on pay / skip / missed. The dashboard
Money card has no Pay button; a row opens Bills & Payments (`BillsDuePopup`),
the Finance tab's panel.
The walk steps over an occurrence already paid, skipped or marked missed
(`settledDates` on the obligation, from the bill's own stamps), because the
stored date does not move when a LATER date is the one settled. A plain "Pay"
(no date named) on a bill whose stored date is stale settles the date the lists
show (`shownOccurrenceToPay`, in the pay route) — never an old month with the
row left in place. An edit form writes a due date only when the user changed
it. The Liabilities list (`nextBillDateForFields`), the bill page header, the
calendar (a recurring bill's past date is not "late") and the AI advice count
read the same next date. Generated bill tasks are retired on the first read of
the task list as well as by the scan (`retireGeneratedBillReminderTasks`).
The bell removes dismissed ids BEFORE collapsing a record's notices, follows
the shared dismissed list after mount, and opening a dated alert from it does
not dismiss it.
*Guards:* `tests/bills-next-date.test.ts`, `tests/dismiss-stays-dismissed.test.ts`,
`tests/executive-sections.test.tsx`, `tests/bills-and-alerts-consistency.test.ts`,
`tests/bell-dismiss-shared.dom.test.tsx`.
*Live check:* `npx tsx tests/live-dashboard-consistency-check.ts`.
*Known gaps (2026-11-22):* the bill page's schedule still lists unrecorded past
dates as overdue (it is where one is recorded); chat's bill table and
"I paid X" still read the stored date; on a person, pet or account page "Clear
document alerts" still writes the browser-only 30-day snooze
(`ProfileAlertsSection.tsx`) — an asset's dismisses into the server list
(`AssetAlertMenuItems`).

## Record details rules (a characteristic is a typed, reportable value on any record)

Owner request 2026-11-21: "Condition = Good on my car" had nowhere to go but
free text. The detail layer lets the user define a characteristic once and
record it on any record. The rules are in `shared/record-details.ts`, the
operations in `server/record-details.ts`, the routes at `/api/details/*`
(`server/record-details-routes.ts`). The UI is `RecordDetailsPanel`
(`client/src/components/details/`) on the profile Info tab, the person Info
page, the liability Overview and the document Overview, plus the `/details`
page (report, catalog, flags).
*Guards:* `tests/record-details.test.ts`, `tests/record-details-routes.test.ts`,
`tests/chat-record-details.test.ts`, `tests/record-details-panel.dom.test.tsx`.

**D1. One definition per name, reused everywhere.** "Condition" on the car,
the house and the guitar is ONE definition (`findDefinitionByLabel`). Naming
an existing one reuses it and widens its scope to the new record's kind;
naming it with a different type is a 409, never a second "Condition".
**D2. Values are typed and validated, never a text fallback.** Every write goes
through `normalizeDetailValue` ("good" → "Good" on a condition scale; a
rating is a whole number on its scale; min/max are enforced). A value the
type can't hold is a 400 with the reason. The chat infers a new
characteristic's type from the library and the value (`inferDetailDefinition`),
never defaulting to text for something that is plainly a condition, number,
date or yes/no.
**D3. Storage is preferences rows, written under a lock.** `detail_definitions`
holds the catalog, `details:<entityType>:<entityId>` one record's values
(no table, no migration — the valuation precedent). Every read-modify-write
runs inside `withLock` and re-reads the row inside it (Rule 6). The generic
`PUT /api/preferences/:key` refuses these keys. Writes journal under the
`details` cache domain.
**D4. Flags are derived from the current value (Rule 5).** Rules
(`evaluateDetailRules`) and report filters share ONE comparison
(`matchesDetail`), so "flagged Fair or worse" and "show me Fair or worse" can't
disagree. No stored resolved state. `required` flags a record the
characteristic applies to that lacks it.
**D5. One source per value with profile fields.** Chat's `update_profile`
writes a field named like a DEFINED characteristic to that characteristic
(`divertDefinedDetails`) — unless the record already carries that key as a
field (moving one of two copies would leave them disagreeing), or the value
doesn't fit (then nothing is lost: it stays a field). With no characteristics
defined, `update_profile` is unchanged.
**D6. The panel never takes down its page.** An unexpected or failed response
is the panel's error state with a retry (Rule 7); removing a value takes two
taps (Rule 8); opening it writes nothing (Rule 3). Suggestions come from the
fixed `DETAIL_TEMPLATES` library for the record's kind, never random.
**D7. No separate Details box on record pages.** Owner, 2026-11-21: "delete
this, make this simple". New facts go through each page's own Add field.
Values already saved as characteristics show as plain cards
(`DetailValueCells`): tap to change, X (two taps) to remove. The catalog and
reports stay on `/details`. Never put the Details panel back on a record page.
**D8. Everything on the Info page can be changed and removed.** Age has no
field of its own: editing it moves the birth year (`birthdayForAge`,
`client/src/lib/profile-fields.ts`) and removing it removes the birthday;
Birthday has an X like every other field.
Asset and liability profiles have the same Add field (`AddFieldPanel`,
`client/src/components/AddFieldPanel.tsx`): on an asset what is added shows
in the Overview, where every field can be changed or removed (two taps); on a
liability the free-form fields are listed under it. Money, rate, date, switch
and schedule fields are never listed there as text (L2/L3).
*Guards:* `tests/info-tab-editable.dom.test.tsx`, `tests/add-field-panel.dom.test.tsx`,
`tests/overview-render.dom.test.tsx`.

## Asset profile layout (the owner's mock-up; a drawing of stores other screens read)

Owner, 2026-11-23 (second mock-up, replacing the tile layout of 2026-11-22):
"this is simpler and this is how I want the entire overview page", "the
current value is the one the AI estimates", "nothing loses connections",
"no empty spaces", "everything should be editable". An owned thing's page
(`usesAssetLayout`, `client/src/pages/profile-detail.tsx`; an account keeps
`AccountOverview`) is built from `client/src/components/asset/AssetOverviewLayout.tsx`:
`AssetHeroStats` in the `DetailHero` (`pageTitle`, `aside`: ONE header row —
back, picture, name and chips, the four figures, the ⋯ menu), `AssetQuickAdd`
beside the tabs, `AssetOverviewBody` (Asset Details | Characteristics + Quick
Info, then AI Summary | Value & Depreciation) and `AssetAlertMenuItems` in the
⋯ menu. Nothing sits under the two card rows: Edit, Ownership, Documents,
Clear / Restore alerts and Delete are the ⋯ menu ("remove all that space, make
it look exactly like the photo"). Read this before touching any of them.
*Guard:* `tests/asset-overview-layout.dom.test.tsx`.

**P1. The layout owns no data.** Rows, dates and "Not set" suggestions are the
composed `OverviewSpec` (through `DynamicOverview`'s `renderBody`, which keeps
the loading state and the fallback). A row writes ONE field with the page's
PATCH — the same field the chat's `update_profile` writes. Add a section by
reading a store that exists, never by storing a copy. Quick Info is only what
the app worked out (age from the purchase date, the composition's calculated
metrics, the next alert): never invent a figure such as a "useful life".
**P2. One current value.** The header, Value & Depreciation and the AI summary
all show `useValuePosition`: `currentAssetValue` (Rule 1) — the estimate while
Portol tracks the value, the user's own number once tracking is off — against
the purchase price. There is no separate value card at the top; how the
estimate was made, Refresh and the "Track value automatically" switch are the
`CurrentValueCard` under Value & Depreciation's disclosure.
**P3. Alerts are the rule engine's.** Quick Info's alert row and the menu's
"Clear alerts" are `useRecordAlerts`: `rulesFromAll` over the UNFLATTENED
profile row and its documents, filtered by `isAlertDateRule`, identified by
`dateAlertId` (the bell's id), cleared and restored through
`useDismissedAlerts` (Rule 8). Never the browser snooze.
**P4. Asset Details is one form, edited in line.** Owner, 2026-11-23: "make
it look exactly like this … everything's inline edit". Every value sits in its
own box and is typed into where it stands (`AssetDetailsForm`): Name, Purchase
Price and Date, Location, each date, Notes; Category is the composition's
label and Ownership opens the Contained tab. ONE **Save** (the owner's design,
as O6) sends only what changed in a single PATCH — a cleared box removes that
field, money is stored as a number — and writes it into the page's cache at
once; **Undo** puts back what was there; typing and opening write nothing
(Rule 3). **Edit** opens the full dialog. A date stored as something other
than a calendar day ("2024") stays a text box, so the form cannot lose it. A
characteristic (`CharRow`) has a pencil and an X (two taps, Rule 8). The page
is dense (32px rows, tight cards) and AI Summary shares ONE card with Value &
Depreciation. Only what the app calculated is read-only.
**P5. Quick add creates ordinary records.** + Task, + Expense and + Note post
to `/api/tasks`, `/api/expenses` and `/api/notes` with this asset linked, so
they show on the Tasks page, in Finance and under Notes too; More holds "Add
a date" and "Add a document". Delete only opens
the page's confirmation (Rule 8); opening the page writes nothing (Rule 3).
**P6. One finance tab.** Where a tab set has both, Money is merged into
**Financials** (rollup, breakdown, linked liabilities, the loan, bills and
expenses); a saved `/money` link opens Financials. Subscriptions and the other
sets that never had Financials keep Money.

## Recurring occurrence rules (one date at a time; the series keeps its schedule)

Owner request 2026-11-21 ("Mow the Lawn": skip December 15, January 15 stays).
Read them before touching `CalendarItemDetail` / `detail/EditSeriesScreen`
(`client/src/components/calendar/`), `shared/calendar-capabilities.ts`, the
task recurrence engine (`shared/recurrence.ts`) or the occurrence routes.
*Guards:* `tests/recurring-occurrence-actions.test.ts` (rule, adapters, real
routes), `tests/calendar-detail-redesign.dom.test.tsx` (the screens).
*Live check (deployed app, smoke account):* `npx tsx tests/live-recurring-occurrence-check.ts`.
The calendar grid opens the same screen (`GridDetailHost`); its old dialog is
only the fallback for an item the occurrence stream does not carry.

**O1. Skipping never deletes.** A skip is a mark on that one date (event:
`rd:skip:`; task: `rskip:`); the series steps over it and every later date
stays. Only "End series" / "Delete" (two taps, Rule 8) stop a series.
**O2. A moved occurrence does not re-anchor the series.** A task moved for
one date carries `rfrom:<scheduled date>`; the next occurrence steps from the
SCHEDULED date (`scheduledDateOf`). Never move one occurrence by PATCHing a
recurring task's `dueDate`.
**O3. Occurrence state is written on the stored row** (Rule 6):
`POST /api/tasks/:id/occurrence`, `POST /api/tasks/:id/schedule`,
`POST /api/events/:id/occurrence`, `POST /api/events/:id/series-settings`.
Never PATCH a rebuilt `tags` array from the client.
**O4. An action that does not apply is not on the screen.** What one date
offers is `occurrenceMenuFor` (a birthday: nothing; a task: only its open
occurrence can be completed). Never render a disabled button whose reason is
a tooltip. Each action says how far it reaches (`hint`).
**O5. History is derived** (`shared/occurrence-history.ts`) from the marks
and rows the series already has (Rule 5). No stored outcome table.
**O6. Edit happens where the schedule lives** (`editsInPlace`): an event and
a task are edited in the sheet; a bill, a profile's birthday and a document
date open their source. The edit form has a Save button (owner's design); it
writes nothing on open (Rule 3) and sends only what changed.

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
