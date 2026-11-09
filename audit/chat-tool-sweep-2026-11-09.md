# Chat tool sweep — 2026-11-09

Every tool the chat assistant can call (149), exercised against production
(`portol.me`, commit `92f545bc`) with the smoke account.

- **Back end:** one natural-language command per tool, sent through the same
  streaming endpoint the app uses (`scripts/verify-all-chat-tools.ts`). A tool
  counts as run when its `tool_start` frame appears and its `tool_result` is ok.
- **Front end:** each recorded reply replayed through the real chat page in a
  browser (`scripts/verify-chat-display.ts`), checking the reply text and the
  card / chart / table / report / document preview the tool should show.

The table shows each tool's best result over four passes. Several tools only
ran after rephrasing; the Note column says where the natural phrasing failed.

## Result

| | count |
|---|---|
| Tool ran in production and succeeded | 141 |
| Done by a fast lane without the model (`save_memory`, `open_document`, `set_dashboard_scope`) | 3 |
| Done by a sibling tool (`mark_loan_payment`, `update_budget`) | 2 |
| Failed in production (`confirm_paycheck_received`, `generate_table`, `sync_calendar`) | 3 |
| Reply rendered correctly in production's chat page | 146 / 149 |
| Reply rendered correctly in this branch's chat page | 147 / 149 |

Speed, over 219 live turns: the server acknowledges in 0.18 s (median); the
first visible progress arrives at 2.3 s (median; 3.9 s p95); the full reply at
4.1 s (median; 7.0 s p90; 8.2 s p95). The slowest were `generate_report`
(19.7 s) and a two-tool budget delete (18.3 s). Fast-lane replies take
0.2–0.3 s. Once a reply arrives the page renders it in about 0.33 s.

## Not fixed by this change

- Migration `20260922_ai_operation_ids_and_chat_runs.sql` had never been
  applied to production (`ai_action_log` had no `turn_id` / `request_id` /
  `operation_id` columns; `ai_chat_runs` did not exist). **Applied
  2026-11-09** after this sweep, at the owner's request.
- `sync_calendar` cannot work on the server as written.
- The snapshot note that stops "that record doesn't exist" answers is a prompt
  change; it was shown to work by putting the same sentence in the message,
  and needs one live run after deploy.

## Per tool

| Tool | Kind | Production | Shows | Rendered | Time | Note |
|---|---|---|---|---|---|---|
| `create_profile` | write | tool ran | card | yes | 4.0s |  |
| `update_profile` | write | tool ran | card | yes | 3.0s |  |
| `get_profile_data` | read | tool ran | text | yes | 6.4s |  |
| `search` | read | tool ran | text | yes | 5.9s |  |
| `refresh_ai_summary` | read | tool ran | text | yes | 6.1s |  |
| `merge_profiles` | write | tool ran | card | yes | 8.0s | Merged correctly; card read "DELETE ENTITY". **Fixed** (cards name the action). |
| `revalue_asset` | write | tool ran | card | yes | 7.1s |  |
| `link_asset_owner` | write | tool ran | card | yes | 5.6s |  |
| `split_ownership` | write | tool ran | card | yes | 4.6s |  |
| `get_asset_rollup` | read | tool ran | text | yes | 8.3s |  |
| `create_liability` | write | tool ran | card | yes | 4.1s |  |
| `update_liability` | write | tool ran | card | yes | 6.6s |  |
| `link_liability_asset` | write | tool ran | card | yes | 3.7s |  |
| `get_liability_summary` | read | tool ran | text | yes | 11.7s |  |
| `get_loan_schedule` | read | tool ran | text | yes | 5.6s |  |
| `add_liability_payment` | write | tool ran | card | yes | 3.2s |  |
| `update_liability_payment` | write | tool ran | card | yes | 3.5s |  |
| `delete_liability_payment` | write | tool ran | card | yes | 5.5s |  |
| `mark_loan_payment` | write | via add_liability_payment | card | yes | 6.8s | Only works for loans with a generated schedule; the payment was recorded through add_liability_payment. |
| `unlink_asset_from_liability` | write | tool ran | card | yes | 3.1s |  |
| `link_asset_to_liability` | write | tool ran | card | yes | 4.4s |  |
| `move_liability_to_asset` | write | tool ran | card | yes | 3.7s |  |
| `link_liability_owner` | write | tool ran | card | yes | 6.0s |  |
| `get_relationships` | read | tool ran | text | yes | 6.8s |  |
| `create_task` | write | tool ran | card | yes | 3.0s |  |
| `update_task` | write | tool ran | card | yes | 2.7s |  |
| `query_tasks` | read | tool ran | text | yes | 5.2s |  |
| `get_summary` | read | tool ran | text | yes | 4.4s |  |
| `explain_dashboard_item` | read | tool ran | text | yes | 3.5s |  |
| `get_entity_history` | read | tool ran | text | yes | 8.5s | Ran, but history ends in September: same ledger problem. |
| `complete_task` | write | tool ran | card | yes | 4.3s |  |
| `delete_task` | write | tool ran | card | yes | 2.6s | Worked with a bare "yes"; "Yes, go ahead" was refused as a replay. **Fixed.** |
| `restore_task` | write | tool ran | card | yes | 4.4s |  |
| `bulk_complete_tasks` | write | tool ran | card | yes | 7.0s |  |
| `preview_bulk_action` | write | tool ran | card | yes | 5.9s |  |
| `execute_bulk_action` | write | tool ran | card | yes | 9.6s |  |
| `undo_last_action` | write | tool ran | card | yes | 5.8s | Ran, but undid a record from 2 September: the undo ledger had not been written since. **Fixed in code; migration still to apply.** |
| `recall_actions` | read | tool ran | text | yes | 7.9s | Ran, but lists September: same ledger problem. |
| `create_habit` | write | tool ran | card | yes | 4.0s |  |
| `checkin_habit` | write | tool ran | card | yes | 2.4s |  |
| `uncomplete_habit` | write | tool ran | card | yes | 3.1s |  |
| `update_habit` | write | tool ran | card | yes | 5.9s |  |
| `delete_habit` | write | tool ran | card | yes | 3.2s |  |
| `restore_habit` | write | tool ran | card | yes | 4.6s |  |
| `create_tracker` | write | tool ran | card | yes | 6.2s |  |
| `log_tracker_entry` | write | tool ran | card | yes | 2.9s |  |
| `update_tracker_entry` | write | tool ran | card | yes | 4.7s |  |
| `delete_tracker_entry` | write | tool ran | card | yes | 3.4s |  |
| `update_tracker` | write | tool ran | card | yes | 3.4s |  |
| `delete_tracker` | write | tool ran | card | yes | 3.9s |  |
| `log_medication_dose` | write | tool ran | card | yes | 2.8s |  |
| `skip_medication_dose` | write | tool ran | card | yes | 4.2s |  |
| `get_missed_doses` | read | tool ran | text | yes | 4.4s |  |
| `get_dose_history` | read | tool ran | text | yes | 5.9s |  |
| `schedule_medication_refills` | write | tool ran | card | yes | 4.8s |  |
| `create_expense` | write | tool ran | card | yes | 2.4s |  |
| `update_expense` | write | tool ran | card | yes | 4.9s |  |
| `query_expenses` | read | tool ran | text | yes | 3.7s |  |
| `spending_analytics` | read | tool ran | text | yes | 5.8s |  |
| `refund_expense` | write | tool ran | card | yes | 5.1s |  |
| `convert_expense_to_asset` | write | tool ran | card | yes | 4.2s |  |
| `delete_expense` | write | tool ran | card | yes | 6.4s |  |
| `log_income` | write | tool ran | card | yes | 3.5s |  |
| `update_income` | write | tool ran | card | yes | 3.4s |  |
| `get_cashflow` | read | tool ran | text | yes | 4.8s |  |
| `delete_income` | write | tool ran | card | yes | 3.6s |  |
| `log_expected_paycheck` | write | tool ran | card | yes | 2.9s |  |
| `confirm_paycheck_received` | write | **failed** | card | no | 9.2s | Crashed: the payer's name was sent to a uuid column. **Fixed** (resolves by source). |
| `delete_paycheck` | write | tool ran | card | yes | 8.1s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `create_budget` | write | tool ran | card | yes | 7.0s |  |
| `update_budget` | write | via set_budget | card | yes | 5.7s | Tool rejected the category name as an id; set_budget did the job. **Fixed** (resolves by category). |
| `set_budget` | write | tool ran | card | yes | 4.8s |  |
| `get_budget_summary` | read | tool ran | text | yes | 5.7s |  |
| `delete_budget` | write | tool ran | card | yes | 18.3s |  |
| `copy_budgets_previous_month` | write | tool ran | card | yes | 4.0s |  |
| `query_net_worth_history` | read | tool ran | text | yes | 6.5s |  |
| `create_account` | write | tool ran | card | yes | 2.7s |  |
| `update_account_balance` | write | tool ran | card | yes | 3.4s |  |
| `get_accounts` | read | tool ran | text | yes | 4.9s |  |
| `get_financial_summary` | read | tool ran | text | yes | 6.2s |  |
| `get_account_balances` | read | tool ran | text | yes | 4.6s |  |
| `search_financial_transactions` | read | tool ran | text | yes | 4.1s |  |
| `get_spending_breakdown` | read | tool ran | text | yes | 8.0s |  |
| `refresh_financial_data` | write | tool ran | card | yes | 3.8s |  |
| `create_obligation` | write | tool ran | card | yes | 4.9s |  |
| `update_obligation` | write | tool ran | card | yes | 4.0s |  |
| `sync_date_rules_for_entity` | read | tool ran | text | yes | 4.3s |  |
| `add_liability_charge` | write | tool ran | card | yes | 5.3s |  |
| `set_liability_amount` | write | tool ran | card | yes | 6.2s |  |
| `pay_obligation` | write | tool ran | card | yes | 5.8s |  |
| `undo_last_payment` | write | tool ran | card | yes | 5.3s |  |
| `delete_obligation` | write | tool ran | card | yes | 5.2s |  |
| `create_event` | write | tool ran | card | yes | 2.5s |  |
| `update_event` | write | tool ran | card | yes | 3.0s |  |
| `query_calendar` | read | tool ran | text | yes | 7.5s |  |
| `complete_event` | write | tool ran | card | yes | 3.7s |  |
| `delete_event` | write | tool ran | card | yes | 4.6s |  |
| `sync_calendar` | write | **failed** | card | no | 5.0s | Fails in production: depends on an external CLI that is not on the server. **Not fixed.** |
| `journal_entry` | write | tool ran | card | yes | 3.5s | Saved, but the reply read "Journaled: journal_entry". **Fixed.** |
| `append_journal_entry` | write | tool ran | card | yes | 4.0s |  |
| `update_journal` | write | tool ran | card | yes | 2.9s |  |
| `delete_journal` | write | tool ran | card | yes | 3.5s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `create_note` | write | tool ran | card | yes | 2.4s |  |
| `search_notes` | read | tool ran | text | yes | 3.3s |  |
| `update_note` | write | tool ran | card | yes | 4.1s |  |
| `delete_note` | write | tool ran | card | yes | 4.5s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `create_artifact` | write | tool ran | card | yes | 5.8s |  |
| `toggle_artifact_item` | write | tool ran | card | yes | 3.3s | "Check off passport on the … checklist" checked in an unrelated habit. **Fixed.** Works when the assistant is told the checklist exists. |
| `update_artifact` | write | tool ran | card | yes | 3.4s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `duplicate_artifact` | write | tool ran | card | yes | 3.2s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `delete_artifact` | write | tool ran | card | yes | 2.9s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `save_memory` | write | fast lane (no model) | card | yes | 2.2s |  |
| `recall_memory` | write | tool ran | text | yes | 2.6s |  |
| `update_memory` | write | tool ran | card | yes | 3.1s |  |
| `delete_memory` | write | tool ran | card | yes | 2.7s |  |
| `create_document` | write | tool ran | card | yes | 5.8s |  |
| `search_documents` | read | tool ran | text | yes | 4.3s |  |
| `retrieve_document` | read | tool ran | text | yes | 4.0s |  |
| `open_document` | read | fast lane (no model) | document | yes | 0.3s |  |
| `link_document` | write | tool ran | card | yes | 2.6s |  |
| `manage_document` | write | tool ran | card | yes | 3.3s |  |
| `upload_document` | write | tool ran | card | yes | 2.8s |  |
| `create_goal` | write | tool ran | card | yes | 3.2s |  |
| `get_goal_progress` | read | tool ran | text | yes | 4.8s |  |
| `update_goal` | write | tool ran | card | yes | 4.3s |  |
| `link_entities` | write | tool ran | card | yes | 7.4s |  |
| `get_related` | read | tool ran | text | yes | 4.4s |  |
| `delete_goal` | write | tool ran | card | yes | 3.7s |  |
| `create_domain` | write | tool ran | card | yes | 6.3s |  |
| `update_domain` | write | tool ran | card | yes | 9.0s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `delete_domain` | write | tool ran | card | yes | 3.9s | With natural phrasing the assistant answered "doesn't exist" (the record type is not in its snapshot). Works when told it exists. **Fixed** (snapshot note) — confirm after deploy. |
| `create_notification` | write | tool ran | card | yes | 3.7s |  |
| `mark_notifications_read` | write | tool ran | card | yes | 3.7s |  |
| `dismiss_notifications` | write | tool ran | card | yes | 3.6s |  |
| `set_notification_preferences` | write | tool ran | card | yes | 2.5s |  |
| `generate_chart` | read | tool ran | chart | yes | 4.9s |  |
| `generate_table` | read | **failed** | table | yes | 6.8s | Tool failed ("No tasks data found"); the assistant fell back to a text table. 6 of 9 advertised sources had no code. **Fixed.** |
| `generate_report` | read | tool ran | report | yes | 19.7s |  |
| `navigate` | read | tool ran | navigate | yes (this branch) | 2.4s | Reply said "Navigating…" and the page stayed on the chat. **Fixed.** |
| `set_dashboard_scope` | read | fast lane (no model) | scope | yes | 2.3s | "Show me <name>'s dashboard only" opened that person's document instead. **Fixed.** ("Switch the dashboard to <name>" worked.) |
| `configure_dashboard_sections` | write | tool ran | card | yes | 4.9s | "Show the X section on my dashboard" was refused as a read-only turn (hide/move worked). **Fixed.** |
| `find_orphans` | read | tool ran | text | yes | 2.6s |  |
| `find_duplicates` | read | tool ran | text | yes | 4.1s |  |
| `validate_profile_isolation` | read | tool ran | text | yes | 6.3s |  |
| `validate_dashboard_counts` | read | tool ran | text | yes | 5.8s |  |
| `refresh_dashboard` | read | tool ran | text | yes | 3.0s |  |
| `repair_relations` | write | tool ran | card | yes | 4.4s |  |
| `repair_profile_types` | write | tool ran | card | yes | 3.1s |  |
| `delete_profile` | write | tool ran | card | yes | 6.2s |  |
