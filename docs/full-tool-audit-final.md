# Full AI-tool audit — 2026-07-10T23:42:47.467Z

Target: https://portol.me/api (production). Tag: `FTA_mrfkx1ke`.

**Method**: every command went through the real /api/chat; the tool that ran is extracted from the response's envelope (`action` field); DB + UI checks read the same REST endpoints the UI renders; "refresh" is a fresh GET ≥2.5s later (the same data path as F5); isolation asserts `linkedProfiles ⊆ expected` — the exact rule the UI's profile filter applies. Cross-ACCOUNT isolation is enforced by RLS/user_id scoping (covered by the standing contract suite; all queries here ran strictly within the authenticated smoke session).

| # | Section | Capability | Tool | Record | DB | UI | Refresh | Isolation | Result | Where / reason |
|---|---------|-----------|------|--------|----|----|---------|-----------|--------|----------------|
| 1 | 6-Journal | Journal entry — create | `journal_entry` | b6d69a48-375 | PASS | PASS | PASS | PASS | ✅ PASS | Journal (/journal) |
| 2 | 6-Journal | Journal entry — update | `update_journal` | b6d69a48-375 | PASS | PASS | PASS | N/T | ✅ PASS | Journal (/journal) |
| 3 | 6-Journal | Journal entry — delete | `delete_journal` | b6d69a48-375 | PASS | PASS | PASS | N/T | ✅ PASS | Journal (/journal) |
| 4 | 9-Liabilities | Liability/bill — create | `create_obligation` | 41adec2a-d00 | PASS | PASS | N/T | PASS | ✅ PASS | Bills (/obligations) |
| 5 | 9-Liabilities | Liability — record payment | `pay_obligation` | 41adec2a-d00 | PASS | PASS | N/T | N/T | ✅ PASS | Bill nextDueDate (advanced by one cycle) |
| 6 | 9-Liabilities | Liability — delete | `delete_obligation` | 41adec2a-d00 | PASS | PASS | N/T | N/T | ✅ PASS | Bills list |
| 7 | 9-Liabilities | End before start rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |

## Totals
- Tests run: **7**
- Passed: **7**  · Partial: **0**  · Failed: **0**