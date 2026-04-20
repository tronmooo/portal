# Portol — Manual Testing Guide (Command Inventory)

Purpose: give Claude (or a human tester) everything needed to exercise every
command the app supports. For each command this guide lists example inputs,
which API endpoint handles it, what table it reads/writes, where the result
appears in the UI, and what a correct answer looks like.

Primary command surface is the Chat page (`/chat`) → `POST /api/chat` →
`server/ai-engine.ts`. A subset of commands runs via a fast regex path
(no AI call); everything else is dispatched through AI tool definitions.

---

## 1. How to exercise a command

1. Open `/chat` in the running dev server (`npm run dev`).
2. Type the example input verbatim.
3. Verify:
   - **API call**: the listed endpoint returned 2xx (DevTools → Network).
   - **DB state**: the listed table/collection got a new/updated row.
   - **UI**: the listed page shows the new item.
   - **Chat reply**: matches the "correct answer" shape below.

For fast-path commands the reply comes back in <300 ms with no AI spinner.
For AI-powered commands expect 1–5 s and a tool-call trace in the response.

---

## 2. Fast-path commands (regex, no AI call)

Implemented in `server/ai-engine.ts` `tryFastPath()` (around line 394).

### 2.1 Document retrieval
- Examples: `open my drivers license`, `show my insurance card`, `pull up passport`.
- Matching: fuzzy name + synonym expansion (license ↔ driver's license, vehicle ↔ car).
- Endpoint: `GET /api/documents/:id/file`.
- Data: `documents` table.
- UI: inline document preview in Chat; also visible on Documents section.
- Correct answer: document metadata + base64 `fileData` rendered in chat bubble.

### 2.2 Habit check-in
- Examples: `done meditation`, `mark off my run`, `I went on my morning run`.
- Endpoint: `POST /api/habits/:id/checkin`.
- Data: `habits.checkins[]`; updates `currentStreak`.
- UI: Habits page shows today as checked; streak counter increments.
- Correct answer: `"Checked in <habit name> — <N>-day streak"`.

### 2.3 Health quick-log
| Pattern | Example | Tracker | Computed |
|---|---|---|---|
| `weight <n>` / `<n> lbs` | `weight 183` | Weight | BMI |
| `bp <sys>/<dia>` | `bp 120/80` | Blood pressure | — |
| `slept <n> hours` | `slept 7 hours` | Sleep | sleep quality |
| `ran <d> miles in <mm:ss>` | `ran 3 miles in 25:00` | Running | pace, HR zone |
| `mood <label>` | `mood good` | Journal | mood level |

- Endpoint: `POST /api/trackers/:id/entries` (or `/api/journal` for mood).
- Data: `trackerEntries` table (`values` + `computed`), or `journalEntries`.
- UI: Trackers page → tracker detail shows new entry; Dashboard reflects latest.
- Correct answer: numeric echo + computed metric, e.g. `"Logged 183 lb (BMI 25.5)"`.

### 2.4 Memory save
- Examples: `remember that I'm vegetarian`, `remember my Wi-Fi password is xxx`.
- Must NOT match `remind me ...` (that creates a task/reminder).
- Endpoint: `POST /api/memories`.
- Data: `memories` table.
- UI: surfaced via `recall_memory` queries in chat; not a dedicated page.
- Correct answer: `"Remembered: <fact>"`.

### 2.5 Journal entry (single-profile fast path)
- Examples: `add journal entry for Rex calm and happy`, `log entry saying had a great workout`.
- Endpoint: `POST /api/journal`.
- Mood is inferred (tired → bad, motivated → great).
- UI: Journal page shows new entry.
- Correct answer: mood label + content preview.

---

## 3. AI-powered commands

All route through `POST /api/chat` → `processMessage()` → tool definitions
in `server/ai-engine.ts`.

### 3.1 Profile management
Types: `person`, `pet`, `vehicle`, `account`, `property`, `subscription`,
`medical`, `self`, `loan`, `investment`, `asset`.

| Intent | Tool | Endpoint | Example input |
|---|---|---|---|
| Create | `create_profile` | `POST /api/profiles` | "Create a profile for my dog Max — golden retriever, 45 lbs" |
| Update | `update_profile` | `PATCH /api/profiles/:id` | "Update Mom's birthday to 1965-03-15" |
| Delete | `delete_profile` | `DELETE /api/profiles/:id` | "Delete the profile for my old Honda" |
| Read detail | `get_profile_data` | `GET /api/profiles/:id/detail` | "Show everything about Rex" |

- Data: `profiles` table. Use `forProfile` when an asset belongs to another person.
- UI: Profiles page (list) + Profile detail (`/profiles/:id`).
- Correct answer: echoes name, type, key fields; detail call returns linked
  trackers, expenses, events, documents, child assets.

### 3.2 Trackers & entries
- Create: `POST /api/trackers`. AI auto-generates fields by domain.
  - "Create a blood pressure tracker" → `[systolic, diastolic, pulse, position]`.
  - "Track my medications — Metformin 500mg daily" → `[drug, dosage, timeTaken, adherence]`.
- Log entry: `POST /api/trackers/:id/entries` with `values`, optional `forProfile`.
  Auto-computes pace/BMI/sleep quality/calorie burn based on tracker kind.
- Update entry: `PATCH /api/trackers/:id/entries/:entryId` (tool `update_tracker_entry`).
- Delete entry: `DELETE /api/trackers/:id/entries/:entryId`.
- UI: Trackers page + profile detail's linked trackers section.
- Correct answer: entry id + computed metrics.

### 3.3 Tasks
Fields: `title` (required), `description`, `priority` (low/medium/high),
`dueDate` (YYYY-MM-DD), `tags`, `forProfile`.

| Intent | Tool | Endpoint | Example |
|---|---|---|---|
| Create | `create_task` | `POST /api/tasks` | "Create a task to call the dentist by Friday" |
| Complete | `complete_task` | `PATCH /api/tasks/:id` (status=done) | "Mark call dentist as done" |
| Update | `update_task` | `PATCH /api/tasks/:id` | "Rename it to schedule dentist appointment" |
| Delete | `delete_task` | `DELETE /api/tasks/:id` | "Delete the task call dentist" |
| Bulk complete | `bulk_complete_tasks` (filter=all/overdue/today) | internal | "Mark all overdue tasks done" |
| Query | `query_tasks` | `GET /api/tasks` | "Show me overdue tasks" |

- UI: Tasks page; Calendar also shows tasks that have a due date.
- Correct answer: task id, title, status. Deletes ask for confirmation if ambiguous.

### 3.4 Habits
Fields: `name` (required), `frequency` (daily/weekly/custom), `targetDays`
(0=Sun…6=Sat), `targetPerDay`, `icon`, `color`, `forProfile`.

| Intent | Tool | Endpoint |
|---|---|---|
| Create | `create_habit` | `POST /api/habits` |
| Check in | `checkin_habit` | `POST /api/habits/:id/checkin` |
| Uncheck | `uncomplete_habit` | `DELETE /api/habits/:id/checkin/:checkinId` |
| Update | `update_habit` | `PATCH /api/habits/:id` |
| Delete | `delete_habit` | `DELETE /api/habits/:id` |

- Examples: "Exercise 3x per week on Mon/Wed/Fri", "I did my meditation".
- UI: Habits page + Calendar (daily items).
- Correct answer: name + current streak.

### 3.5 Expenses & income
Expense category MUST be one of: `food, transport, health, pet, vehicle,
entertainment, shopping, utilities, housing, insurance, subscription,
education, personal, general`.

| Intent | Tool | Endpoint | Example |
|---|---|---|---|
| Create expense | `create_expense` | `POST /api/expenses` | "Spent $50 on groceries" |
| Update expense | `update_expense` | `PATCH /api/expenses/:id` | "Change the $50 grocery expense to $55" |
| Delete expense | `delete_expense` | `DELETE /api/expenses/:id` | "Delete that coffee expense" |
| Query expenses | `query_expenses` | `GET /api/expenses` | "How much did I spend on food last month?" |
| Log income | `log_income` | `POST /api/incomes` | "Got paid $5000 from Acme Corp" |

- Category values: `salary, freelance, investment, gift, refund` for income.
- UI: Finance page shows expenses list, income list, spending chart.
- Correct answer: amount + category echoed; profile link if `forProfile` set.
- Note: receipt uploads auto-create an expense if amount is extracted.

### 3.6 Obligations (recurring only)
**Rule**: one-time payments go through `create_expense`, not `create_obligation`.

Fields: `name`, `amount`, `frequency` (weekly/biweekly/monthly/quarterly/
yearly/once), `nextDueDate`, optional `category`, `autopay`, `notes`, `forProfile`.

| Intent | Tool | Endpoint |
|---|---|---|
| Create | `create_obligation` | `POST /api/obligations` |
| Pay | `pay_obligation` | `POST /api/obligations/:id/pay` |
| Update | `update_obligation` | `PATCH /api/obligations/:id` |
| Delete | `delete_obligation` | `DELETE /api/obligations/:id` |

- Examples: "Netflix $15/month starting Friday", "Rent $1500 monthly".
- Side effect: auto-creates matching subscription/loan profile and fills
  calendar with recurring due dates.
- UI: Obligations page + Calendar entries.
- Correct answer: obligation id, next due date, list of projected dates.

### 3.7 Calendar events
Fields: `title`, `date` (YYYY-MM-DD), optional `time`, `endTime`, `location`,
`description`, `category` (personal/work/health/finance/family/social/travel/
education/other), `recurrence` (none/daily/weekly/biweekly/monthly/yearly),
`forProfile`.

| Intent | Tool | Endpoint |
|---|---|---|
| Create | `create_event` | `POST /api/events` |
| Update | `update_event` | `PATCH /api/events/:id` |
| Complete | `complete_event` | `PATCH /api/events/:id` |
| Delete | `delete_event` | `DELETE /api/events/:id` |
| Query timeline | `query_calendar` | `GET /api/calendar/timeline?startDate=&endDate=` |
| Sync Google | `sync_calendar` | `POST /api/calendar/sync` (direction: import or both) |
| Export one event | — | `POST /api/calendar/export/:id` |

- `complete_event` accepts `removeFromSchedule` (true hides, false keeps).
- UI: Calendar page (`/calendar-page`) unified view of events, tasks, habits, obligations.
- Correct answer: event id, date/time, and a calendar timeline showing it.

### 3.8 Journal
Fields: `mood` (amazing/great/good/okay/neutral/bad/awful/terrible) required,
optional `content`, `energy` 1–5, `gratitude[]`, `highlights[]`, `forProfile`.

| Intent | Tool | Endpoint |
|---|---|---|
| Create | `create_journal_entry` | `POST /api/journal` |
| Update | `update_journal` | `PATCH /api/journal/:id` |
| Delete | `delete_journal` | `DELETE /api/journal/:id` |

- UI: Journal page lists entries by date.
- Correct answer: mood, date, content preview.

### 3.9 Goals
Types: `weight_loss, weight_gain, savings, habit_streak, spending_limit,
fitness_distance, fitness_frequency, tracker_target, custom`.

| Intent | Tool | Endpoint |
|---|---|---|
| Create | `create_goal` | `POST /api/goals` |
| Progress | `get_goal_progress` | `GET /api/goals` |
| Update / complete | `update_goal` | `PATCH /api/goals/:id` |
| Delete | `delete_goal` | `DELETE /api/goals/:id` |

- Example: "Goal: lose 10 lbs by June 30" → type=weight_loss, target=10, unit=lbs, deadline=2026-06-30.
- UI: Goals section on Dashboard and in profile detail.
- Correct answer: current vs target, remaining days, milestone list.

### 3.10 Documents
- Upload: `POST /api/upload` (multipart). Claude Vision extracts fields.
  User reviews extracted data in pending-extraction UI before saving.
  Receipts with an amount auto-create an expense.
- Retrieve: `retrieve_document` / `open_document` → `GET /api/documents/:id/file`.
- Manage: `manage_document` → `PATCH /api/documents/:id` (rename / re-extract) or `DELETE`.
- Types seen: drivers_license, passport, insurance_card, vehicle_registration,
  medical_report, lab_results, prescription, receipt.
- UI: inline preview in Chat; Profile detail lists linked docs.
- Correct answer on open: document metadata + base64 file + extracted fields.

### 3.11 Artifacts
Types: `checklist, note, markdown, code, html, svg, mermaid, chart`.
- Create: `POST /api/artifacts`. Code artifacts may specify `language`.
- Update: `PATCH /api/artifacts/:id`. Delete: `DELETE /api/artifacts/:id`.
- Examples: "Create a workout checklist", "Generate a financial summary report",
  "Write a Python script to calculate BMI", "Draw a flowchart of my budget process".
- UI: Artifacts page (`/artifacts`); also rendered inline in chat.
- Correct answer: artifact id + rendered content block.

### 3.12 Memories
- Save: `save_memory` → `POST /api/memories` with `key`, `value`, `category`
  (preferences/facts/health/goals/general). Only abstract facts or preferences;
  concrete items (tasks, expenses, profiles) go to their own tables.
- Recall: `recall_memory` → `GET /api/memories/recall`.
- Delete: `DELETE /api/memories/:id`.
- UI: no dedicated page; surfaces through chat recall.

### 3.13 Budgets
Same category list as expenses. Period is `YYYY-MM`.

| Intent | Tool | Endpoint |
|---|---|---|
| Create/update | `set_budget` / `update_budget` | `POST /api/budgets` / `PATCH /api/budgets/:id` |
| Summary | `get_budget_summary` | `GET /api/budgets` |
| Delete | — | `DELETE /api/budgets/:id` |

- UI: Finance page → Budgets tab shows budget-vs-actual bars.
- Correct answer: category, limit, spent-so-far, remaining.

### 3.14 Financial analytics
- Spending: `spending_analytics` → `GET /api/analytics/spending`.
  Params: `period` (week/month/quarter/year), `compareWith=previous`, `groupBy`
  (category/day/week/month). Example: "Show my spending this month vs last".
- Cash flow: `get_cashflow` → `GET /api/cashflow`. Weekly projection vs actual.
- Loan schedule: `get_loan_schedule` → `GET /api/loans/schedule`. Full amortization.

Correct answer: numeric totals + a chart block rendered inline.

### 3.15 Paychecks
- Log expected: `log_expected_paycheck` → `POST /api/paychecks`
  (source, amount, expected_date, notes).
- Confirm received: `confirm_paycheck_received` → `PATCH /api/paychecks/:id/confirm`
  (actual_amount if different, received_date).

### 3.16 Custom domains
- Create: `create_domain` → `POST /api/domains` with field schema.
  Example: Books Read domain with fields `title, author, rating (1-5), pages, dateFinished`.
- Entries: `POST /api/domains/:id/entries` with `values`, `tags`, `notes`.
- Update/delete: `update_domain`, `delete_domain`.

### 3.17 Visual output
- `generate_chart`: types `line, bar, area, pie, scatter, composed, radar`;
  data sources `trackers, expenses, tasks, habits, journal, obligations, goals`.
  Always returns a `ChartSpec` rendered in chat — never a prose description.
- `generate_table`: data table with sort/filter.
- `generate_report`: types `financial, health, life_scorecard, profile,
  goal_progress, weekly_digest` — multi-section report with charts + metrics.

### 3.18 Entity linking
- `link_entities` → `POST /api/entity-links` with
  `belongs_to | paid_for | tracks | document_for | related_to`.
- `get_related` → `GET /api/entity-links/:type/:id/related`.

### 3.19 Asset valuation
- `revalue_asset`: live web search (Zillow, KBB/Edmunds, eBay).
- Correct answer: `{estimatedValue, confidence, method, range}`.

---

## 4. Top-level data queries

| Intent | Tool | Endpoint | Example |
|---|---|---|---|
| Global search | `search` | `GET /api/search` | "find my dentist" |
| Summary stats | `get_summary` | `GET /api/stats` | "how many tasks do I have?" |
| Dashboard | — | `GET /api/dashboard-enhanced` | Dashboard page load |

---

## 5. UI page → data sources

| Page | Route | Key endpoints |
|---|---|---|
| Chat | `/chat` | `POST /api/chat` |
| Dashboard | `/dashboard` | `GET /api/stats`, `/api/dashboard-enhanced` |
| Profiles list | `/profiles` | `GET /api/profiles` |
| Profile detail | `/profiles/:id` | `GET /api/profiles/:id/detail` |
| Trackers | `/trackers` | `GET/POST /api/trackers`, `POST /api/trackers/:id/entries` |
| Tasks | `/tasks` | `GET/POST /api/tasks`, `PATCH /api/tasks/:id` |
| Habits | `/habits` | `GET/POST /api/habits`, `POST /api/habits/:id/checkin` |
| Finance | `/finance` | `/api/expenses`, `/api/budgets`, `/api/analytics/spending` |
| Obligations | `/obligations` | `/api/obligations`, `POST /api/obligations/:id/pay` |
| Calendar | `/calendar-page` | `GET /api/calendar/timeline` |
| Journal | `/journal` | `GET/POST /api/journal` |
| Artifacts | `/artifacts` | `GET/POST /api/artifacts` |
| Settings | `/settings` | `GET/PUT /api/preferences` |

---

## 6. End-to-end test scenarios

### Scenario A — multi-profile health log
Input: `Log Rex's weight at 35 lbs and my weight at 175 lbs`

Expected:
1. `log_tracker_entry` (Weight, forProfile=Rex, values.weight=35).
2. `log_tracker_entry` (Weight, forProfile=self, values.weight=175).
3. Both profiles' detail pages show the new entries with BMI computed.

### Scenario B — task + event + expense combo
Input: `Create a dentist task for Friday, schedule the appointment at 2pm, and I spent $150 on it`

Expected:
1. Task `title="Dentist appointment"`, `dueDate=<Friday>`, `priority=medium`.
2. Event `date=<Friday>`, `time=14:00`.
3. Expense `amount=150`, `category=health`.

UI: Tasks page, Calendar page, Finance page each show the new record.

### Scenario C — subscription setup
Input: `I'm paying $15 for Netflix every month starting Friday`

Expected:
- Obligation `name=Netflix`, `amount=15`, `frequency=monthly`, `nextDueDate=<Friday>`.
- Auto-created subscription profile "Netflix".
- Calendar shows Netflix on the same day-of-month going forward.

### Scenario D — receipt upload
Upload a grocery receipt image ($45.32).

Expected:
- Document saved with extracted vendor/date/amount/items.
- Pending-extraction UI presents fields for review.
- On confirm: expense created with `amount=45.32`, `category=food`, `date=<receipt date>`.

### Scenario E — chart
Input: `Show my spending as a pie chart this month`

Expected: `generate_chart` returns a `ChartSpec` (pie / expenses / current month).
Chat renders an interactive pie chart — never a prose breakdown.

### Scenario F — goal progress
Inputs in order:
1. `Create a goal to lose 15 lbs by June 30`
2. `I'm at 185 lbs now`
3. `How am I doing on my weight loss?`

Expected:
- Goal `type=weight_loss`, `target=15`, `unit=lbs`, `startValue=185`, `deadline=2026-06-30`.
- Weight entry updates progress.
- `get_goal_progress` returns progress bar + remaining days.

---

## 7. Invariants the tester should check

1. `forProfile` must be set whenever the command references a non-self entity.
2. Dedup: do not create the same item twice within 30 s.
3. No fabrication: never invent data the API didn't return.
4. Mood inference: extract from context (motivated → great, tired → bad).
5. Nutrition macros scale to portion size.
6. Each profile has its own independent trackers.
7. Dates default to Pacific Time unless specified.
8. Ambiguous deletes must prompt for confirmation.
9. Visual requests always call `generate_chart` — never prose charts.
10. Document uploads require user confirmation before saving extracted fields.

---

## 8. Key schema tables (`shared/schema.ts`)

- `profiles` — name, type, fields, tags, notes, linkedTrackers, createdAt.
- `trackers` — name, category, unit, fields.
- `trackerEntries` — values, computed, mood, tags, forProfile, timestamp.
- `tasks` — title, status (todo/in_progress/done), priority, dueDate, linkedProfiles.
- `expenses` — amount, category, description, vendor, date, linkedProfiles.
- `obligations` — name, amount, frequency, nextDueDate, payments[], status.
- `habits` — name, frequency, currentStreak, longestStreak, checkins[].
- `journalEntries` — date, mood, content, tags, energy, gratitude, highlights.
- `calendarEvents` — title, date, time, category, recurrence, linkedProfiles.
- `goals` — title, type, target, current, unit, deadline, status, milestones.
- `documents` — name, type, mimeType, extractedData, linkedProfiles.
- `memories` — key, value, category.
- `artifacts` — type, title, content, items, dataBindings.

---

## 9. Totals

- 80+ REST endpoints.
- 60+ AI tool definitions in `server/ai-engine.ts`.
- Coverage: health, fitness, finance, calendar, documents, goals, habits,
  memories, journal, artifacts, and user-defined custom domains.
