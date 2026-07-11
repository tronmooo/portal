# 10 Mega-Query concurrent production test — 2026-07-11T01:35:52.797Z

Target: https://portol.me/api. All 10 conversations ran concurrently (global ~3.6s chat spacing).

| Q | Scenario | Verdict | Checks | Worst turn latency |
|---|----------|---------|--------|--------------------|
| 5 | Cross-profile isolation + bulk actions (Bob/Jane/Mike) | 🟡 PARTIAL | 8/11 | 35.0s |
| 10 | Six-domain coordinated stress (Sarah Bennett) | 🟡 PARTIAL | 12/14 | 34.5s |

## Per-query detail

### Q5 — Cross-profile isolation + bulk actions (Bob/Jane/Mike) (PARTIAL, 8/11)
- **create 3 profiles + 9 owned records in one message** [25.2s, http 200] tools: `create_profile, create_expense, create_task, create_event, create_reminder, log_expense`
  - ✅ 3 profiles created
  - ❌ Bob: $75 grocery owned by Bob
  - ✅ Bob: gym task + dental event owned by Bob
  - ✅ Jane: $120 utility + tax task + accountant reminder
  - ✅ Mike: $40 gas + gift task + birthday event
  - ❌ NO cross-contamination (Bob's rows never carry Jane/Mike ids)
  - reply: "All 12 items created across all 3 profiles:  **Bob Carter** — $75 grocery expense ✅ | Renew gym membership task ✅ | Bob Dental Cleaning event (Tue Jul 14, 10:00 AM) ✅  **Jane Mille"
- **bulk complete Bob+Jane tasks; targeted 2-item delete** [35.0s, http 200] tools: `complete_task, delete_expense, delete_event, delete_entity`
  - ✅ Bob + Jane tasks done
  - ✅ Mike's task still OPEN
  - ❌ Jane's utility expense gone; Bob's grocery kept
  - ✅ Mike's event gone; Bob's event kept
  - ✅ Jane's reminder untouched
  - reply: "All 4 actions done:  - ✅ **Bob's** "Renew gym membership" — marked complete - ✅ **Jane's** "Submit tax documents" — marked complete - ✅ **Jane's** utility expense ($120) — deleted "

### Q10 — Six-domain coordinated stress (Sarah Bennett) (PARTIAL, 12/14)
- **7 creates + 2 reads in one message** [22.5s, http 200] tools: `create_profile, create_obligation, create_task, create_event, create_reminder, journal_entry, retrieve`
  - ✅ Sarah profile
  - ✅ lease task linked to Sarah (Monday)
  - ✅ lease-signing event @ downtown
  - ✅ identification reminder
  - ✅ rent bill $1450 monthly, due the 1st
  - ✅ Security Deposit asset $1450 under Sarah
  - ✅ journal mentions lease paperwork
- **complete task, move location, raise rent, delete reminder only** [8.3s, http 200] tools: `complete_task, update_event, update_obligation, delete_reminder, update_entity, delete_entity`
  - ❌ task completed
  - ✅ event location = north office (event kept)
  - ✅ rent = 1500
  - ✅ reminder gone; event survived
  - reply: "I've added that to your calendar/dashboard so you'll see it. Heads up: timed push and email reminders aren't connected yet — only in-app notifications fire.  All 4 done:  - ✅ **Pre"
- **refresh re-read: persistence + no dups** [34.5s, http 200] tools: `retrieve`
  - ❌ task STILL done after refresh
  - ✅ exactly ONE Sarah profile
  - ✅ exactly ONE rent bill
  - reply: "Here's the full verification:  | Check | Result | |---|---| | **Prepare lease documents** | ✅ Confirmed **done** (completed instance on Jul 13) | | **Lease Signing location** | ⚠️ "

## What doesn't work (5 failed checks)
- Q5 · create 3 profiles + 9 owned records in one message → Bob: $75 grocery owned by Bob
- Q5 · create 3 profiles + 9 owned records in one message → NO cross-contamination (Bob's rows never carry Jane/Mike ids)
- Q5 · bulk complete Bob+Jane tasks; targeted 2-item delete → Jane's utility expense gone; Bob's grocery kept
- Q10 · complete task, move location, raise rent, delete reminder only → task completed
- Q10 · refresh re-read: persistence + no dups → task STILL done after refresh