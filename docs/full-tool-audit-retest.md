# Full AI-tool audit — 2026-07-10T23:07:30.863Z

Target: https://portol.me/api (production). Tag: `FTA_mrfjdv6k`.

**Method**: every command went through the real /api/chat; the tool that ran is extracted from the response's envelope (`action` field); DB + UI checks read the same REST endpoints the UI renders; "refresh" is a fresh GET ≥2.5s later (the same data path as F5); isolation asserts `linkedProfiles ⊆ expected` — the exact rule the UI's profile filter applies. Cross-ACCOUNT isolation is enforced by RLS/user_id scoping (covered by the standing contract suite; all queries here ran strictly within the authenticated smoke session).

| # | Section | Capability | Tool | Record | DB | UI | Refresh | Isolation | Result | Where / reason |
|---|---------|-----------|------|--------|----|----|---------|-----------|--------|----------------|
| 1 | 1-Profiles | Profile (Mike) — create | `create_profile` | bae4da8c-8dc | PASS | PASS | PASS | PASS | ✅ PASS | Profiles list (/profiles) |
| 2 | 1-Profiles | Profile (Mike) — update | `update_profile` | bae4da8c-8dc | PASS | PASS | PASS | N/T | ✅ PASS | Profiles list (/profiles) |
| 3 | 1-Profiles | Profile read (get_profile_data) | `retrieve` | - | N/T | PASS | N/T | N/T | ✅ PASS | chat reply |
| 4 | 1-Profiles | Duplicate profile blocked | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 5 | 2-Tasks | Task — create | `create_task` | 871ffa2a-277 | PASS | PASS | PASS | PASS | ✅ PASS | Tasks list (/tasks), Dashboard stats (activeTasks) |
| 6 | 2-Tasks | Task — update | `update_task` | 871ffa2a-277 | PASS | PASS | PASS | N/T | ✅ PASS | Tasks list (/tasks) |
| 7 | 2-Tasks | Task — delete | `delete_task` | 871ffa2a-277 | PASS | PASS | PASS | N/T | ✅ PASS | Tasks list (/tasks) |
| 8 | 2-Tasks | Task — complete | `complete_task` | 9c933257-bf3 | PASS | PASS | N/T | N/T | ✅ PASS | Tasks list status |
| 9 | 2-Tasks | Task — reopen | `update_task` | 9c933257-bf3 | PASS | PASS | N/T | N/T | ✅ PASS | Tasks list status |
| 10 | 2-Tasks | Task — recurring | `create_task` | 896068bb-26b | PASS | PASS | N/T | N/T | ✅ PASS | Tasks list (recur: tag) |
| 11 | 2-Tasks | Duplicate task blocked | `complete_task` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 12 | 5-Trackers | Tracker — create | `create_tracker` | 75f9000a-e8f | PASS | PASS | PASS | PASS | ✅ PASS | Trackers list (/trackers) |
| 13 | 5-Trackers | Tracker — log entry | `log_tracker_entry` | 75f9000a-e8f | PASS | PASS | N/T | N/T | ✅ PASS | Tracker entries |
| 14 | 5-Trackers | Tracker — edit entry (no dup) | `update_tracker_entry` | 75f9000a-e8f | PASS | PASS | N/T | N/T | ✅ PASS | Tracker entries |
| 15 | 5-Trackers | Tracker — delete entry | `delete_tracker_entry` | 75f9000a-e8f | PASS | PASS | N/T | N/T | ✅ PASS | Tracker entries |
| 16 | 5-Trackers | Tracker — BP/HR field separation | `log_entry` | 331bd9c1-7bc | FAIL | FAIL | N/T | N/T | ❌ FAIL | bp=true hr=false |
| 17 | 5-Trackers | Tracker — duration + intensity | `log_tracker_entry` | 6c8460f2-b55 | PASS | PASS | N/T | N/T | ✅ PASS | Exercise tracker entries |
| 18 | 6-Journal | Journal entry — create | `journal_entry` | 1ad0a07f-3e6 | PASS | PASS | PASS | PASS | ✅ PASS | Journal (/journal) |
| 19 | 6-Journal | Journal entry — update | `update_journal` | 1ad0a07f-3e6 | FAIL | FAIL | N/T | N/T | ❌ FAIL | edit not observed; reply: Journal entry updated — "completely relaxed tonight." |
| 20 | 6-Journal | Journal entry — delete | `delete_journal` | 1ad0a07f-3e6 | PASS | PASS | PASS | N/T | ✅ PASS | Journal (/journal) |
| 21 | 8-Assets | Asset — create (vehicle) | `create_profile` | b42e0527-526 | PASS | PASS | N/T | N/T | ✅ PASS | Profiles/Assets list |
| 22 | 7-Expenses | Expense (linked to asset) — create | `create_expense` | 3cf625c6-693 | PASS | PASS | PASS | PASS | ✅ PASS | Expenses list (/expenses), Dashboard monthly spend (+$50) |
| 23 | 7-Expenses | Expense (linked to asset) — update | `update_expense` | 3cf625c6-693 | PASS | PASS | PASS | N/T | ✅ PASS | Expenses list (/expenses) |
| 24 | 7-Expenses | Expense (linked to asset) — delete | `delete_expense` | 3cf625c6-693 | PASS | PASS | PASS | N/T | ✅ PASS | Expenses list (/expenses) |
| 25 | 7-Expenses | Negative amount rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 26 | 8-Assets | Asset — nested under parent | `create_profile` | 15f0348c-820 | PASS | PASS | N/T | N/T | ✅ PASS | Profiles (parentProfileId) |
| 27 | 8-Assets | Asset — revalue + net worth | `update_profile` | b42e0527-526 | PASS | FAIL | N/T | N/T | 🟡 PARTIAL | net worth unchanged |
| 28 | 8-Assets | Assign to nonexistent profile rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 29 | 8-Assets | Ownership >100% rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 30 | 9-Liabilities | Liability/bill — create | `create_obligation` | 91116fbf-88a | PASS | PASS | N/T | PASS | ✅ PASS | Bills (/obligations) |
| 31 | 9-Liabilities | Liability — record payment | `pay_obligation` | 91116fbf-88a | PASS | PASS | N/T | N/T | ✅ PASS | Bill nextDueDate (advanced by one cycle) |
| 32 | 9-Liabilities | Liability — delete | `delete_obligation` | 91116fbf-88a | PASS | PASS | N/T | N/T | ✅ PASS | Bills list |
| 33 | 9-Liabilities | End before start rejected | `create_liability` | - | FAIL | N/T | N/T | N/T | ❌ FAIL | expected refusal; got: Created **FTA_mrfjdv6k_badloan** liability with a start date of 202 |
| 34 | 12-Reminders | Reminder — create | `create_reminder` | 70808460-cf8 | PASS | PASS | PASS | PASS | ✅ PASS | Reminders (/reminders), Notification bell (/notifications) |
| 35 | 12-Reminders | Reminder — update | `update_reminder` | 70808460-cf8 | PASS | PASS | PASS | N/T | ✅ PASS | Reminders (/reminders) |
| 36 | 12-Reminders | Reminder — delete | `delete_reminder` | 70808460-cf8 | PASS | PASS | PASS | N/T | ✅ PASS | Reminders (/reminders) |
| 37 | 12-Reminders | Custom notification — create | `create_notification` | custom:fbe1c | PASS | PASS | PASS | PASS | ✅ PASS | Notification bell (custom:) |
| 38 | 12-Reminders | Custom notification — update | `mark_notifications_read` | custom:fbe1c | PASS | PASS | PASS | N/T | ✅ PASS | Notification bell (custom:) |
| 39 | 12-Reminders | Custom notification — delete | `dismiss_notifications` | custom:fbe1c | PASS | PASS | PASS | N/T | ✅ PASS | Notification bell (custom:) |

## Totals
- Tests run: **39**
- Passed: **35**  · Partial: **1**  · Failed: **3**

## Failures / partials
- **5-Trackers / Tracker — BP/HR field separation** — tool `log_entry`, record `331bd9c1-7bc4-47c8-9394-298cfd45acb6`: bp=true hr=false. Command: "124/78 + 59 BPM"
- **6-Journal / Journal entry — update** — tool `update_journal`, record `1ad0a07f-3e6e-4c9c-b87c-5d19f99c7e42`: edit not observed; reply: Journal entry updated — "completely relaxed tonight.". Command: "Update today's FTA_mrfjdv6k_journal entry — change "much better tonight" to "completely relaxed toni"
- **8-Assets / Asset — revalue + net worth** — tool `update_profile`, record `b42e0527-5260-4a6f-80d1-0718b0a79687`: net worth unchanged. Command: "CR-V → $26,000"
- **9-Liabilities / End before start rejected** — tool `create_liability`, record `-`: expected refusal; got: Created **FTA_mrfjdv6k_badloan** liability with a start date of 2026-09-08. 

Note: The en (row WAS created). Command: "Create a FTA_mrfjdv6k_badloan liability starting 2026-09-08 and ending 2026-08-09."