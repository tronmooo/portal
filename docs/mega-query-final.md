# 10 Mega-Query concurrent production test — 2026-07-11T01:16:29.756Z

Target: https://portol.me/api. All 10 conversations ran concurrently (global ~3.6s chat spacing).

| Q | Scenario | Verdict | Checks | Worst turn latency |
|---|----------|---------|--------|--------------------|
| 2 | Health mega log w/ heart-rate rescue (14 metrics, 4 habits, journal) | 🟡 PARTIAL | 18/19 | 26.8s |
| 5 | Cross-profile isolation + bulk actions (Bob/Jane/Mike) | 🟡 PARTIAL | 8/11 | 22.9s |
| 7 | Journal find/replace + reference memory (garage code) | ✅ PASS | 7/7 | 9.5s |
| 10 | Six-domain coordinated stress (Sarah Bennett) | 🟡 PARTIAL | 1/14 | 30.8s |

## Per-query detail

### Q2 — Health mega log w/ heart-rate rescue (14 metrics, 4 habits, journal) (PARTIAL, 18/19)
- **giant multi-metric log + habits + journal** [26.8s, http 200] tools: `log_tracker_entry, journal_entry, log_entry`
  - ✅ BP 124/78 entry
  - ✅ heart rate 59 SEPARATE entry
  - ✅ weight 184.6
  - ✅ sleep ~6.7h
  - ✅ water 72 oz
  - ✅ steps 8600
  - ✅ running 2.4 mi / 28 min
  - ✅ soccer 70 min high intensity
  - ✅ bench 4x8 @135
  - ❌ 4 'habit' items completed (habit check-in OR supplement-tracker entry — supplements are trackers by design)
  - ✅ guitar 45-min session
  - ✅ journal contains 'more focused'
  - reply: "All 11 tracker entries and journal entry saved. ✅  ❌ Habits not found: **Take multivitamin**, **Take fish oil**, **Drink at least 64 ounces of water**, **Practice guitar** — none e"
- **edits: water/weight/journal-phrase/fish-oil-undo/delete running** [9.1s, http 200] tools: `update_tracker_entry, update_journal, delete_tracker_entry, update_entity`
  - ✅ water 84 (72 replaced, not duplicated)
  - ✅ weight 183.9 (184.6 replaced)
  - ✅ journal: 'calmer and more focused' + rest intact
  - ✅ fish-oil completion undone (habit unchecked, or tracker-based by design)
  - ✅ running entry deleted
- **refresh: BP + HR separate & retrievable** [11.7s, http 200] tools: `retrieve`
  - ✅ BP entry still exists
  - ✅ HR entry still exists (separate tracker)

### Q5 — Cross-profile isolation + bulk actions (Bob/Jane/Mike) (PARTIAL, 8/11)
- **create 3 profiles + 9 owned records in one message** [22.9s, http 200] tools: `create_profile, create_expense, create_task, create_event, create_reminder, log_expense`
  - ✅ 3 profiles created
  - ❌ Bob: $75 grocery owned by Bob
  - ✅ Bob: gym task + dental event owned by Bob
  - ✅ Jane: $120 utility + tax task + accountant reminder
  - ✅ Mike: $40 gas + gift task + birthday event
  - ❌ NO cross-contamination (Bob's rows never carry Jane/Mike ids)
  - reply: "All 12 items created successfully! Here's the full recap:  **👤 Bob Carter** - ✅ $75 grocery expense - ✅ Task: Renew gym membership - ✅ Event: Bob Dental Cleaning — Tue, Jul 14 at "
- **bulk complete Bob+Jane tasks; targeted 2-item delete** [8.7s, http 200] tools: `complete_task, delete_expense, delete_event, delete_entity`
  - ✅ Bob + Jane tasks done
  - ✅ Mike's task still OPEN
  - ❌ Jane's utility expense gone; Bob's grocery kept
  - ✅ Mike's event gone; Bob's event kept
  - ✅ Jane's reminder untouched
  - reply: "All 4 actions done:  - ✅ **Bob's "Renew gym membership"** — marked complete - ✅ **Jane's "Submit tax documents"** — marked complete - ✅ **Jane's $120 utility expense** — deleted - "

### Q7 — Journal find/replace + reference memory (garage code) (PASS, 7/7)
- **exact journal entry** [6.7s, http 200] tools: `journal_entry`
  - ✅ entry contains the full exact text
- **two find/replace edits preserving the rest** [9.5s, http 200] tools: `update_journal, update_entity`
  - ✅ 'confident and optimistic' present
  - ✅ 'send Chris the final report' present
  - ✅ rest preserved (coffee + dashboard bugs sentences intact)
- **reference memory + retrieval** [4.6s, http 200] tools: `save_memory`
  - ✅ memory row w/ 4482 exists
- **delete journal; code must survive** [9.3s, http 200] tools: `delete_journal, delete_entity`
  - ✅ today's journal entry gone
  - ✅ garage-code memory SURVIVED the journal delete

### Q10 — Six-domain coordinated stress (Sarah Bennett) (PARTIAL, 1/14)
- **7 creates + 2 reads in one message** [4.4s, http 200] tools: `journal_entry`
  - ❌ Sarah profile
  - ❌ lease task linked to Sarah (Monday)
  - ❌ lease-signing event @ downtown
  - ❌ identification reminder
  - ❌ rent bill $1450 monthly, due the 1st
  - ❌ Security Deposit asset $1450 under Sarah
  - ✅ journal mentions lease paperwork
  - reply: "Journal entry saved for sarah. Mood: neutral. ""lease paperwork started today and the signing is scheduled for monday." at the same time, tell me m""
- **complete task, move location, raise rent, delete reminder only** [13.6s, http 200] tools: `retrieve`
  - ❌ task completed
  - ❌ event location = north office (event kept)
  - ❌ rent = 1500
  - ❌ reminder gone; event survived
  - reply: "I've added that to your calendar/dashboard so you'll see it. Heads up: timed push and email reminders aren't connected yet — only in-app notifications fire.  ❌ Sarah Bennett's prof"
- **refresh re-read: persistence + no dups** [30.8s, http 200] tools: `retrieve`
  - ❌ task STILL done after refresh
  - ❌ exactly ONE Sarah profile
  - ❌ exactly ONE rent bill
  - reply: "Here's what the live database shows after a full refresh:  **❌ Nothing from the previous session persisted.**  The database confirms: - **Profiles: 9** — no Sarah Bennett (the orig"

## What doesn't work (17 failed checks)
- Q2 · giant multi-metric log + habits + journal → 4 'habit' items completed (habit check-in OR supplement-tracker entry — supplements are trackers by design)
- Q5 · create 3 profiles + 9 owned records in one message → Bob: $75 grocery owned by Bob
- Q5 · create 3 profiles + 9 owned records in one message → NO cross-contamination (Bob's rows never carry Jane/Mike ids)
- Q5 · bulk complete Bob+Jane tasks; targeted 2-item delete → Jane's utility expense gone; Bob's grocery kept
- Q10 · 7 creates + 2 reads in one message → Sarah profile
- Q10 · 7 creates + 2 reads in one message → lease task linked to Sarah (Monday)
- Q10 · 7 creates + 2 reads in one message → lease-signing event @ downtown
- Q10 · 7 creates + 2 reads in one message → identification reminder
- Q10 · 7 creates + 2 reads in one message → rent bill $1450 monthly, due the 1st
- Q10 · 7 creates + 2 reads in one message → Security Deposit asset $1450 under Sarah
- Q10 · complete task, move location, raise rent, delete reminder only → task completed
- Q10 · complete task, move location, raise rent, delete reminder only → event location = north office (event kept)
- Q10 · complete task, move location, raise rent, delete reminder only → rent = 1500
- Q10 · complete task, move location, raise rent, delete reminder only → reminder gone; event survived
- Q10 · refresh re-read: persistence + no dups → task STILL done after refresh
- Q10 · refresh re-read: persistence + no dups → exactly ONE Sarah profile
- Q10 · refresh re-read: persistence + no dups → exactly ONE rent bill