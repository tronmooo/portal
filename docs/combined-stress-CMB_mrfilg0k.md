# Combined-command stress — 2026-07-10T22:40:05.010Z

| # | Probe | Latency | HTTP | Tools | Items OK | Items failed | Verdict |
|---|-------|---------|------|-------|----------|--------------|---------|
| 1 | 3 domains in one message (expense + task + hydration) | 16.1s | 200 | create_expense, create_task, log_tracker_entry, log_expense, log_entry | expense $47.82; task tomorrow; hydration entry (8 glasses) | - | PASS |
| 2 | Profile + event + recurring reminder in one | 16.2s | 200 | create_profile, create_event, create_reminder | pet profile; vet event linked to Rex; heartgard reminder | - | PASS |
| 3 | 3 tracker entries (nutrition + weight + supplement) | 13.8s | 200 | log_tracker_entry, log_entry | nutrition 450 cal; weight 182; multivitamin taken | - | PASS |
| 4 | BP + heart rate dual log (regression of audit fix) | 2.0s | 200 | log_entry | BP entry 126/82 (no pulse inside) | Heart Rate entry 61 | PARTIAL |
| 5 | Finance combo: two expenses + linked reminder | 10.3s | 200 | create_expense, create_reminder, log_expense | electric expense 89.50; insurance expense 612; renewal reminder | - | PASS |
| 6 | 6-item mega message | 12.4s | 200 | create_task, create_event, create_expense, checkin_habit, log_tracker_entry, journal_entry, log_expense, log_entry | task taxes; dentist event; lunch expense 12.50; reading habit checked; yoga 30 min | memory saved (garage code) | PARTIAL |
| 7 | Mixed recurring + one-time (the classic poison test) | 9.0s | 200 | create_expense, create_obligation, log_expense | one-time Apple TV EXPENSE (not a bill); gym BILL (recurring obligation) | - | PASS |
| 8 | Cross-profile combo (two people, one message) | 7.1s | 200 | create_task | Bob's task owned by Bob; Jane's task owned by Jane; no cross-contamination | - | PASS |
| 9 | Read + write combo (question and action in one) | 6.5s | 200 | create_expense, retrieve, log_expense | carwash expense | - | PASS |
| 10 | Update + create combo | 18.2s | 200 | update_task, create_reminder, update_entity | task renamed; reminder ~3 days before due | - | PASS |
| 11 | Heavy read (report generation — timeout probe) | 16.7s | 200 | retrieve | reply is substantive (no timeout/error) | - | PASS |
| 12 | Bulk complete + targeted delete in one | 6.0s | 200 | complete_task, delete_task | taxes task completed; plumber task deleted | - | PASS |

**10/12 probes fully passed.** Partial = some items in the message executed, others silently didn't.