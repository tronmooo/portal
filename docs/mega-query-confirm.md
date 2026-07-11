# 10 Mega-Query concurrent production test — 2026-07-11T01:40:41.217Z

Target: https://portol.me/api. All 10 conversations ran concurrently (global ~3.6s chat spacing).

| Q | Scenario | Verdict | Checks | Worst turn latency |
|---|----------|---------|--------|--------------------|
| 5 | Cross-profile isolation + bulk actions (Bob/Jane/Mike) | ✅ PASS | 11/11 | 25.4s |
| 10 | Six-domain coordinated stress (Sarah Bennett) | ✅ PASS | 14/14 | 32.6s |

## Per-query detail

### Q5 — Cross-profile isolation + bulk actions (Bob/Jane/Mike) (PASS, 11/11)
- **create 3 profiles + 9 owned records in one message** [25.4s, http 200] tools: `create_profile, create_expense, create_task, create_event, create_reminder, log_expense`
  - ✅ 3 profiles created
  - ✅ Bob: $75 grocery owned by Bob
  - ✅ Bob: gym task + dental event owned by Bob
  - ✅ Jane: $120 utility + tax task + accountant reminder
  - ✅ Mike: $40 gas + gift task + birthday event
  - ✅ NO cross-contamination (Bob's rows never carry Jane/Mike ids)
- **bulk complete Bob+Jane tasks; targeted 2-item delete** [10.8s, http 200] tools: `complete_task, delete_expense, delete_event, delete_entity`
  - ✅ Bob + Jane tasks done
  - ✅ Mike's task still OPEN
  - ✅ Jane's utility expense gone; Bob's grocery kept
  - ✅ Mike's event gone; Bob's event kept
  - ✅ Jane's reminder untouched

### Q10 — Six-domain coordinated stress (Sarah Bennett) (PASS, 14/14)
- **7 creates + 2 reads in one message** [32.6s, http 200] tools: `create_profile, create_task, create_event, create_reminder, create_obligation, journal_entry, retrieve`
  - ✅ Sarah profile
  - ✅ lease task linked to Sarah (Monday)
  - ✅ lease-signing event @ downtown
  - ✅ identification reminder
  - ✅ rent bill $1450 monthly, due the 1st
  - ✅ Security Deposit asset $1450 under Sarah
  - ✅ journal mentions lease paperwork
- **complete task, move location, raise rent, delete reminder only** [9.0s, http 200] tools: `complete_task, update_event, update_obligation, delete_reminder, update_entity, delete_entity`
  - ✅ task completed (any matching row/instance done)
  - ✅ event location = north office (event kept)
  - ✅ rent = 1500
  - ✅ reminder gone; event survived
- **refresh re-read: persistence + no dups** [12.8s, http 200] tools: `retrieve`
  - ✅ task STILL done after refresh
  - ✅ exactly ONE Sarah profile
  - ✅ exactly ONE rent bill

## What doesn't work (0 failed checks)
- Nothing — all checks passed.