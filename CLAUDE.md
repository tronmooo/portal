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
- **A merged migration is not an applied migration.** Twice a file in
  `migrations/` was never run on production and the code's "safe" fallback
  hid it (2026-11-09: two months of chat actions unrecorded; 2026-11-24:
  `trackers.linked_habit_id` and `auth_rate_limits` missing — a deleted habit
  left its tracker behind and the shared sign-in limit was not in force).
  Everything a migration adds is listed in `shared/schema-expectations.ts`;
  `GET /api/diagnostics/schema` names what the database lacks. After applying
  a migration, and after a deploy: `npx tsx tests/live-schema-drift-check.ts`.
  A fallback for a missing optional column must keep the feature working
  (`isMissingColumnError`), not switch it off.
  *Guard:* `tests/schema-expectations.test.ts`.
- **Every door into the app is in the workflow matrix**
  (`docs/WORKFLOW_MATRIX.md`, from `npx tsx scripts/gen-workflow-matrix.ts`):
  each API route, chat tool and screen with the tests that reference it. A
  new route or tool must be placed in a domain. Live workflow checks
  (`tests/live-*-workflows-check.ts`) share `tests/helpers/live-workflow.ts`.
  *Guard:* `tests/workflow-matrix.test.ts`.
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
   **Text written ABOUT the dashboard is held to its counts.** The AI summary
   (`POST /api/ai/summary`) is given `briefingFacts` (`shared/dashboard-briefing.ts`):
   the tiles' own counts (`countTasksByDay`, today's events, the snapshot's
   bills), from lists that must be present — a missing list throws, it is never
   a zero. `reconcileBriefing` replaces a paragraph that denies a non-zero
   count with the plain facts, and the cache key carries the facts'
   fingerprint. (2026-11-24: "no tasks, overdue items or events" beside
   "7 tasks due, 1 late" — the route counted keys the payload never had.)
   *Guard:* `tests/qa-2026-11-24-dashboard-calendar.test.ts`.
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
   A field is an expiration for what it says ENDS, not for the noun it starts
   with: `warrantyStartDate` (purchase, registration, effective…) is
   informational (`WARRANTY_ORIGIN_RE`). (2026-11-24: a tyre warranty read
   "Expired" from its start date.)
   *Guards:* `tests/sync-rules-notifications.test.ts`,
   `tests/qa-2026-11-24-dashboard-calendar.test.ts`.
6. **No stale overwrite.** Don't merge an older row over a newer one
   (`isOlderRow` in `client/src/lib/cache-patch.ts`). Don't do a client
   read-modify-write of a whole array (tags, lists): add a server endpoint
   that applies the change to the stored row, like
   `POST /api/events/:id/occurrence`.
   **A PATCH carries only what was sent.** Every PATCH route validates its
   body with `parsePatch(insertXSchema, req.body)` (`shared/schema.ts`), never
   `schema.partial().safeParse(body)`: on zod 4 a bare partial fills in every
   field that has a `.default()`, so a rename would also write `tags: []`,
   `fields: {}`, `extractedData: {}`, `linkedProfiles: []` over the stored
   values. (2026-11-23, caught while upgrading zod 3 → 4, before it shipped.)
   **A date is saved whole or not at all.** A native date input reports a
   value on every keystroke (typing 2026 reports years 2, 20, 202 first) and
   "" while any part is blank. A date field that SAVES is a `CommitDateInput`
   (`client/src/components/CommitDateInput.tsx`): a whole day commits, a
   half-typed one is held, "" clears. Never `onChange={e => mutate(e.target.value)}`
   on `type="date"`. A form that saves on submit refuses a half-typed date
   (`dateInputState(...) === "partial"`, `client/src/lib/date-input.ts`) rather
   than filing the record with no date. (2026-11-24: the task editor sent
   "0002-11-25", got a 400 and reset; the task stayed Unscheduled. Same day,
   the profile Edit dialog autosaved Next Billing as 0002-, 0020- and
   0202-12-12 on the way to 2026 — its date fields are `CommitDateInput` now,
   `tests/edit-profile-dialog-save.dom.test.tsx`.)
   **The Calendar and the task agree.** A task's occurrence is done by
   `isTaskOccurrenceDone` (`shared/task-occurrences.ts`): an undated task is
   done when its row is. A task with NO due date is not on the Calendar or
   the Executive Timeline at all (`getCalendarTimeline` skips it; it lives in
   the task list as Unscheduled) — QA 2026-11-24, second pass: drawn as an
   all-day item on the day it was added, beside a row saying "No due date".
   The open detail renders the LIVE timeline row (`liveTimelineItem`), not the
   snapshot from the tap — found again by `type` + `sourceId` when an edit
   moved it (the id carries the date). Moving an event's start moves its end
   date with it (`carryEventSpan`, `shared/event-span.ts`, both storages).
   (2026-11-24: an event with an end date could not be moved, and a moved
   event's open detail still read "November 24".)
   *Guards:* `tests/sync-rules-valuation*.test.*`, `tests/sync-rules-followups.test.ts`,
   `tests/patch-keeps-unsent-fields.test.ts`, `tests/commit-date-input.dom.test.tsx`,
   `tests/qa-2026-11-24-date-edits-persist.dom.test.tsx`,
   `tests/qa-2026-11-24-dashboard-calendar.test.ts`.
   *Live check:* `npx tsx tests/live-task-date-and-calendar-check.ts`.
7. **A failed request is not an empty account.** No `queryFn` may turn a
   failure into `[]`/`null`. Let React Query keep the last good data.
   The server holds the same rule: a list a payload embeds is read with a
   helper that THROWS on a query error (`rowsOrThrow` in `getProfileDetail`),
   never `r.data || []`. A list still loading has no count either: say
   "Loading…", never "0 items" (Artifacts, 2026-11-24).
   **A saved snapshot is a first paint, not the truth.** The query cache is
   saved to localStorage and restored on reload (`hydrateQueryCache`,
   `client/src/lib/queryClient.ts`). The LISTS it restores are re-seeded by
   the bootstrap refetch; ONE record's page is not, so a per-record entry
   (`isRecordScopedPersistKey`: `["/api/profiles", id, …]`) is restored with
   its real age and marked invalidated, and its page refetches on mount. Any
   new persisted key that the bootstrap does not re-seed needs the same.
   The snapshot also keeps a write's INVALIDATION (`inv`): a write only marks
   the bootstrap stale off the dashboard, so a bootstrap saved invalidated is
   refetched at launch and the lists seeded from it are first paint only; the
   list the write patched is saved beside it and restored in its place
   (`overlayKeysForStaleBootstrap`). (2026-11-24: a logged run and a one-cent
   expense vanished on the first reload and came back minutes later.)
   (2026-11-24: an expense and a nested asset added from chat showed in
   Finance and Assets, while the asset's own Financials and Contained tabs
   said "No expenses logged" / "No child assets yet" — and still did after a
   manual refresh, because the refresh restored the old page as fresh.)
   *Guards:* `tests/sync-rules-failed-request.dom.test.tsx`,
   `tests/persisted-record-cache.test.ts`, `tests/persisted-write-reload.test.ts`,
   `tests/qa-2026-11-24-findings.test.ts`,
   `tests/qa-2026-11-24-findings.dom.test.tsx`.
   *Live check (real browser, smoke account):* `npx tsx tests/live-qa-2026-11-24-check.ts`.
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

11b. **An edit re-derives what was derived.** Pace, speed, steps and the
    calorie estimate the engine filled into an entry (its provenance,
    `computed.enrichment`) are the engine's until the user changes THAT
    figure: `updateTrackerEntry` drops every derived value the edit left
    alone and derives it again from the edited entry (`rederiveEditedEntry`,
    `shared/entry-rederive.ts`, both storages). The edit form sends every
    field it shows, so merging them back stored the old figures as if typed.
    The form writes the server's row into the lists on success. (QA,
    2026-11-24: a run changed from 1.25 to 1.5 miles kept "11:12/mi · 5.36
    mph" in its history row while the card said 9:20.)
    *Guard:* `tests/tracker-entry-rederive.test.ts`.

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

**L0. The page is the owner's design.** (Owner, 2026-11-23: "let's make it
look more like this"; it replaced the 2026-11-22 card layout.) The header is
ONE card (`DetailHero`'s page layout, `pageTitle`): back, picture, the
"Liability Profile" tag, the name, chips (type menu, lender, owner) and the
four headline figures at the right — Balance / Payment / APR / Payoff for a
debt, Amount / Next due / Frequency / Status for a bill (never APR or payoff
on a bill). Six tabs — Overview, Payments (Auto Pay, quick actions, history),
Schedule (every date, then the amortization table), Cost of Ownership (payoff
outlook, cost of borrowing, calculator), Documents, History (activity, then
record changes) — beside the quick-add row: + Payment, + Expense, + Task,
+ More (document, characteristic, owners & linked records, Ask Portol, delete).
The Overview is Liability Details (a label | value form), Characteristics,
Quick Info, and the AI Summary beside Balance & Payoff
(`components/liability/LiabilityOverviewCards.tsx`, presentation only: every
figure is one the page already derives, Rule 1).
Nothing on it is a dead end or a blank (owner, 2026-11-22: "no empty spaces,
everything editable, everything able to be added"):
- Liability Details edits IN PLACE: Edit, a tap on any value, a header figure
  or the name turns the card into inputs holding the stored values. The terms
  save themselves (L7: `useAutosave`, only what changed, nothing on open); the
  name and notes are written when their box is left and on Save, once. Save
  finishes (it waits for the pending save); Undo puts back what the form
  opened with. Starting an edit never resets a form that is already open.
- A fact the record lacks reads "+ Add". The type is changed by writing
  `type_key` (L4). The payoff date is calculated, so it has no input.
- A payment the record does not store is never printed from the engine's
  360-month assumption; with no rate or payment the payoff figures say what
  to add instead of a guess (`canProject`).
- Characteristics is the plain Add field (D7), drawn as label | value |
  pencil | X lines (`AddFieldPanel` `list`). A field the user adds is always
  listed: only a key the screens own, or a figure/date stored as text, is kept
  out — never a name that merely sounds financial ("Loan number: HF-88213"
  was saved and shown nowhere, `freeFormFieldEntries`). The app's own
  bookkeeping (`source: "obligation"`, `obligationId`, any bare record id) is
  never listed (`isProvenanceField`).
- Owners, linked assets and people, nested debts and the composed facts open
  from the owner chip / More menu (`dialog-links`). When the AI summary has
  nothing to draw, the card beside it takes the row. A count or list from a
  failed request reads "Couldn't load", never empty (Rule 7).
- "Ask Portol about this" opens chat with the liability named
  (`portol_chat_prefill`); + Expense files a cost under the liability and
  + Task links the task to it.
*Guards:* `tests/liability-profile-design.dom.test.tsx`, `tests/add-field-panel.dom.test.tsx`,
`tests/bill-payments-tab.test.ts`.
*Live check (real browser, smoke account; loads, edits in place, adds a
characteristic / expense / task, Auto Pay, every tab, a change made from the
app's chat, delete):* `npx tsx tests/live-liability-profile-check.ts` (to check
an undeployed client against the deployed API:
`SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me`).

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
That includes WHERE a record sits: the parent named in a confirmation is the
saved row's own parent (`verifyProfileWrite` → `FieldReceipt.parentName`,
"Assets → Tutorial Camera → 50mm Lens"), and the model's line about placement
is dropped (2026-11-24: chat named a different parent than the lens had).
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
pending save before closing. The Edit dialog has ONE save chain: Done joins
a save already on its way, a failed save keeps the dialog open ("Close
without saving" on the second press), and leaving the page with a save
pending warns (QA 2026-11-24: a plan changed, Done, reload — the old plan). A saved edit is written into the profile-detail
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

## Workspace rules (full-screen tools opened from AI Chat)

Owner request 2026-11-22: "each opens its own dedicated, full-screen workspace
… not four versions of the same chat box". The chat box's **Notes, Journal,
Word and Fill In** buttons navigate (`WORKSPACES`,
`client/src/components/workspace/WorkspaceShell.tsx`); they are not modes of
the chat box. Read these before touching that file, `pages/workspace-*.tsx`,
`pages/editor.tsx` or `server/workspace-ai.ts`.
*Guards:* `tests/chat-workspace-buttons.dom.test.tsx`, `tests/workspace-notes.dom.test.tsx`,
`tests/journal-workspace.dom.test.tsx`, `tests/note-markdown.test.ts`,
`tests/doc-rich-content.test.ts`, `tests/workspace-ai.test.ts`,
`tests/workspace-editors-mobile.dom.test.tsx`.
*Live check (deployed app, smoke account, real browser):* `npx tsx tests/live-workspaces-ui-check.ts`.

**W1. Full screen means the whole window.** A workspace is mounted on
`<body>` (`WorkspacePortal`): the app's layout is a centred max-width column,
and a fixed box inside it does not reach the window's edges. While one is open
`useFullScreenWorkspace` marks `<html>`/`<body>`, which hides the floating
chrome (`data-app-floating`) and releases the desktop scrollbar gutters. Stay
at `z-40`: menus and dialogs opened inside a workspace portal at `z-50`.
The app behind an open workspace is covered, so it is also `inert`
(`data-app-shell`, set and handed back by `useFullScreenWorkspace`): its
sidebar links are out of the tab order and the accessibility tree. (2026-11-24:
"Dashboard" / "Artifacts" were found behind the Fill In workspace, clicked at
their position, and nothing happened.) A workspace's last step is never a dead
end: Smart Fill's "done" offers "Show the saved copy", which opens that
document (not the Artifacts list, where the profile filter can hide it).
**W2. The X saves, then leaves; it never discards on its own.** Each
workspace hands `WorkspaceCloseButton` a function that flushes what is pending
and then goes to `/chat`. A failed save keeps the workspace open: the
`onClose` answers `false` and the header shows `UnsavedLeaveBar` ("Keep
editing" / "Leave without saving") — the only way out with unsaved work, and
only after that warning. Closing the browser tab with work unsaved warns
(`useUnsavedWarning`).
**W11. One phone layout for the three editors** (owner, 2026-11-23: "compact,
mobile-friendly, unlimited-length"). The header is `WorkspaceHeader` (the
Document editor draws the same pieces): the title and its save status, then
**Save** and the **X at the upper right** (owner, 2026-11-25: "an X in the
upper-right corner to return to Chat"; it was at the left before — do not move
it back) (`WorkspaceSaveButton`: never hidden,
disabled only while there is nothing to save, "Saved" when it lands; the
tap and the autosave share one save chain, so they make ONE record). Under it
ONE scroll area (`data-workspace-scroll`) holds the compact options (date,
mood chips, category, tags, attach, delete) and a writing area that GROWS
with the text (`useAutoGrow`; never a box with its own scrollbar, never
`flex-1` on the textarea — that pins its height). A row of controls that can
be wider than a phone scrolls sideways inside itself and carries
`data-swipe-ignore` (T1). The frame follows the VISUAL viewport
(`useVisualViewportBox`), so the header stays on screen and the bottom bars
ride above the keyboard; the Ask AI bar steps aside while the keyboard is up
for the writing. An open workspace adds `maximum-scale=1` to the viewport
meta so iOS does not zoom into a small field (that zoom was the sideways
scroll); option fields carry `ws-field` / `ws-title` to keep their size.
No body text has a length cap: journal and note bodies are cleaned with
`sanitizeLongText` (`LONG_TEXT_MAX`, `server/routes.ts`), never the 10,000-
character `sanitize` (2026-11-23: a long entry was cut at 10,000 characters
and the save reported success). Attach (`AttachMenu`) offers the photo
library, the camera and any file, several at once: a journal entry points at
photos (`photo:`) and files (`file:`, `journalFileIds`); a note links them in
its text (W8; `removeAttachmentLink` takes one out); a document puts a
picture in the page and links any other file, listed under the text.
*Guards:* `tests/workspace-editors-mobile.dom.test.tsx`, `tests/journal-entries-routes.test.ts`.
*Live check (three phone widths, touch, smoke account):* `npx tsx tests/live-editors-mobile-check.ts`.
**W3. Opening writes nothing (Rule 3); typing does.** Notes creates the note on
the first text and updates THAT note after; Journal creates one DRAFT entry,
then updates it, and titles an untitled entry only if it was written in this
sitting (opening an old entry and leaving writes nothing); a new document
saves itself once it has content. EVERY document autosave leaves the URL alone
(`quietSaveRef`: the route change remounts the editor and drops the caret —
2026-11-23, the second autosave reloaded the page mid-typing); only the Save
button moves it. A new sheet still waits for its first Save. A save that comes back after the
editor has closed never navigates (`stillOnNewEditor`): Save, then Calendar,
reopened the document over the Calendar (QA 2026-11-24, second pass).
Loading a document is not an edit: the editor takes the saved content ONCE per
document and without an update event (`setContent(…, { emitUpdate: false })`;
TipTap 3 emits by default), and a refetch of the saved copy never re-hydrates
the page. (2026-11-24: a saved document, reopened, said "Unsaved" and then
autosaved itself.)
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
**W8. A note is markdown; the rich editor is a view of it.** Chat, search and
every list read a note's text, so it stays markdown. The Notes workspace
edits it as rich text through `markdownToNoteHtml` / `noteDocToMarkdown`
(`shared/note-markdown.ts`): check lists are `- [ ]` / `- [x]`. A note holding
what the editor cannot show (a table, a picture, raw HTML —
`noteNeedsPlainEditor`) opens as plain markdown, so editing never drops it.
Never store editor HTML in a note, and offer no formatting markdown cannot
hold (no underline). A category is the note's one `category:<name>` tag; an
attachment is a file saved to Documents and linked from the text
(`#/documents/<id>`). The category filter is a view: it names what it hides
and is never stored (Rule 4).
A saved note opened from Artifacts has Edit, which opens THAT note in the
Notes workspace (`#/workspace/notes?note=<id>&from=artifacts`; the X goes back
to Artifacts). *Guard:* `tests/qa-2026-11-24b-findings.dom.test.tsx`.
**W9. A journal photo is a document the entry points at.** `photo:<documentId>`
tags (`shared/journal-photos.ts`), written by the composer that owns the
entry; the entry's own tags never include them on screen (`journalLabels`).
The Journal workspace is its own screen (`pages/workspace-journal.tsx`) over
the same journal API as the page and chat (J1, J2, J8 hold).
**W10. What a document may hold is one list.** Tables, pictures and alignment
are saved through `cleanDocHtml` (`client/src/lib/doc-html.ts`): the tag list
in `shared/page-setup.ts`, a `style` cut down to its text alignment, a picture
only when embedded or https. Page setup (paper, orientation, margins) is ONE
scalar on the doc, in its `language` metadata field (`serializePageSetup`);
the page, the PDF and the Word file are all drawn from it. A picture never
goes to the AI: it travels as a `[[PICTURE n]]` marker and is put back, or
appended if the model dropped it (`picturesToMarkers` / `markersToPictures`).
*Not built (2026-11-23):* resizing pictures and column widths, headers/footers
and page breaks in the editor; a table button on the phone toolbar;
pictures inside notes; Word and spreadsheet forms, and online (browser) form
filling, in Fill In; a Computer mode.

## Workspace app rules (Notes, Journal and Word are full applications behind three small buttons)

Owner request 2026-11-25: "maintain a minimal Chat interface while providing
three powerful, fully developed applications behind three small buttons". The
chat box's buttons read **Notes, Journal, Word** (the key of Word stays
`document`; Fill In is unchanged). Each opens a full-screen app with its own
tab strip (`WorkspaceTabs`, `client/src/components/workspace/WorkspaceApp.tsx`):
- **Notes** (`pages/workspace-notes.tsx`, tabs in `components/workspace/NotesTabs.tsx`):
  All Notes, Editor, Categories, AI Assistant, AI Insights, Favorites.
- **Journal** (`pages/workspace-journal.tsx`, `components/workspace/JournalTabs.tsx`):
  New Entry, Past Entries (list or calendar), Reflection Coach, AI Insights,
  Trends, Guided Journaling, Personal Growth.
- **Word** (`pages/workspace-word.tsx`): My Documents, Editor, Templates, AI
  Writer, AI Review, Version History. The Editor tab IS the document editor
  (`pages/editor.tsx`, opened with `?source=word`), which draws the same tab
  strip (`WORD_TABS`, `components/workspace/WordTabs.ts`).
Add no main navigation tab and no dashboard card for them. The Workspace rules
above (W1–W11) hold inside every tab. Read these before touching those files,
`server/workspace-intel.ts`, `server/content-versions.ts` or the `shared/`
modules each rule names.
*Guards:* `tests/workspace-rules.test.ts` (the pure rules),
`tests/workspace-intel.test.ts` (the AI functions over a mocked model),
`tests/content-versions-routes.test.ts` (the real routes),
`tests/workspace-apps.dom.test.tsx` (Notes and Journal),
`tests/word-workspace.dom.test.tsx` (Word).
*Live check (deployed app, smoke account, phone touch and desktop):*
`npx tsx tests/live-workspace-apps-check.ts`.

**WA1. A tab is a view; the editor stays mounted.** The Editor / New Entry tab
is hidden, not unmounted, while another tab shows: what is being written is
never dropped by looking elsewhere, and its autosave keeps running. Walking
through every tab writes nothing (Rule 3). A tab's list comes from the one
query the page already has; a failed list is an error with a retry on EVERY
tab that reads it (Rule 7) — written with `listGate(...) ?? content`, where
the gate is a function that answers null. Never test a JSX element with `??`:
an element is never null, and the list is then never drawn (caught by the
tests the day it was written).
**WA2. What an AI may read is the writer's switch, enforced where the prompt
is built.** One preference row (`workspace_ai_access`,
`shared/workspace-access.ts`). The SERVER reads it before it loads anything
(`readAiAccess`; `gatherFacts` in `server/workspace-ai.ts`): a switch that is
off means that data is not loaded for that call, whatever the client sends.
Defaults: each app reads its own records; everything that crosses from one
kind of record to another is OFF (the rest of Portol for Notes; sleep /
exercise / tasks / calendar for Journal; notes, assets and the journal for
Word) except what the Document AI always had (the writer's profile and saved
documents). **Journal text reaches no other app's AI by default**: the Notes
AI has no journal switch at all, and Word's is off until turned on. A new
source is a new switch in `WORKSPACE_AI_ACCESS_LABELS`, default off. The panel
(`AiAccessPanel`) never writes over a row it has not read (`ready`).
**WA3. Every AI tab answers or proposes; none writes a record the person owns
(W5).** The routes are in `WORKSPACE_AI_PATHS` (read-only POSTs) — except the
two conversations (`/notes/chat`, `/journal/coach`), which with remembering on
save to the AI's OWN memory row and nothing else (WA13). Insights, growth, prompts, categories
and the review are asked for on a TAP, never on opening a tab. A category the
AI suggests is filed only by "File under…" / "Apply all"; an AI draft or
revision becomes a document only when the user opens it in the editor.
**WA4. A structured AI answer is grounded before it is shown**
(`shared/workspace-intel.ts`). The model sees notes as labels (`[N1]`), never
stored ids. A note an insight names must be one that was sent; a day a journal
observation cites must be a day that has an entry; a passage a review quotes
must be in the document — otherwise the reference (and an item left with
nothing to stand on) is dropped. Open check-list items and a document's blanks
are COUNTED from the text, never asked of the model. A failed or unusable
answer is an error with a retry, never an invented result.
**WA5. The reflection AI is a companion, not a therapist.** Its instructions
and the line shown with every answer (`REFLECTION_BOUNDARY`) say it does not
diagnose or treat and point to emergency services / a crisis line. It speaks
only from the writer's OWN entries (`journalEntriesFor`; never another
profile's), never rewrites one, and tracker readings reach it as numbers by
day, never a tracker's notes. Do not soften that boundary or add advice about
treatment or medication.
The coach TALKS like a person (owner, 2026-11-25: "make it human"): plain
words, short replies, listens before it suggests, one question at a time, no
therapy jargon, uses what it remembers the way a friend would. That voice is
the `COACH` prompt; the limits in it "do not bend" and it never pretends to be
human when sincerely asked. Warmth is not a reason to loosen a limit.
It WORKS the way a good therapist does (owner, 2026-11-25: "work like an
actual therapist") — the craft, in "HOW YOU WORK": picks up the thread and
asks how a planned step went, reflects before asking, goes one level deeper,
names patterns and exceptions with their days, helps look at a harsh thought,
explores both sides, slows down into a grounding exercise a step at a time,
helps choose one small step and remembers it, wraps up a session. The craft is
used, not announced, and it changes nothing in WA5: it is still not a
therapist, does not diagnose or treat, and says so. The conversation has a
"Wrap up this session" button, and each reply can be saved to the journal by
the PERSON's tap (a new entry titled "Reflection with my coach"; once per
reply) — the coach itself still writes no entry.
**WA13. The coach and the Notes assistant remember; the person is in charge of
what they keep** (owner, 2026-11-25: "the memory for the AI therapist … have
to talk about it"). Per assistant, one preferences row (`ai_memory:<app>`,
`shared/ai-memory.ts`, `server/ai-memory.ts`; the generic preferences route
refuses the prefix): the CONVERSATION (so it is there again next time; the
server sends the history IT saved, never the one the screen sends) and
MEMORIES — short things the person said. The model proposes memories in a
`REMEMBER: [...]` tail that is always stripped from what is shown
(`splitReplyAndMemories`); a duplicate is not kept twice, and a label the AI
came up with is never kept (`looksClinical` — what the person says about
themselves is theirs to keep). Being remembered when you ASK does not depend
on the model: "please remember that …" with no proposal from the model is kept
in the person's own words (`explicitMemoryRequest`; a question about its
memory is not a request) — on the preview the model twice volunteered nothing
for exactly that message. A failed answer saves nothing, and a forget always
wins: a reply already on its way when the person clears the conversation or
forgets everything is not saved afterwards (`clearedAt` / `clearedSince`). Every memory is
on screen (`MemoryPanel`): the person can add their own, forget one or
everything (two taps, Rule 8), and start a new conversation (two taps; the
memories stay). One switch (`memory` in AI access, on by default — it is the
AI's own record, nothing crosses from another kind of record) turns it off:
then nothing is saved and nothing recalled, and the screen says so. A memory
belongs to ITS assistant: the coach's never reaches the Notes assistant,
insights, growth or the Document AI. A memory that could not be loaded is an
error with a retry, never "nothing remembered" (Rule 7).
*Guards:* `tests/ai-memory.test.ts`, `tests/workspace-intel.test.ts`,
`tests/workspace-apps.dom.test.tsx`.
**WA6. How an entry felt.** Energy is the entry's own `energy` column (1–5;
`PATCH {energy: null}` takes it off). Stress and the named emotions ride in
its tags (`stress:<1-5>`, `emotion:<name>` from the fixed `EMOTIONS` list,
`shared/journal-feelings.ts`), like its photos (W9): written by the composer
that owns the entry, never shown among its labels. Trends are computed from
the entries on read (Rule 5): a day's figure is the average of that day's
entries, a day with no reading is a gap in the chart (never a zero), a
direction is stated only from `MIN_TREND_DAYS` days, and the range names the
entries it leaves out (Rule 4). A pattern is a description, not a diagnosis.
**WA7. Version history is kept by the server, one version per sitting.**
`PATCH /api/notes/:id`, `/api/journal/:id` and `/api/artifacts/:id` keep the
text a save REPLACES (`keepVersionBeforeWrite`, `server/content-versions.ts`;
the rule is `keepVersion`, `shared/content-versions.ts`): not on every
autosave — one per `VERSION_MIN_GAP_MS`, at most `VERSION_MAX_COUNT`, bounded
in size. Stored as a preferences row per record (`versions:<kind>:<id>`; the
generic preferences route refuses the prefix). Restoring
(`POST /api/workspace/versions/:kind/:id/restore`) takes two taps (Rule 8),
replaces the TEXT only, and keeps what it replaces first, so a restore can be
undone. Deleting the record deletes its versions. Keeping a version never
fails the save it rides on.
**WA8. One write to the stored row (Rule 6).** A favourite is the note's own
`pinned` flag (`PATCH /api/artifacts/:id {pinned}`). Filing a note from a list
sends `{category}` alone and the server applies it to the note's STORED tags
(`updateNote`); never PATCH a rebuilt tag array for a note that is not the one
open in the editor.
**WA9. Word hands content to the editor; it does not save it.** "Use
template", "Open in the editor" and an accepted AI revision pass the HTML to
the editor once (`setWordSeed` / `takeWordSeed`), and the EDITOR saves it as it
saves anything typed (a revision of a saved document waits for that document,
`forId`, and the server keeps the text it replaces). A template
(`shared/doc-templates.ts`) is structure only: every personal detail is a
`[Missing: …]` blank (W6), never an example value, and a contract template
says it is not legal advice.
**WA10. The address keeps where the editor was opened from.** `source=chat` /
`source=word` is read from the HASH. Navigate with `hashNavigate`, not the
router's `setLocation`, whenever the path carries a `?…`: the router moves the
query out of the hash, and the editor then forgot it had come from Chat or
Word (2026-11-25: a Word tab picked in the editor opened the workspace with
no tab and no document; after the first Save the X left for Artifacts).
**WA11. What was last open comes back; a draft on the device is offered.**
The last tab and record are per-device conveniences in the browser
(`rememberLastOpened`): Notes reopens the last note, Word the document last
open in the Editor, Journal only an entry dated TODAY (reopening an older day
would put today's words into it). Reopening writes nothing. While writing is
not on the server it is also kept in the browser (`useDraftRecovery`) and
dropped when the save lands; one found on opening is OFFERED (Restore /
two-tap Discard), never applied, and is dropped unasked when the server
already has that text.
**WA12. Dictation is the browser's.** `DictateButton` is shown only where the
browser can dictate (never a dead button, O4); what is spoken is typed into
the editor like any other text.
*Not built (2026-11-25):* Word's AI Writer has no memory (it is not a
conversation); a memory cannot be edited in place (forget it and add the
corrected one); semantic search (search is text matching); pictures and
tables inside the rich note editor (a note holding them still opens as
Markdown, W8); folders nested inside folders; the coach reading notes; a
separate "stress" tracker (stress is what the writer sets on an entry); real-
time co-editing; headers, footers and page breaks in Word.

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
Bills & Payments also lists each loan's or card's next payment and its
recorded payments (`debtPaymentRows`, `shared/debt-payments-timeline.ts`),
read through the Calendar's own `deriveScheduleFields` → `generateSchedule`,
so the panel and the grid name the same day; a loan instalment is never
"assumed" paid. The Executive Money card lists that timeline's Upcoming rows
(QA 2026-11-24: "Nothing due in the next 30 days" beside the auto loan's
payment on the Calendar). *Guard:* `tests/bills-timeline-debts.test.ts`.
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

## Asset profile layout (the owner's design; a drawing of stores other screens read)

Owner, 2026-11-23, final round, with three pictures and their order: the
Value card, then the AI summary, then a plain details list — "we're gonna
simplify this completely. Everything else, delete [from] the overview tab."
(Earlier the same day: "everything's just too big … just say Honda CRV and
the value", "any attached photo should be barely anything".) An owned thing's
page (`usesAssetLayout`, `client/src/pages/profile-detail.tsx`; an account
keeps `AccountOverview`) is built from
`client/src/components/asset/AssetOverviewLayout.tsx`. Read this before
touching it.
*Guard:* `tests/asset-overview-layout.dom.test.tsx`.
*Live check (deployed app, smoke account, real browser):* `npx tsx tests/live-asset-overview-check.ts`.

**P0. A slim header, then three things.** `DetailHero layout="slim"`: back ·
a 28px picture (still the photo picker) · the name · the current value
(`AssetHeroValue`) · the ⋯ menu (Edit, Ownership, Documents, Clear / Restore
alerts, Delete). The Overview is these three things and nothing else, shown
**Asset details first, then the AI summary, then Value & Depreciation**
(owner, 2026-11-23: "Asset details should be the first thing you see … then
summary then evaluation"):
1. **Value & Depreciation** (`ValueCard`) — says HOW MUCH it has depreciated:
   one bar that is the purchase price, filled by what has been lost, with the
   amount and percent (with no purchase price it asks for one). Under it:
   when it was last valued (and "couldn't update — showing the estimate from
   …" when a run failed); the **value graph** — the purchase, every stored
   valuation and today on a real time axis, with 1M / 3M / 1Y / All and the
   range's first and last points named (the owner called the undated,
   unlabelled sparkline "a random graph"; a range with under two points says
   so instead of drawing one); the latest change between two different
   values; and a one-year projection only when there is enough to say so
   (`projectDepreciation`, `shared/asset-depreciation.ts`: a dated purchase,
   six months owned, a value that fell, a plausible rate; never below the
   salvage value). No confidence figure here. Then the money lines: Purchase
   price, Current value, Total invested and **Salvage value**, plus Refresh
   and the estimate's details and tracking switch under the disclosure.
   **The salvage value is the lifecycle engine's** (owner, 2026-11-24): see
   "Asset lifecycle rules" below. A figure the user types (page or chat:
   `stampSalvageProvenance`, `shared/asset-salvage.ts`) is theirs and never
   replaced; removing it hands it back. Under the money lines sits the
   lifecycle section (`LifecycleSection`); the graph's "All" range adds the
   projection (dashed), the salvage line and the best time to sell.
2. **AI Asset Summary** (`AISummaryCard compact`) — a title and the text. The
   text is three short sentences: what it is worth, how much it has
   depreciated, and WHEN it would make sense to sell or replace it, with the
   reason (`withAssetSummaryShape`, `shared/asset-summary-prompt.ts`). No
   figure tiles, no to-do list, no Look up value; no card when there is no
   summary.
3. **Asset details** — ONE list (`Line`): label left, value right, a pencil.
   Name, Category, every characteristic, Purchase date, Location, each date,
   Ownership, Notes, then "+ Add characteristic". (Purchase price is the
   Value card's.)
Do not put Quick Info, linked sections, a separate Characteristics card,
recent activity or a boxed form back on the Overview: those are the other
tabs' (Financials, Contained, History). The page keeps only what would
otherwise be unreachable: saved characteristic cells (`DetailValueCells`, D7)
and, when the asset has no Trackers tab, its trackers card (`tailSlot`). The
document count is on the Documents tab; the parent trail and tags are a small
line under the tabs (`asset-trail`).

**P1. The layout owns no data.** Lines and dates are the composed
`OverviewSpec` (through `DynamicOverview`'s `renderBody`, which keeps the
loading state and the fallback). A line writes ONE field with the page's
PATCH — the same field the chat's `update_profile` writes. Add a line by
reading a store that exists, never by storing a copy; never invent a figure.
**P2. One current value, kept current without being asked.** The header and
the Value card both show `useValuePosition`: `currentAssetValue` (Rule 1) —
the estimate while Portol tracks the value, the user's own number once
tracking is off — against the purchase price. Saved figures paint at once;
then (owner, 2026-11-23: "automatically refresh whenever I open …"):
- **Opening a profile** asks for a current estimate when the stored one is
  stale OR the asset is tracked and has not been checked in the last DAY
  (`refreshOnOpen`, `SWEEP_RECHECK_MS`, `client/src/hooks/useAssetValuation.ts`).
  A day, not minutes (owner, 2026-11-23: "everything is just taking way too
  long"): one estimate is ~40 s of live web research. Refresh runs one now.
- **Opening the Assets tab** re-values every tracked asset
  (`useAssetsValuationSweep`: bounded concurrency, one run shared by every
  mount, each result patches its own card and the totals as it lands), then
  re-writes the AI summary of each asset whose estimate CHANGED
  (`refreshSummaries`, two at a time) so it is ready before its profile opens.
- Both share one in-flight map, one per-asset attempt throttle and the same
  one-day window, so the tab followed by a profile asks once. A manual
  asset is never re-estimated; a failed run keeps the last estimate (Rule 7).
- **History holds real moves** (`appendValuationHistory`): a run that reached
  the same estimate as the last entry adds no point. Two runs of the same
  research land a little apart, so a move under 2% with unchanged inputs is
  noise (`isValuationNoise`, `server/valuation/service.ts`): the stored figures
  are kept, and nothing is mirrored, charted or re-summarised.
- **The asset summary is the small request** (`slimAssetSummaryData`,
  `ASSET_SUMMARY_FAST_MODEL`, `shared/asset-summary-prompt.ts`): a fast model,
  the text only, the recent part of the record. While one is being rewritten
  the card says "Updating summary…" over the text it still shows.
Never add a second refresh path, a per-screen timer or an unconditional
summary regeneration: extend these.
*Guards:* `tests/asset-value-refresh.test.ts`, `tests/use-asset-valuation.dom.test.tsx`.
**P3. Alerts are the rule engine's.** The menu's "Clear alerts" is
`useRecordAlerts`: `rulesFromAll` over the UNFLATTENED profile row and its
documents, filtered by `isAlertDateRule`, identified by `dateAlertId` (the
bell's id), cleared and restored through `useDismissedAlerts` (Rule 8). Never
the browser snooze.
**P4. A line is edited where it stands.** The pencil turns the value into an
input; the check writes it (money as a number; `name` and `notes` are the
record's own); the remove button takes two taps (Rule 8); typing and opening
write nothing (Rule 3). Category is the composition's label (read-only) and
Ownership opens the Contained tab. A date stored as something other than a
calendar day ("2024") is edited as text, so it cannot be lost.
**P5. No quick-add row.** The + Task / + Expense / + Note / More row under
the tabs is gone (owner, 2026-11-23: "you can delete that"). A task, an
expense or a note about an asset is added from chat or from the Tasks,
Financials and Notes screens; "Add a date" is in the ⋯ menu
(`AssetAddDateDialog`), beside Edit, Ownership, Documents, the alert actions
and Delete (which only opens the page's confirmation).
**P6. One finance tab.** Where a tab set has both, Money is merged into
**Financials** (rollup, breakdown, linked liabilities, the loan, bills and
expenses); a saved `/money` link opens Financials. Subscriptions and the other
sets that never had Financials keep Money.

## Asset lifecycle rules (the AI chooses assumptions; arithmetic decides)

Owner, 2026-11-24: "an AI-powered Asset Lifecycle Intelligence Engine … The
AI should gather relevant evidence and determine appropriate valuation
assumptions. A deterministic calculation engine should perform the financial
calculations." Read these before touching `shared/asset-lifecycle.ts`,
`server/valuation/lifecycle-ai.ts`, `server/asset-lifecycle-service.ts` or
`client/src/components/asset/AssetLifecycle.tsx`.
*Guards:* `tests/asset-lifecycle-engine.test.ts`, `tests/asset-lifecycle-service.test.ts`,
`tests/asset-lifecycle-integrations.test.ts`, `tests/asset-lifecycle.dom.test.tsx`,
`tests/asset-salvage-ai.test.ts`.
*Live check (deployed app, smoke account):* `npx tsx tests/live-asset-lifecycle-check.ts`.

**LC1. The AI only chooses assumptions.** One model call per asset during the
value-tracking run (`estimateLifecycleAssumptions`, beside the market
research, so no extra wait): value model (depreciating / appreciating /
stable), useful life, yearly rate, salvage value (NEGATIVE = a net disposal
cost), disposal route, replacement cost, confidence, plain-language
assumptions. Its answer passes `sanitizeLifecycleAssumptions` — an
out-of-bounds figure is DROPPED, never clamped into a plausible number — and is
stored as `fields.lifecycleAssumptions` (a valuation OUTPUT,
`PRIOR_VALUATION_KEYS`; never an input). It is re-asked when the valuation
input fingerprint changes, after `LIFECYCLE_MAX_AGE_MS`, or when missing; an
asset whose value is already current gets it on open (`salvageDue` → an
unforced refresh → one quick call). No model or no valid answer: the
category's `typicalAssumptions`, labelled "Typical" and low confidence, never
presented as analysed. An unrecognised item on typical figures is never told
to sell or replace (capped at Monitor).
**LC2. Every figure is the engine's, computed on read.** `computeAssetLifecycle`
is pure: projection, accumulated and next-12-month depreciation, remaining
useful life, selling window (60–85 % of life), replacement cost (the AI's, else
the purchase price inflated 3 %/yr, labelled), recommended replacement date,
repair-versus-replace, ONE recommendation (Keep / Monitor / Consider Selling /
Replace / Dispose-Recycle) with its money reasons, confidence (the weaker of
the value's and the assumptions'), sources and timestamps. Nothing derived is
stored (Rule 5). Every screen reads `GET /api/assets/lifecycle`
(`computeLifecycles`; cache-bus: profiles, assets, expenses, documents) — the
asset page, the Assets tab pill, Needs Attention, the Calendar and Finance can
never disagree (Rule 1). Never add a second projection beside it: the
purchase-price `projectDepreciation` line shows only while no lifecycle has
loaded.
**LC3. Nested assets count once.** A parent's lifecycle uses its OWN value;
its descendants are summed separately (`nested`, "not included above"). An
expense linked to a parent and a child belongs to the deepest
(`attributeAssetExpenses`; a tie splits it). Repair-versus-replace reads only
repair/maintenance spending, never loan payments (`payment:` /
`payment-cost:` tags, A4).
**LC4. Significant recommendations surface once, and nothing acts on its own.**
Consider Selling, Replace and Dispose/Recycle join Needs Attention
(`lifecycleAttentionItems`, after the expirations) as a row that OPENS the
asset — no task, no notification, no stored flag. Dismissing stores
`lifecycleAlertId(asset, action)` in the server's dismissed list (Rule 8;
listed and restorable in `DismissedAlertsList`); a different recommendation
later is a new row. The Calendar shows "Replace:" / "Sell by:" / "Best time to
sell opens:" one-off dates (`seriesFromLifecycles`) that are READ-ONLY
(`capabilitiesFor`: only Edit, which opens the asset). Portol never sells,
disposes of or deletes an asset.
*Not built (2026-11-24):* tracker readings (a mileage tracker) as usage input;
a live web price for the replacement cost (the AI's is model knowledge, and
says so); the Executive Timeline card does not list lifecycle dates (the
Calendar does).

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
On one date of a series, the More menu leads with "Change only <date>" (that
date's own actions) and the other row reads "Edit series … for every date";
the series editor says it changes every date, labels its date "Series starts"
and links back to the one date (`onEditOnly`). (QA, 2026-11-24: December 8
was tapped and Edit opened a form dated December 1, with nothing for the 8th.)
**O5. History is derived** (`shared/occurrence-history.ts`) from the marks
and rows the series already has (Rule 5). No stored outcome table.
**O6. Edit happens where the schedule lives** (`editsInPlace`): an event and
a task are edited in the sheet; a bill, a profile's birthday and a document
date open their source. The edit form has a Save button (owner's design); it
writes nothing on open (Rule 3) and sends only what changed.

## Wellness tab rules (a customizable dashboard over a time range; the same system as Executive)

Owner, 2026-11-23: "Executive manages your life; Wellness helps you understand
your health … the same underlying customization system used by your Executive
tab, rather than building two different widget systems." Read these before
touching `client/src/pages/wellness.tsx`, `client/src/components/wellness/*`,
`shared/dashboard-engine.ts`, `shared/wellness-period.ts`, `shared/wellness-cards.ts`,
`shared/wellness-widgets.ts`, `shared/wellness-dashboards.ts` or
`server/wellness-widget-builder.ts`.
*Guards:* `tests/dashboard-engine.test.ts`, `tests/wellness-period.test.ts`,
`tests/wellness-cards.test.ts`, `tests/wellness-widgets.test.ts`,
`tests/wellness-dashboards.test.ts`, `tests/wellness-widget-builder.test.ts`,
`tests/wellness-dashboard.dom.test.tsx`, `tests/wellness-customize-dialog.dom.test.tsx`.
*Live check (deployed app, smoke account, phone touch browser):* `npx tsx tests/live-wellness-dashboard-check.ts`.

**H1. One dashboard engine.** Ordering, sizes, the lonely-half-card rule,
several dashboards and "a card built on one dashboard starts hidden on the
rest; removing it removes it everywhere" live in `shared/dashboard-engine.ts`.
Executive (`shared/exec-card-prefs`, `shared/exec-dashboards`) and Wellness
(`shared/wellness-dashboards`) are instances of it. Change such a rule in the
engine, never in one tab. A third customizable tab is a third instance.
**H2. One row, on the account.** The Wellness layout — dashboards, hidden /
order / sizes, the user's widgets, the display options — is the preference
`wellness_card_prefs` (`serializeWellnessBoards`). No tables, no browser
storage. A widget stores a DESCRIPTION, never a health value.
**H3. A period is computed once.** Every tile, trend row, widget and insight
reads a series through `summarize` (`shared/wellness-period.ts`): an additive
measure (water, steps, sessions, dollars) is a day's total, a reading (weight,
blood pressure, sleep) the day's last. Never average or count in a component.
A move is judged against the metric's healthy range (`moveIsGood`); weight is
never judged. A trend row compares readings of ONE tracker and opens that
tracker (`trendRows` splits a merged series by source, naming each when there
are several). Miles driven are travel, not exercise: a drive / car commute /
car mileage tracker (`isVehicleTravelTracker`, `shared/wellness-canon.ts`) is
never a workout, an activity tracker or the Distance measurement. (QA
2026-11-24: a 140-mile drive in the workout distance; "Distance 140 → 1.5 mi"
opening the Running tracker.)
**H4. A range is a filter (Rule 4).** A range with no reading names the last
one ("Last: Oct 21"), never "no data"; a latest-reading tile (weight, blood
pressure) still shows that reading, dated. Something never recorded is "not
tracked", never a zero. The on-screen range tabs change the VIEW and are not
saved; the stored default is a display option set in Customize. The picked
range rides in the URL (`#/wellness?range=7d`, `client/src/lib/wellness-range-url.ts`)
so a reload keeps it — never browser storage, never the account.
**H5. Nothing hidden reads as missing.** A card the layout switches off is
named under the grid and opens in place; a card with nothing ever recorded
folds into a named quiet row (only once the data has loaded, and the row says
when a profile filter may be why); a dashboard with every section off says
nothing was deleted.
**H6. Customize is a draft.** `WellnessCustomizeDialog` opens from the tab's
Customize button, writes nothing on open (Rule 3), Save Changes writes the one
row, Cancel drops it. Removing a card or a dashboard takes two taps (Rule 8)
and never the last dashboard. Reset keeps the cards the user built. The
dashboard chips on the tab only SWITCH the active dashboard (and say so).
**H7. Three ways to make a card, one shape.** A Widget Idea, the manual
builder (`WellnessWidgetForm`) and the AI Builder all produce a
`WellnessWidget` that passes `sanitizeWellnessWidget`: METRIC (a source, a
calculation, a display), COMPARE (days split by one source, the other
averaged on each side) or SCORE (weighted parts against targets, a part with
no data left out — never scored zero). There is no free-form formula. Add a
new kind of widget by adding a source or a calculation in
`shared/wellness-widgets.ts`.
**H8. The AI only chooses, from what the person actually tracks.**
`GET /api/wellness-widgets/suggest` writes nothing. The model is given an
OUTLINE of the user's trackers (`outlineTrackers`: name, number fields with
units, entry count, whether it is a workout) and which measurements have
readings — never a reading, a note or a date. Its answer is a LIST of cards
(one description may ask for several, at most `MAX_BUILD_WIDGETS`); each passes
`sanitizeWellnessWidget` and is then GROUNDED (`groundWellnessWidget`): the
tracker's real name and field are written back, and a card over a tracker the
person does not have is refused — on the server against the account, and again
in the dialog against the subject's own trackers (H10). With no model, or no
valid answer, the fixed rules answer (`inferWellnessWidgetsFromText`). The
dialog shows each proposal with a live preview and Add / Discard, plus "Add
all" and "Make a new dashboard" (`addWellnessDashboardWithWidgets`) — W5: it
proposes, the user applies. Never let the model emit a query, a formula or
markup. The box ("Create a widget in your own words") is the FIRST panel of
Customize and always open — never behind a toggle (owner, 2026-11-23, who did
not find it under Build Your Own).
**H8a. Offers come from the records.** "From your trackers"
(`suggestWellnessWidgets`) lists a card only for a tracker or measurement that
has entries, so every offer shows real figures the moment it is added; an
amount is totalled, a level (severity, rating, rate) averaged. Nothing is
offered for an empty account.
**H9. A comparison is a pattern, not a diagnosis.** Every COMPARE card shows
`COMPARE_CAVEAT` and how it was worked out; under `MIN_COMPARE_DAYS` paired
days it says so instead of stating a pattern. Insights name an out-of-range
reading with its number and never advise treatment.
**H10. One subject.** The tab reads exactly one person (`resolveWellnessSubject`,
`belongsToSubject`); journal, expenses and goals a card reads are filtered to
that person too. Health data never blends two people.
**H11. A failed list is an error with a retry (Rule 7)** — the tracker list
for the whole tab, journal / expenses / goals for the cards that read them.
`buildWellnessWidgetView` returns null while a list it needs is not loaded.
*Not built (2026-11-23):* drag-to-reorder on the tab itself (it is in
Customize); per-widget colors; widgets over documents or the calendar; a
custom score replacing the header's Wellness chip.

## Chat home rules (what the chat page shows before the first message)

Owner's design, 2026-11-25 (a picture: greeting, daily summary, headline tiles,
insights, today at a glance, suggestions, AI Modes, the chat box). Read these
before touching `shared/chat-home.ts`, `client/src/components/chat/ChatHome.tsx`
or the modes row in `ChatComposer.tsx`.
*Guards:* `tests/chat-home.test.ts`, `tests/chat-home.dom.test.tsx`,
`tests/chat-empty-state.dom.test.tsx`, `tests/chat-workspace-buttons.dom.test.tsx`.

**CH1. The home owns no figure (Rule 1).** `buildChatHome` reads the Wellness
tab's own tiles and summaries over 7 days (`overviewTiles`, `summarize`,
`periodInsights`, `moodSummary`, one subject — H10), the dashboard's finance
snapshot (spending, net worth, categories, assets, `upcomingBills`) and
`countTasksByDay`. The hook uses those screens' query keys. Add a line or a
tile by reading a store that exists; never compute a second version of a
number another screen shows, and never let a model write the summary lines.
**CH1a. The headline tiles are what this person has** (owner, 2026-11-25:
"the six cards should show whatever the user has, not just those
predetermined ones"). `pickHeadlineTiles` offers a tile only for something
with records behind it: the Wellness overview tiles that are tracked, resting
heart rate, the person's other measurements and OWN trackers (the cards
`suggestWellnessWidgets` would offer, read by `buildWellnessWidgetView` over
the 7 days: an amount totalled, a level averaged, a plain log counted),
spending once anything was spent, net worth once anything is owned or owed.
At most `MAX_HOME_TILES`; figures inside the week lead, money keeps its place,
an older reading is shown dated. A workout or food tracker is not listed
beside Activity / Nutrition. Never bring back a fixed list, and never a tile
that reads "Not tracked"; an account with nothing gets one invitation.
**CH2. Loading, failed and zero are three things (Rule 7, H4).** An input is
`undefined` while loading and named in `failed` when its request failed; the
source then has ONE placeholder tile ("…" / "Couldn't load", with a retry) —
what the person tracks is not known yet, so six guesses are not drawn. An
insight with nothing behind it says so and its tap starts the entry in the
chat box. Only a loaded list may read as a zero.
**CH3. Every row goes somewhere.** A route (`href`) or text put in the chat
box (`prompt`); a whole request ("AI Suggestions", AI Briefing) is sent as
typed. Opening the page writes nothing (Rule 3). Rows that scroll sideways
carry `data-swipe-ignore` (T1).
**CH4. The modes are on screen once.** Before the first message they are the
home's tiles; the chat box then leaves its own row out (`hideModes`) and shows
it, as one compact line, during a conversation. Chat is the box itself; Notes,
Journal, Document and Fill In open their workspaces (W1–W11); Documents,
Analyze, Plan and More are pages (`CHAT_APPS`). The box keeps a label for
assistive tech (`sr-only`).
**CH5. The home reads from its top;** only a conversation is pinned to its
end. A bill chip reads the bill's NEXT date (`rollBillsForward`, A7).
**CH6. The look is one layer.** The glowing glass surfaces are the `aurora-*`
classes at the end of `client/src/index.css`; the same block carries the look
to every `.bubble` card, primary button, dialog and the bottom bar by colour,
border and shadow only — no layout or size, so no screen's arrangement moves.
*Not built (2026-11-25):* photographs on the suggestion cards and the summary
(they are drawn); a net-worth change on the tile; a water goal (the bar is
today against the week's average day); the summary is rule-written, not
model-written.

## Touch rules (the app is used on a phone; a mouse click proves nothing about a finger)

**T1. A drag on a control never navigates.** The shell turns a quick sideways
swipe into "next tab" (`SwipeNav`, `client/src/App.tsx`). A touch that starts
on a control, a slider, a tab strip or inside anything that scrolls sideways
is that thing's own drag (`touchOwnsHorizontalDrag`,
`client/src/lib/swipe-guard.ts`; every `Slider` carries `data-swipe-ignore`).
A new draggable thing (a chart you scrub, a reorder handle, a carousel) gets
`data-swipe-ignore`. (Owner, 2026-11-23: dragging the ownership slider to
100% left the asset profile for the Dashboard with the change unsaved; every
existing check had clicked with a mouse.)
**T2. A screen with a control is checked by touch.** A live check of a form
runs in a touch context (`hasTouch`, `isMobile`, `tap()`, real touch drags)
at phone width, not only with a desktop mouse.
*Guard:* `tests/swipe-guard.dom.test.tsx`.
*Live check (phone, real touch events, smoke account):* `npx tsx tests/live-touch-gestures-check.ts`.

**T3. The first screen loads once.** With no scope saved for the user (a
first sign-in, and every sign-in after a sign-out) the scope is settled
BEFORE any screen asks for data: one slim profile list, then the default
(`resolveDefaultScope`, `client/src/lib/scope-ready.ts`; `useScopeReady` gates
`HubArea` and the bootstrap prefetch in `App.tsx`). Never mount a scoped
screen on the unchosen "everyone" and let it re-key when the profile list
lands (2026-11-24, measured: the dashboard loaded for Everyone, painted
household totals, then loaded again for the person — 32 requests, 3.9 s to
the dashboard; 23 and 1.4 s after). A saved scope never waits; a failed or
slow list opens the screen as before. A background request reads its
response to the end (`warmProfileDetail`): one nobody reads never finishes.
*Guards:* `tests/scope-ready.dom.test.ts`, `tests/warm-profile-detail.test.ts`.
*Live check (every page, desktop and phone, and the sign-in load):*
`npx tsx tests/live-all-pages-check.ts`.

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
