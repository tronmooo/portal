# Portol AI Chat — Command Catalog (205 examples)

**Engine:** `claude-sonnet-4-6` · up to **30 tool calls / 15 reasoning rounds per message** · 92 wired tools (no dead tools).

**Legend**
- ✅ **Works** — what it's supposed to do = what it actually does.
- ⚠️ **Partial** — data is saved correctly but it's hard/impossible to *see* where you'd expect, or has an edge-case bug.
- ❌ **Broken / Missing** — no tool exists, or it silently fails.

---

## 1. Tasks (`create_task`, `complete_task`, `update_task`, `delete_task`, `bulk_complete_tasks`, `query_tasks`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 1 | "Add a task to call the dentist" | Create task | ✅ Shows on Tasks page |
| 2 | "Remind me to buy groceries tomorrow" | Task w/ due date | ✅ (no push reminder — calendar/task only) |
| 3 | "Mark the dentist task as done" | Complete task | ✅ |
| 4 | "Check off 'buy groceries'" | Complete task | ✅ |
| 5 | "Complete all my tasks" | Bulk complete | ✅ `bulk_complete_tasks` |
| 6 | "Mark tasks 1, 2 and 3 done" | Bulk complete | ✅ |
| 7 | "Rename 'call dentist' to 'call dentist re: crown'" | Update task | ✅ |
| 8 | "Change the grocery task due date to Friday" | Update task | ✅ |
| 9 | "Delete the grocery task" | Delete task | ✅ |
| 10 | "What tasks do I have?" | List tasks | ✅ `query_tasks` |
| 11 | "What's overdue?" | List overdue | ✅ |
| 12 | "Add 5 tasks: laundry, dishes, vacuum, mow lawn, trash" | 5 tasks in one message | ✅ (multi-action, ≤30) |
| 13 | "Make 'pay rent' high priority" | Update priority | ✅ |
| 14 | "Add a task for Bob to wash the car" | Task linked to Bob | ✅ links to profile |
| 15 | "Set a recurring task to water plants weekly" | **Recurring task** | ❌ **No recurring tasks** — creates a single one-off only |

## 2. Calendar / Events (`create_event`, `update_event`, `complete_event`, `delete_event`, `query_calendar`, `sync_calendar`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 16 | "Dentist next Monday at 10am" | Event on resolved date | ✅ — **if** AI resolves the date to YYYY-MM-DD |
| 17 | "Schedule a meeting Friday 3pm" | Event | ✅ |
| 18 | "Add my anniversary on June 14" | Event | ✅ |
| 19 | "Doctor appointment tomorrow" | Event tomorrow | ✅ |
| 20 | "Mark the dentist appointment done" | Complete event | ✅ `complete_event` |
| 21 | "Check off today's meeting" | Complete event | ✅ |
| 22 | "Move my Friday meeting to Monday" | Update event date | ✅ `update_event` |
| 23 | "Cancel the dentist appointment" | Delete event | ✅ |
| 24 | "What's on my calendar this week?" | List events | ✅ `query_calendar` |
| 25 | "What do I have on the 9th?" | List that day | ✅ |
| 26 | "Schedule X sometime next week" (vague) | Needs a date | ⚠️ AI must pick a date or it errors silently |
| 27 | "Add an event with no date" | — | ❌ Returns `{error}`; AI *should* admit it but sometimes says "Done" |
| 28 | "Add a 2-hour block for deep work tomorrow 9am" | Event w/ duration | ✅ |
| 29 | "Schedule weekly standup every Monday" | Recurring event | ✅ events support recurrence |
| 30 | "Put Bob's birthday on the calendar June 3 every year" | Yearly recurring | ✅ |
| 31 | "Sync my calendar" | Pull external calendar | ⚠️ `sync_calendar` is internal-only, not Google/Apple |
| 32 | "Remind me 30 min before the meeting" | Push reminder | ❌ **No notifications/reminders engine** |
| 33 | "Reschedule all of next week to the week after" | Bulk move | ⚠️ Works one event at a time, may hit 30-call cap |
| 34 | "Add 'gym' Mon/Wed/Fri 6am" | 3 events / recurring | ✅ |
| 35 | "Block my calendar for vacation July 1–7" | Multi-day event | ✅ |

## 3. Obligations · Bills · Subscriptions (`create_obligation`, `pay_obligation`, `update_obligation`, `delete_obligation`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 36 | "Add Netflix $15/month due on the 9th" | Obligation + monthly calendar on 9th + sub profile | ✅ calendar + bill; ⚠️ sub not in Finance list |
| 37 | "Spotify $11 every month" | Recurring bill | ⚠️ Works but **due date defaults to +30 days** (not a fixed day-of-month) unless you specify |
| 38 | "I pay $1,800 rent on the 1st" | Monthly obligation | ✅ on calendar each month |
| 39 | "Car insurance $140/month" | Obligation | ✅ |
| 40 | "Gym membership $40 monthly" | Obligation + sub profile | ⚠️ sub profile only on Profiles page |
| 41 | "Property tax $3,000 yearly in November" | Yearly obligation | ✅ |
| 42 | "Water bill $60 quarterly" | Quarterly | ✅ |
| 43 | "One-time $500 bill on June 20" | Single occurrence | ❌ **Bug:** AI sends `one-time`, engine only knows `once` → mis-materializes |
| 44 | "I paid Netflix this month" | Mark paid | ✅ `pay_obligation` |
| 45 | "Mark rent as paid" | Mark paid | ✅ |
| 46 | "I missed the November car payment" | Log skip, no balance change | ✅ (via liability path for loans) |
| 47 | "Change Netflix to $18/month" | Update amount | ✅ `update_obligation` |
| 48 | "Cancel my Spotify subscription" | Delete obligation | ✅ removes bill (sub profile may linger) ⚠️ |
| 49 | "List all my subscriptions" | Show subs | ⚠️ Surfaces as bills; **no unified Subscriptions view** |
| 50 | "How much do my subscriptions cost per month?" | Sum monthly | ✅ via Monthly Bills KPI |
| 51 | "Add 10 subscriptions: Netflix, Hulu, Disney+, HBO, Spotify, Apple, Amazon, NYT, Adobe, Dropbox" | 10 obligations | ✅ (multi-action) |
| 52 | "Set Netflix to autopay" | Mark autopay | ✅ |
| 53 | "When is my next bill due?" | Next due date | ✅ |
| 54 | "What bills are due this month?" | List due | ✅ |
| 55 | "Add my $250 student loan payment monthly" | **Should be a liability** | ⚠️ AI is told to route loans to `create_liability`, not obligation |
| 56 | "Phone bill $90 for Bob" | Obligation linked to Bob | ✅ |
| 57 | "Stop the gym after December" | recurrence end | ✅ if AI sets recurrence_end |
| 58 | "Netflix due on the 31st" | Monthly on 31st | ⚠️ JS month rollover edge case on short months |
| 59 | "Did I pay rent this month?" | Status check | ✅ |
| 60 | "Show subscriptions on the calendar" | They auto-appear | ✅ each due date is on the calendar |

## 4. Expenses · Income · Cashflow (`create_expense`, `update_expense`, `delete_expense`, `log_income`, `log_expected_paycheck`, `confirm_paycheck_received`, `get_cashflow`, `spending_analytics`, `query_expenses`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 61 | "I spent $50 on groceries" | Log expense | ✅ Finance |
| 62 | "$12 lunch today" | Expense | ✅ |
| 63 | "Bought gas for $60" | Expense (transport) | ✅ auto-category |
| 64 | "$200 at Target yesterday" | Expense w/ vendor+date | ✅ |
| 65 | "Log 5 expenses: …" | Multiple | ✅ |
| 66 | "Change the grocery expense to $55" | Update | ✅ |
| 67 | "Delete the $12 lunch" | Delete | ✅ |
| 68 | "I got paid $3,000" | Log income | ✅ |
| 69 | "My paycheck is $2,500 every two weeks" | Expected paycheck | ✅ `log_expected_paycheck` |
| 70 | "Confirm I got my paycheck" | Mark received | ✅ |
| 71 | "How much did I spend this month?" | Total | ✅ `spending_analytics` |
| 72 | "What's my biggest spending category?" | Breakdown | ✅ |
| 73 | "Spending this month vs last" | Comparison | ✅ |
| 74 | "What's my cashflow?" | Income − expenses | ✅ `get_cashflow` |
| 75 | "Show my expenses for June" | List | ✅ `query_expenses` |
| 76 | "How much on eating out?" | Category filter | ✅ |
| 77 | "Average daily spend?" | Stat | ✅ |
| 78 | "Tag this expense as business" | Update category | ✅ |
| 79 | "Split a $100 dinner with Sarah" | Shared expense | ⚠️ logs expense; splitting is ownership-based, partial |
| 80 | "Refund $30 to my grocery total" | Negative/adjust | ⚠️ no true refund type; logs as expense edit |
| 81 | "How much do I spend on subscriptions?" | Sum | ✅ |
| 82 | "Recurring expense $20/mo for parking" | Recurring | ⚠️ recurring = obligation, not expense; AI should route to `create_obligation` |
| 83 | "I earn $500/mo side income" | Income | ✅ `log_income` |
| 84 | "Forecast next month's cashflow" | Projection | ⚠️ Current cashflow yes; true forecast limited |
| 85 | "Expenses for Bob's car" | Linked filter | ✅ |
| 86 | "What did I spend at Amazon?" | Vendor filter | ✅ |
| 87 | "Total spent this year" | YTD | ✅ |
| 88 | "Categorize my uncategorized expenses" | Re-categorize | ⚠️ one at a time |
| 89 | "Add a $1,200 expense for a new laptop" | Big expense | ✅ |
| 90 | "Mark the laptop expense as an asset" | Convert to asset | ❌ No expense→asset conversion tool |

## 5. Budgets (`set_budget`, `create_budget`, `update_budget`, `delete_budget`, `get_budget_summary`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 91 | "Set a $400 grocery budget" | Create budget | ✅ |
| 92 | "Budget $100/mo for entertainment" | Budget | ✅ |
| 93 | "How am I doing on my food budget?" | % used | ✅ `get_budget_summary` |
| 94 | "Change grocery budget to $500" | Update | ✅ |
| 95 | "Delete the entertainment budget" | Delete | ✅ |
| 96 | "Am I over budget anywhere?" | Over-budget list | ✅ |
| 97 | "Set budgets for all categories" | Many budgets | ✅ multi-action |
| 98 | "What's left in my dining budget?" | Remaining | ✅ |
| 99 | "Budget summary" | All budgets | ✅ |
| 100 | "Alert me when I hit 80% of budget" | Threshold alert | ❌ No alerting engine |

## 6. Liabilities · Debt (`create_liability`, `update_liability`, `add_liability_payment`, `get_loan_schedule`, `get_liability_summary`, link/unlink asset/owner)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 101 | "Add my car loan, $30k at 6% for 5 years" | Liability w/ schedule | ✅ full detail UI |
| 102 | "Mortgage $400k at 4.5%, 30 years" | Liability | ✅ |
| 103 | "Student loan $25k at 5%" | Liability | ✅ |
| 104 | "Credit card balance $3,000 at 22%" | Liability (credit_card) | ✅ subtype detected |
| 105 | "I owe my dad $5,000" | Personal loan | ✅ |
| 106 | "Affirm $600 over 6 months" | BNPL liability | ✅ |
| 107 | "IRS tax debt $4,000" | Tax liability | ✅ |
| 108 | "HELOC $50k" | Liability | ✅ |
| 109 | "I paid $500 on my car loan" | Payment split P/I | ✅ Payments + Activity |
| 110 | "Extra $2,000 principal on the mortgage" | Principal-only | ✅ principal set, interest 0 |
| 111 | "I missed last month's mortgage payment" | Log skip | ✅ |
| 112 | "Reverse the duplicate $200 payment" | Reversal | ✅ |
| 113 | "Show my loan payoff schedule" | Amortization | ✅ `get_loan_schedule` |
| 114 | "When will my car be paid off?" | Payoff date | ✅ |
| 115 | "Total debt?" | Sum | ✅ `get_liability_summary` |
| 116 | "Change my mortgage rate to 4%" | Update | ✅ |
| 117 | "This loan is split 50/50 with my wife" | Co-owner | ✅ `link_liability_owner` |
| 118 | "My dad co-signed the car loan" | Co-signer | ✅ |
| 119 | "I now own 100%, remove my dad" | Reallocate | ✅ replaceExisting |
| 120 | "Link the car loan to my Honda" | Asset↔liability | ✅ `link_liability_asset` |
| 121 | "Unlink the loan from the car" | Unlink | ✅ |
| 122 | "How much interest will I pay total?" | Total interest | ✅ |
| 123 | "Pay off the credit card" | Zero balance | ✅ |
| 124 | "Refinance my mortgage to 3.5%" | Update terms | ⚠️ updates rate; no refinance event modeling |
| 125 | "Convert this loan into an asset I'm owed" | move_liability_to_asset | ✅ |

## 7. Profiles · Assets · Entities (`create_profile`, `update_profile`, `delete_profile`, `revalue_asset`, `get_asset_rollup`, `get_profile_data`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 126 | "Add my 2022 Tesla Model 3" | Vehicle profile | ✅ exact year/model kept |
| 127 | "Add my dog Max, golden retriever" | Pet profile | ✅ |
| 128 | "Add my house at 123 Main St" | Property | ✅ |
| 129 | "Add my iPhone 15 Pro" | Asset | ✅ |
| 130 | "Add my friend Bob, phone 555-1234" | Person | ✅ |
| 131 | "Add my doctor, Dr. Smith, cardiology" | Medical | ✅ |
| 132 | "Add my savings account, $10k" | Asset (bank_account) | ✅ subtype detected |
| 133 | "Add my Bitcoin, 0.5 BTC" | Digital asset | ✅ |
| 134 | "Add my business, Acme LLC" | Business asset | ✅ |
| 135 | "Bob's Honda Civic" | Vehicle under Bob | ✅ nested as child profile |
| 136 | "My wife's car, a Subaru" | Vehicle under wife | ✅ |
| 137 | "Update my Tesla mileage to 25,000" | Update field | ✅ |
| 138 | "My house is now worth $450k" | Revalue | ✅ `revalue_asset` |
| 139 | "What's my Tesla worth?" | AI valuation | ✅ live estimate |
| 140 | "Delete the old iPhone profile" | Delete | ✅ |
| 141 | "What's my total net worth?" | Assets − liabilities | ✅ `get_asset_rollup` |
| 142 | "Show all my vehicles" | Filter | ✅ |
| 143 | "Add VIN to my Tesla" | Update | ✅ |
| 144 | "Add my 401k, $80k" | Investment | ✅ |
| 145 | "Add my rental property" | Property | ✅ |
| 146 | "Tag my Tesla as 'for sale'" | Tag | ✅ |
| 147 | "Add warranty info to my laptop" | Update | ✅ |
| 148 | "Add a loan I made — $2k to my brother" | loan_receivable asset | ✅ |
| 149 | "Add my collectible watch, $5k" | Collectible | ✅ |
| 150 | "Show everything about Bob" | Profile dump | ✅ `get_profile_data` |

## 8. Relationships · Ownership · Links (`link_entities`, `get_related`, `link_asset_owner`, `split_ownership`, `get_relationships`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 151 | "Split the Porsche 60/40 with Sarah" | Co-ownership | ✅ |
| 152 | "Add my wife as co-owner of the house" | Co-owner | ✅ |
| 153 | "Mom is trustee of this account" | Trustee | ✅ |
| 154 | "Link the insurance doc to my car" | Entity link | ✅ `link_entities` |
| 155 | "What's connected to my house?" | Related items | ✅ `get_related` |
| 156 | "Who owns what?" | Ownership map | ✅ `get_relationships` |
| 157 | "Change ownership to 70/30" | Reallocate | ✅ replaceExisting |
| 158 | "Make Bob the beneficiary" | Beneficiary | ✅ |
| 159 | "Link Bob to his car and his phone bill" | Multi-link | ✅ |
| 160 | "Unlink Sarah from the Porsche" | Remove owner | ✅ removeOwnerName |

## 9. Trackers · Health (`create_tracker`, `log_tracker_entry`, `update_tracker`, `delete_tracker`, entry edits, `delete_tracker_entry`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 161 | "Log my weight 180 lbs" | Health entry | ✅ Trackers + chart |
| 162 | "BP 120/80" | Blood pressure | ✅ (fast-path) |
| 163 | "Slept 7 hours" | Sleep | ✅ |
| 164 | "Ran 3 miles in 25 min" | Fitness | ✅ |
| 165 | "Track my water intake" | New tracker | ✅ `create_tracker` |
| 166 | "Log 64oz water" | Entry | ✅ |
| 167 | "My mood is good today" | Mood | ✅ |
| 168 | "Show my weight trend" | Chart | ✅ `generate_chart` |
| 169 | "Track my blood sugar" | New tracker | ✅ |
| 170 | "Log glucose 95" | Entry | ✅ |
| 171 | "Fix yesterday's weight to 178" | Edit entry | ✅ `update_tracker_entry` |
| 172 | "Delete the wrong BP reading" | Delete entry | ✅ |
| 173 | "Delete my water tracker" | Delete tracker | ✅ |
| 174 | "Log a workout for Bob" | Linked entry | ✅ |
| 175 | "What's my average sleep this week?" | Stat | ✅ |

## 10. Habits (`create_habit`, `checkin_habit`, `uncomplete_habit`, `update_habit`, `delete_habit`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 176 | "New habit: meditate daily" | Create habit | ✅ |
| 177 | "I meditated today" | Check in + streak | ✅ |
| 178 | "Habit: read 20 min every day" | Create | ✅ |
| 179 | "Mark my reading habit done" | Check in | ✅ |
| 180 | "Undo today's meditation check-in" | Uncomplete | ✅ |
| 181 | "Change meditation to weekly" | Update | ✅ |
| 182 | "Delete the reading habit" | Delete | ✅ |
| 183 | "What's my meditation streak?" | Streak | ✅ |
| 184 | "Add 3 habits: water, walk, stretch" | Multiple | ✅ |
| 185 | "Remind me to do my habits" | Reminder | ❌ No reminders |

## 11. Journal (`journal_entry`, `update_journal`, `delete_journal`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 186 | "Journal: today was great, felt productive" | Entry | ✅ |
| 187 | "Add to today's journal: had a good run" | Append | ✅ appends (1 entry/day) |
| 188 | "I'm grateful for my family" | Gratitude field | ✅ |
| 189 | "Edit today's journal entry" | Update | ✅ |
| 190 | "Delete yesterday's journal" | Delete | ✅ |

## 12. Goals (`create_goal`, `get_goal_progress`, `update_goal`, `delete_goal`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 191 | "Goal: save $10,000 by December" | Create goal | ⚠️ Saved but **no dedicated Goals page** (shows on dashboard/profile) |
| 192 | "How am I doing on my savings goal?" | Progress | ⚠️ Returns progress; visibility limited |
| 193 | "Update my goal target to $15k" | Update | ✅ data updates |
| 194 | "Goal: lose 10 lbs" | Create | ⚠️ same visibility gap |
| 195 | "Delete my savings goal" | Delete | ✅ |

## 13. Documents · Artifacts · Reports · Charts (`upload_document`, `create_document`, `open_document`, `retrieve_document`, `manage_document`, `search_documents`, `create_artifact`, `generate_chart`, `generate_table`, `generate_report`)

| # | You say | Supposed to do | Actually does |
|---|---|---|---|
| 196 | "Show my spending as a pie chart" | Inline chart | ✅ renders live |
| 197 | "Make a bar chart of monthly spend" | Chart | ✅ |
| 198 | "Create a table of my subscriptions" | Table | ✅ `generate_table` |
| 199 | "Write me a financial report" | Report artifact | ✅ chat card + Artifacts page |
| 200 | "Find my insurance document" | Search docs | ✅ `search_documents` |
| 201 | "Open my passport scan" | Open doc | ✅ |
| 202 | "Rename this document" | Manage | ✅ `manage_document` |
| 203 | "Create a note about my car maintenance" | Document | ✅ |
| 204 | "Re-extract data from this receipt" | Re-extract | ✅ |
| 205 | "Summarize all my health records" | Report | ✅ |

## 14. Memory · Navigation · Recall (`save_memory`, `recall_memory`, `delete_memory`, `navigate`, `recall_actions`, `refresh_ai_summary`, `search`)

| Extra | You say | Supposed to do | Actually does |
|---|---|---|---|
| A | "Remember my anniversary is June 14" | Save memory | ✅ |
| B | "What do you remember about me?" | Recall | ✅ |
| C | "Forget that" | Delete memory | ✅ |
| D | "Take me to my finance page" | Navigate | ✅ `navigate` |
| E | "What did I just do?" | Recent actions | ✅ `recall_actions` |
| F | "Refresh my profile summary" | Re-summarize | ✅ |
| G | "Search everything for 'Tesla'" | Global search | ✅ |

---

## Summary of every DIFFERENCE (supposed ≠ actual)

| Area | Gap |
|---|---|
| **Subscriptions in Finance** | Created as obligation + hidden sub profile; **no Subscriptions list in Finance** (only the $ in "Monthly Bills"). Sub profile shows on Profiles page only. |
| **One-time obligations** | AI sends `one-time`; engine only understands `once` → calendar occurrence misfires. |
| **Subscription due date** | Defaults to **+30 days** unless you explicitly say a day ("on the 9th"). |
| **Goals** | No dedicated Goals page/route; goals only surface on dashboard/profile. |
| **Recurring tasks** | Not supported (only obligations & events recur). |
| **Reminders / notifications / alerts** | No engine — nothing pings you (budget alerts, bill reminders, habit nudges all absent). |
| **External calendar sync** | `sync_calendar` is internal-only (no Google/Apple). |
| **Recurring expenses** | Should be modeled as obligations; plain "recurring expense" has no recurrence. |
| **Expense→Asset / refunds** | No conversion or true refund type. |
| **Reliability** | Model can reply "✅ Done!" without actually calling the tool — the main cause of "I added it but it's not there." |
| **Per-message cap** | 30 tool calls / 15 rounds; extra actions in one giant message get rejected. |
