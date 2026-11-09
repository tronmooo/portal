# Portol Chat — Tutorial & Capability Map

A lesson-by-lesson guide to everything you can do in Portol by typing in the
chat: logging, creating, marking things done, trackers, money, documents,
complex multi-part messages, and fixing mistakes. Each lesson lists
**example phrases → what happens → where you'll see the result**, followed by
**developer notes** (the tool, the module, the guard) so an agent can extend
or fix that area.

> Source of truth for tool names: `TOOL_DEFINITIONS` in `server/ai-engine.ts`
> (144 tools as of 2026-11-09). `docs/ai-capabilities.md` is generated from it by
> `scripts/gen-ai-capabilities.ts` and is currently **behind** (it lists 135; see
> Lesson 16). Rules for every change: `CLAUDE.md`, `docs/GLOBAL_RULES.md`,
> `ARCHITECTURE.md`.

---

## Lesson 0 — The idea behind Portol

Portol is a **personal-life operating system**: one place for the people,
pets, things, money, health, schedule and paperwork in your life. You don't
fill in forms. You **talk to it** and it files everything in the right place.

Three ideas run through the whole app:

1. **Profiles are the spine.** Everything belongs to someone or something:
   you (`self`), a person (Mom), a pet (Max), a vehicle (Honda Civic), a property
   (123 Maple), an asset (MacBook), an account (Chase Checking), a liability
   (Mortgage), a subscription (Netflix). Expenses, tasks, trackers, documents
   and bills hang off profiles. Say who something is for and it gets linked.
2. **One message, many records.** "Ran 3 miles, spent $40 on gas for the Civic,
   remind me to call the vet Friday" becomes a tracker entry, an expense linked
   to the car, and a dated task, all from one sentence.
3. **Everything stays in sync.** A record shows the same value on the dashboard,
   on the profile page, on the calendar and in chat. Completing something clears
   its alert. A failed load never looks like an empty account. (The sync rules
   are in `CLAUDE.md`.)

**Where things live (pages):**

| Page | Route | What's there |
|---|---|---|
| Chat | `/chat` | The main way in: type or speak, attach files |
| Dashboard | `/dashboard` (+ `/daily`, `/executive`, `/finance`, `/health`, `/tasks`, `/habits`, `/goals`, `/journal`, `/documents`, `/obligations`, `/artifacts`) | Overview tiles, agenda, net worth, alerts |
| Profiles | `/profiles`, `/profiles/:id/:tab` | Every person/pet/asset/account and everything linked to it |
| Trackers | `/trackers` | Health, fitness, custom metrics and their entries |
| Tasks / Habits / Goals | `/tasks`, `/habits`, `/goals` | To-dos, recurring habits with streaks, measurable goals |
| Calendar | `/calendar` | Events, dated tasks, bills, birthdays, expirations |
| Finance / Bills / Liabilities | `/finance`, `/bills`, `/obligations`, `/liabilities` | Expenses, income, budgets, recurring bills, loans |
| Health / Wellness | `/health`, `/wellness` | Health trackers, medications, doses |
| Journal | `/journal` | Journal entries, mood |
| Documents | `/documents/:id` | Uploaded files with extracted fields |
| Artifacts / Editor | `/artifacts`, `/editor/:id` | Notes, checklists, reports, charts (the editor has `/` slash commands) |
| Insights | `/insights` | AI analysis and weekly review |

---

## Lesson 1 — How a chat message is handled

You don't need commands or special syntax. Plain English works. Behind the
scenes a message goes through these steps, in order:

1. **Fast paths, no AI** (`tryFastPath` in `server/ai-engine.ts`): instant
   handling for very common short messages: "weight 182", "mood good",
   "slept 7 hours", "BP 120/80", "open my passport", "show me Mom's dashboard",
   and simple journal lines. A message with several intents skips the fast path.
2. **Front door** (`server/chat-frontdoor.ts`): general questions that need none
   of your data and change nothing ("how do I lower my cholesterol?") can go to
   another model. Any hint of logging or "my data" goes to the agent.
3. **Bulk extractor** (`server/ai-bulk-log.ts`): a long list of things to log
   is split into separate operations (tracker logs, expenses, tasks, events,
   reminders, habit check-ins, journal, doses, income).
4. **The agent** (`processMessage`): Claude with 144 tools. It may call several
   tools in one turn and then replies with a short recap, one line per action.

**What you see:** a short confirmation plus **action chips** (✓ Create Task,
✓ Log Expense …) for each write. Charts, tables and documents render inline.

> **Dev notes:** fast-path writes bypass the tool loop but still return
> `mutations` so the client cache updates. Any new fast path must do the same
> (sync rule 2). Routing tests: `tests/ai-tool-registry.test.ts`; live chat
> suites: `tests/ai-chat-*.ts`, `vitest.multiaction.config.ts`.

---

## Lesson 2 — Profiles: people, pets, things, accounts

| Say | Tool | Result |
|---|---|---|
| "Add my dog Max, golden retriever, born March 2020, 70 lbs" | `create_profile` (type `pet`) | Max profile with breed/birthday/weight |
| "I have a 2019 Honda Civic, 42k miles, VIN 1HG…" | `create_profile` (`vehicle`) | Vehicle profile; value can be estimated |
| "Add my mom Linda, birthday June 4" | `create_profile` (`person`) | Person profile; birthday goes on the calendar every year |
| "Mom's blood type is O+, she's allergic to penicillin" | `update_profile` | Fields saved on Mom's profile |
| "What do I know about Max?" / "Show everything for my Tesla" | `get_profile_data`, `get_related` | Everything linked to that profile |
| "Merge the duplicate Mike profiles" | `merge_profiles` | **Preview first**, then confirm |
| "Why is my MacBook a person?" | `repair_profile_types` | Finds objects filed as people and fixes them |
| "Delete the Test profile" | `delete_profile` | Deleted. If any cleanup step fails, the profile is kept |

**Tip:** add "for Mom" / "for Max" / "for the Civic" to *any* later command to
link that record to the profile (`forProfile`).

> **Dev notes:** ownership has one writer, `server/ownership-writer.ts`.
> Profile scoping goes through `shared/profile-filter.ts`. Profile deletion is
> fail-safe (`deleteProfile` in `server/supabase-storage.ts`). Renames cascade
> (`server/profile-rename-cascade.ts`). Merges: `server/merge-profiles.ts`.

---

## Lesson 3 — Tasks: create, complete, change, delete

| Say | Tool | Result |
|---|---|---|
| "Add a task to buy milk" | `create_task` | Undated to-do |
| "Remind me to renew the registration before Aug 1" | `create_task` (due date) | Dated task on the calendar |
| "Remind me to call the dentist Friday at 10am" | `create_task` (`dueTime`) | Shows on the calendar at 10:00 and sends a notification |
| "Every Tuesday I mow the lawn at 9am" | `create_task` (recurring) | Recurring task |
| "Vet checkup for Max on April 10, high priority" | `create_task` + `forProfile` | Linked to Max |
| **"Mark buy milk done"** / "I finished the passport task" | `complete_task` | Checked off. If not found, it says so and does **not** create a new task |
| "Complete all overdue tasks" | `bulk_complete_tasks` | All matching tasks done |
| "Move the dentist task to Monday" / "make it high priority" | `update_task` | Changed in place |
| "What's due this week?" / "show overdue tasks" | `query_tasks` | List |
| "Delete the milk task" | `delete_task` | Soft-deleted |
| "Bring back the task I just deleted" | `restore_task` | Restored |

**Key rule:** "remind me to *do* X" is a **task**. Something you *attend* (a
meeting, a flight, a party) is an **event** (Lesson 6). There is no third
"reminder" type for to-dos.

---

## Lesson 4 — Habits: daily check-ins and streaks

| Say | Tool | Result |
|---|---|---|
| "Create a habit: meditate every morning" | `create_habit` (`timeOfDay`) | Habit with schedule |
| "Take lisinopril twice a day" | `create_habit` (2× daily) | Needs 2 check-ins per day |
| **"Mark meditation done"** / "I meditated" | `checkin_habit` | Records **one** completion |
| "I walked the dog" (and *Walk the Dog* is a habit) | `checkin_habit` (+ tracker log if measurable) | Checked in, no need to ask |
| "Undo my meditation check-in" / "I didn't actually do it" | `uncomplete_habit` | Check-in removed |
| "Move my lisinopril to the evening" | `update_habit` | Rescheduled |
| "Delete the reading habit" / "bring it back" | `delete_habit` / `restore_habit` | Removed with history / restored |

**Rules:** one check-in fills **one** slot. On a 2×-daily habit, "mark it done"
leaves it at 1 of 2. A plan, a question, or a negation is never a check-in:
"I might walk the dog later", "did I walk the dog?" and "John walked the dog"
don't count.

> **Dev notes:** `server/habit-completion.ts`, `server/habit-rename-cascade.ts`.

---

## Lesson 5 — Trackers: create, log, edit (the core of "track anything")

### 5a. Creating a tracker

Say what you want to track and Portol **works out the fields itself**:

| Say | Fields generated |
|---|---|
| "Track my blood pressure" | systolic, diastolic, pulse, position (sitting/standing/lying) |
| "Track my blood sugar" | reading, context (fasting/post-meal/bedtime), insulin dose |
| "Track my runs" | distance, duration, pace, calories, intensity |
| "Track my lifting" | exercise, sets, reps, weight |
| "Track what I eat" | item, calories, protein, carbs, fat, sugar, fiber, sodium, caffeine, meal type |
| "Track my sleep" | hours, quality, bedtime, wake time, disturbances |
| "Track my mood" | mood (great…awful), energy 1–5, anxiety 1–10, triggers |
| "Track Max's walks" | activity, duration, notes (linked to Max) |
| "Create a Steps tracker with a numeric count field" | exactly what you specify |
| Anything else ("track my guitar practice") | 3–6 sensible fields + notes |

Tool: `create_tracker`. Categories: health, fitness, nutrition, sleep, mental,
lifestyle, finance, medication, custom. Field types: number, text, boolean,
select, duration.

### 5b. Logging to a tracker

You usually **don't even need to create the tracker first**. Report what you did:

- "Weight 182.4" · "BP 124/78" · "slept 7.5 hours, quality good"
- "Ran 3.2 miles in 28 minutes"
- "Had 2 eggs and toast for breakfast" (nutrition is looked up automatically)
- "Played basketball for an hour" (gets a **Basketball** tracker, not Running)
- "124/78 with a resting heart rate of 59" → **two** logs: Blood Pressure and
  Heart Rate. Heart rate never goes inside Blood Pressure.
- "Vacuumed the house", "read 30 pages of Dune", "2 coffees today"

Tool: `log_tracker_entry`. Portol never refuses with "not tracked". If the
tracker doesn't exist, it's created.

**Money never goes into a tracker.** "Spent $80 on an oil change" is an
**expense** linked to the car (Lesson 7). The server rejects money-shaped
tracker entries.

### 5c. Fixing entries

| Say | Tool |
|---|---|
| "Actually I slept 8 hours, not 7" | `update_tracker_entry` |
| "Delete my weight entry from today" | `delete_tracker_entry` |
| "Rename the Running tracker to Jogging" / "change unit to km" | `update_tracker` |
| "Delete the Steps tracker" | `delete_tracker` (removes all entries, irreversible) |
| "Chart my weight for the last 3 months" | `generate_chart` |

> **Dev notes:** field normalization in `server/tracker-normalize.ts`; units in
> `shared/tracker-units.ts`; nutrition lookup in `server/nutrition-enrichment.ts`.
> Background: `TRACKER_SYSTEM_PLAN.md`, `TRACKER_INTEGRITY_ROOT_CAUSE.md`.

---

## Lesson 6 — Events, reminders, calendar

| Say | Tool | Result |
|---|---|---|
| "Team standup every Tuesday 9:30am" | `create_event` (recurring) | Calendar series |
| "Dentist appointment April 2 at 9" | `create_event` | Event |
| "Replace the fridge filter every 6 months" | event linked to the fridge asset | Maintenance reminder |
| "Remind me at 4pm to pick up Max" | `create_reminder` | Notification at that time **and** a calendar entry |
| "Move my dentist reminder to 4pm" / "cancel it" | `update_reminder` / `delete_reminder` | Changed / removed |
| **"I went to the dentist"** / "mark standup done" | `complete_event` | Event marked attended |
| "Move standup to Wednesday" | `update_event` | Changed |
| "What's on my calendar this week?" | `query_calendar` | Events, dated tasks, habits and bills together |
| "When is Mom's birthday?" | `search_calendar` | Answer |
| "Sync my Google Calendar" | `sync_calendar` | Imports events |

**Snooze ≠ reschedule.** Snoozing an alert hides it for a while (on all your
devices). It never changes the record's real date.

> **Dev notes:** every date in the app comes from the date-rule engine,
> `shared/date-rules.ts`. `sync_date_rules_for_entity` checks that a record's
> dates will appear on Calendar / Upcoming. Weekly occurrence changes go through
> `POST /api/events/:id/occurrence`, never a client read-modify-write.

---

## Lesson 7 — Money: expenses, income, budgets

| Say | Tool | Result |
|---|---|---|
| "Spent $42.99 at Walmart on groceries" | `create_expense` | Expense, category food |
| "$80 oil change for the Civic" | `create_expense` + `forProfile` | Shows on the Civic's profile |
| "Got paid $2,400" / "received $500 freelance" | `log_income` | Income |
| "Expecting a $2,400 Acme paycheck on the 15th" → "Acme paycheck came in" | `log_expected_paycheck` → `confirm_paycheck_received` | Expected, then confirmed |
| "I got refunded $40 for the shoes" | `refund_expense` | Refund against the original |
| "That laptop I expensed is actually an asset" | `convert_expense_to_asset` | Becomes an asset profile |
| "Change the Walmart expense to $45" / "delete it" | `update_expense` / `delete_expense` | — |
| "How much did I spend on food this month?" / "last 5 expenses" | `query_expenses`, `spending_analytics` | Totals, comparisons |
| "Set a $600 grocery budget" / "$500 for Bob" | `set_budget` (`forProfile`) | Monthly budget |
| "Copy last month's budgets" | `copy_budgets_previous_month` | — |
| "How am I doing on my budget?" | `get_budget_summary` | Budget vs. actual |
| "Cash flow this month" | `get_cashflow` | Projected vs. actual by week |

**Rule:** a one-time purchase is an **expense** even when the same message
also mentions a monthly bill.

> **Dev notes:** `server/finance-*.ts`, bank CSV import in `server/bank-csv.ts`.

---

## Lesson 8 — Bills, subscriptions, loans: "mark it paid"

### Recurring bills and subscriptions (obligations)

| Say | Tool |
|---|---|
| "Netflix $15.49 monthly, due the 12th" | `create_obligation` |
| **"Paid the electric bill"** | `pay_obligation`: pays the oldest open month |
| "Mark Bob's phone bill paid for June" | `pay_obligation` (`forMonth: 2026-06`) |
| "Paid the August bill from my checking" | `pay_obligation` (`fromAccount`): checking balance goes down too |
| "My electric bill this month was $143.82" | `set_liability_amount` (mode `actual`) |
| "Add $30 of extra ChatGPT credits to this month's bill" | `add_liability_charge` |
| "Undo that payment" | `undo_last_payment` |
| "Netflix went up to $17.99" / "cancel Hulu" | `update_obligation` / `delete_obligation` |

### Debts (liabilities)

| Say | Tool |
|---|---|
| "I have a $320k mortgage at 6.5%, 30 years" | `create_liability` |
| "Paid $500 on the car loan" / "extra $2,000 toward principal" | `add_liability_payment` |
| "Mark this month's mortgage payment paid" | `mark_loan_payment` (amortization row) |
| "My mortgage balance is now $410k" / "refinanced to 5.9%" | `update_liability` |
| "Fix that payment, it was $520" / "remove the duplicate payment" | `update_liability_payment` / `delete_liability_payment` |
| "This mortgage is on 123 Maple" | `link_liability_asset` |
| "This loan is split 50/50 with my wife" | `link_liability_owner` / `split_ownership` |
| "When will my car loan be paid off?" | `get_liability_summary`, `get_loan_schedule` |

> **Dev notes:** `server/obligation-engine.ts` (occurrences),
> `server/liability-payments.ts`, `shared/liability-calc.ts`. Paying a bill must
> clear its alert because the alert is **derived** from the records. Don't add a
> stored "resolved" flag (sync rule 5).

---

## Lesson 9 — Accounts, assets, net worth

| Say | Tool |
|---|---|
| "Checking at Chase with $2,400" / "Amex with a $10k limit" | `create_account` |
| "My checking is down to $1,850" / "moved $500 to savings" | `update_account_balance` (keeps the before/after history) |
| "How much cash do I have?" / "credit left on the Amex?" | `get_accounts` |
| "What's my Civic worth now?" | `revalue_asset` (live web estimate) |
| "Total value of my house and everything in it" | `get_asset_rollup` |
| "Split the Tesla 60/40 with Sarah" | `link_asset_owner` / `split_ownership` |
| "Why did my net worth change today?" | `query_net_worth_history` |

**Accounts are never "estimated".** An account's value is its balance. Only
owned things (cars, houses, items) get valuations.

> **Dev notes:** values come from `resolveAssetValue` (`shared/asset-value.ts`),
> net worth from `computeNetWorth` (`shared/net-worth.ts`), card values from
> `currentAssetValue` (`shared/valuation/context.ts`). Valuation:
> `server/valuation/service.ts` (`isValuableProfile`). Guard:
> `tests/sync-rules-guards.test.ts`.

---

## Lesson 10 — Health & medications

| Say | Tool |
|---|---|
| "I take Metformin 500mg twice daily" | medication tracker + habit |
| "Prescription: 90 pills, 2 refills, 1 a day" | `schedule_medication_refills` (real refill reminders) |
| **"I took my Lisinopril"** / "gave Max his Heartgard" | `log_medication_dose` |
| "Skipped tonight's dose" / "forgot my Metformin yesterday" | `skip_medication_dose` |
| "When did I last take my meds?" | `get_dose_history` |
| "What doses did I miss this week?" / "how's my adherence?" | `get_missed_doses` |

> **Dev notes:** `server/medication-doses.ts`.

---

## Lesson 11 — Goals

| Say | Tool |
|---|---|
| "I want to lose 10 lbs by June" / "run 100 miles this quarter" | `create_goal` |
| "How am I doing on my goals?" | `get_goal_progress` |
| **"I hit my reading goal"** / "mark the goal done" | `update_goal` (complete) |
| "Change the target to 15 lbs" / "delete it" | `update_goal` / `delete_goal` |

---

## Lesson 12 — Journal, notes, memories, artifacts

| Say | Tool | Notes |
|---|---|---|
| "Journal: great day, gym then coffee with Sam" | `journal_entry` | Mood is picked up |
| "Add this to today's journal: …" | `append_journal_entry` | Appends instead of making a duplicate |
| "Change 'gym' to 'yoga' in today's entry" | `update_journal` | Find/replace |
| "Note: Robert's gate code is 4417" | `create_note` | A note is information, **not** a to-do |
| "What was Robert's gate code?" | `search_notes` / `recall_memory` | — |
| "I'm vegetarian" / "I prefer window seats" | `save_memory` | Preference that isn't tied to one profile |
| "Make a packing checklist for Hawaii" | `create_artifact` (checklist) | Saved under Artifacts |
| "Check off sunscreen on my packing list" | `toggle_artifact_item` | — |
| "Pin my grocery list" / "duplicate it" | `update_artifact` / `duplicate_artifact` | — |
| "What do you know about me?" | `recall_memory` | Searches memories, profiles, fields and documents |

---

## Lesson 13 — Documents (paperclip / camera)

1. Attach a photo or PDF with the **paperclip**: a license, insurance card,
   receipt, warranty, lease, lab result. Chat can't upload files by itself
   (`upload_document` only tells you to use the button).
2. Portol **extracts the fields** (expiry date, policy number, amounts) and
   files the document under the right profile.
3. Dates in a document become calendar alerts ("passport expires in 60 days").
   A **newer document of the same kind replaces the old one's alert**.

| Say | Tool |
|---|---|
| "Show Mom's insurance card" / "open my passport" | `retrieve_document` / `open_document` |
| "When does my license expire?" | `search_documents` |
| "Link the registration to my Honda" | `link_document` |
| "Rename it" / "re-read it" / "delete it" | `manage_document` |

> **Dev notes:** `server/document-provenance.ts`, `server/document-deletion.ts`;
> supersede logic: `markSupersededDocumentRules` in `shared/date-rules.ts`.

---

## Lesson 14 — Complex and multi-part messages

This is where Portol beats a form-based app. All of these work in **one message**:

- "Ran 3 miles, weighed 181, spent $12 on lunch, and remind me to call Mom at 6"
  → tracker ×2, expense, timed task. The reply is a recap with one line per action.
- "Paid the electric bill $143 from checking and the Netflix bill"
  → two `pay_obligation` calls, checking balance reduced
- "Max had his vet visit today, cost $220, he weighs 72 lbs now, next shot in 6 months"
  → expense linked to Max, weight update/log, future event
- "Bought a new MacBook for $2,400; it's an asset; warranty ends Dec 2027"
  → asset profile with purchase price and a warranty date
- "Mortgage of $320k on 123 Maple, split 50/50 with Sarah, I just paid $2,100"
  → liability + collateral link + ownership split + payment
- A pasted list of 20 food items or workouts → the **bulk extractor** logs each
  one and reports which succeeded and which failed

**Questions over your data** (read-only, never change anything):

- "How much did I spend on Max this year compared to last year?"
- "Which bills are due before my next paycheck?"
- "Show a chart of my sleep vs. mood for the last month"
- "Give me a monthly report on spending, habits and goals" (`generate_report`)
- "Table of all my subscriptions sorted by cost" (`generate_table`)
- "Why is the mortgage in today's agenda?" (`explain_dashboard_item`)
- "What changed on the Honda and when?" (`get_entity_history`)

**Rules the agent follows:** each part of a message is judged **on its own
phrasing**. If one part fails, the others still happen and the failure is
reported.

---

## Lesson 15 — Fixing mistakes, bulk changes, data health

| Say | Tool | Safety |
|---|---|---|
| **"Undo that"** / "take that back" | `undo_last_action` | Reverses the last change: creates are deleted, deletes are restored, edits are rolled back. Says plainly when something can't be undone |
| "Undo the expense I logged earlier" | `undo_last_action` (`tool`/`entity_name`) | Undoes one specific earlier action |
| "What did I just do?" | `recall_actions` | — |
| "Delete all my test tasks" / "all expenses from today" | `preview_bulk_action` → **you confirm** → `execute_bulk_action` | Two steps; nothing is deleted at the preview |
| "Do I have duplicate expenses?" | `find_duplicates` | Lists them; deletes nothing |
| "Is my data healthy?" → "fix it" | `find_orphans` → `repair_relations` | — |
| "Are my dashboard numbers right?" | `validate_dashboard_counts` | Recounts each tile |
| "Refresh my dashboard" | `refresh_dashboard` | Clears caches |

In the UI, destructive buttons need **two taps** (`useConfirmArm`).

---

## Lesson 16 — Dashboard, navigation, notifications

| Say | Tool |
|---|---|
| "Go to finance" / "open Max's profile" | `navigate` |
| "Show me Mom's dashboard" / "show everyone" | `set_dashboard_scope` (changes whose data is shown; it says so) |
| "Hide Quick Notes" / "move Goals to the top" | `configure_dashboard_sections` |
| "Notify me about the insurance renewal" | `create_notification` |
| "Dismiss all notifications" / "mark them read" | `dismiss_notifications` / `mark_notifications_read` |
| "Mute info notifications" | `set_notification_preferences` |
| "Summarize my week" | `refresh_ai_summary`, `get_summary` |

**Filters never look like deletion.** When a filter is hiding records, the page
says so and offers to clear it. It never says "No tasks yet".

---

## Appendix A — "Marking things done" cheat sheet

| Thing | Say | Tool | Undo |
|---|---|---|---|
| Task | "mark X done" / "finished X" | `complete_task` | `update_task` (status) / "undo that" |
| Many tasks | "complete all overdue tasks" | `bulk_complete_tasks` | "undo that" |
| Habit | "I did X" / "check in X" | `checkin_habit` | `uncomplete_habit` |
| Event | "I went to X" / "X is done" | `complete_event` | `update_event` |
| Goal | "I hit my X goal" | `update_goal` | `update_goal` |
| Bill | "paid the X bill (for June) (from checking)" | `pay_obligation` | `undo_last_payment` |
| Loan installment | "mark this month's mortgage paid" | `mark_loan_payment` | `undo_last_action` |
| Loan payment (amount) | "paid $500 on the car loan" | `add_liability_payment` | `delete_liability_payment` |
| Paycheck | "the Acme paycheck came in" | `confirm_paycheck_received` | `delete_paycheck` |
| Medication | "took my X" / "skipped X" | `log_medication_dose` / `skip_medication_dose` | `undo_last_action` |
| Checklist item | "check off X on my list" | `toggle_artifact_item` | same tool (uncheck) |
| Notification | "dismiss / mark read" | `dismiss_notifications` / `mark_notifications_read` | — |

When something is done, its alert goes away because the alert is **calculated
from the records**, not stored as a flag.

---

## Appendix B — Development backlog an agent can pick up

Found while writing this guide. Check each one against the current code before
starting.

1. **Regenerate `docs/ai-capabilities.md`.** It lists 135 tools; the engine has
   144. Missing: `add_liability_charge`, `append_journal_entry`,
   `create_account`, `create_note`, `delete_note`, `get_accounts`,
   `repair_profile_types`, `search_calendar`, `search_notes`,
   `set_liability_amount`, `sync_date_rules_for_entity`,
   `update_account_balance`, `update_note`. Run
   `scripts/gen-ai-capabilities.ts`, and consider a test that fails when the
   doc is out of date.
2. **Lesson 3 vs. tool text.** `create_task` says "there is no third 'reminder'
   kind", yet `create_reminder` / `update_reminder` / `delete_reminder` exist.
   Pick one model, make the tool descriptions agree, and add a routing test for
   "remind me to X at 4pm".
3. **In-app tutorial / onboarding.** The chat composer placeholder is just
   "Ask me anything...". Add example prompt chips grouped like the lessons
   above (Log · Mark done · Money · Ask), and add a "What can you do?" answer
   built from this guide. The empty-state test is
   `tests/chat-empty-state.dom.test.tsx`.
4. **Chat slash commands.** Slash commands exist only in the editor
   (`client/src/lib/editor-slash-commands.ts`). Optional idea: `/log`, `/task`,
   `/paid`, `/done`, `/undo`, `/track` in the chat composer that insert a
   template phrase. This is a convenience only; the chat must keep working on
   plain English.
5. **Re-run the chat QA scenarios** in `docs/qa-chat-tests.md` (several were
   marked FAIL in March 2026 because of capture timing) against the smoke
   account with the live suites, and update the report.

**Rules for any change** (from `CLAUDE.md`): run `npx tsc --noEmit`,
`npx vitest run` (list new test files in `vitest.config.ts`) and
`npm run test:contracts`. Use only the smoke account for live tests. Prefer
tests that drive the real route or page. A bug fix needs a test that fails on
the old code.
