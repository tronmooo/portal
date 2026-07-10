# Full AI-tool audit — 2026-07-10T23:48:30.998Z

Target: https://portol.me/api (production). Tag: `FTA_mrfl0nfe`.

**Method**: every command went through the real /api/chat; the tool that ran is extracted from the response's envelope (`action` field); DB + UI checks read the same REST endpoints the UI renders; "refresh" is a fresh GET ≥2.5s later (the same data path as F5); isolation asserts `linkedProfiles ⊆ expected` — the exact rule the UI's profile filter applies. Cross-ACCOUNT isolation is enforced by RLS/user_id scoping (covered by the standing contract suite; all queries here ran strictly within the authenticated smoke session).

| # | Section | Capability | Tool | Record | DB | UI | Refresh | Isolation | Result | Where / reason |
|---|---------|-----------|------|--------|----|----|---------|-----------|--------|----------------|
| 1 | 8-Assets | Asset — create (vehicle) | `create_profile` | e0732a2a-fc5 | PASS | PASS | N/T | N/T | ✅ PASS | Profiles/Assets list |
| 2 | 7-Expenses | Expense (linked to asset) — create | `create_expense` | 261a1b96-59d | PASS | PASS | PASS | PASS | ✅ PASS | Expenses list (/expenses), Dashboard monthly spend (+$50) |
| 3 | 7-Expenses | Expense (linked to asset) — update | `update_expense` | 261a1b96-59d | PASS | PASS | PASS | N/T | ✅ PASS | Expenses list (/expenses) |
| 4 | 7-Expenses | Expense (linked to asset) — delete | `delete_expense` | 261a1b96-59d | PASS | PASS | PASS | N/T | ✅ PASS | Expenses list (/expenses) |
| 5 | 7-Expenses | Negative amount rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 6 | 8-Assets | Asset — nested under parent | `create_profile` | d6e63b43-cbb | PASS | PASS | N/T | N/T | ✅ PASS | Profiles (parentProfileId) |
| 7 | 8-Assets | Asset — revalue + net worth | `update_profile` | e0732a2a-fc5 | PASS | PASS | N/T | N/T | ✅ PASS | Profile fields + net worth |
| 8 | 8-Assets | Assign to nonexistent profile rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |
| 9 | 8-Assets | Ownership >100% rejected | `-` | - | PASS | N/T | N/T | N/T | ✅ PASS | chat reply |

## Totals
- Tests run: **9**
- Passed: **9**  · Partial: **0**  · Failed: **0**