# Global Rules — what is enforced, where, and how

**Status:** authoritative companion to `ARCHITECTURE.md`. Every rule below is
enforced by code, and every "Enforced by" entry names the module and the test
that pins it. When a rule and the code disagree, the code is the bug.

**Origin:** the 2026‑09‑22 regression retest (read‑only follow‑up recreated an
income; an unpaid $549.50 estimate became an expense; an asset landed on the
wrong person; 6% vs 0.1% APR; Sept 25 vs Oct 25 next due; an expense
searchable but missing from Finance; a renamed habit whose tracker kept the old
name; a journal mood that reverted; search sending a loan receipt to
`/profiles`; an estimated distance shown as fact; Morgan missing from pickers).

Legend — **Added**: built in this change. **Existing**: already enforced and
verified; only referenced. **Hardened**: existed as convention or prompt text
and is now a code gate.

---

## The write pipeline (Safety Gates)

Every write, whichever door it enters by (form, quick‑add, chat, extraction,
import), now passes:

```
1. intent            shared/turn-scope.ts            (chat only) READ turns get no mutation budget
2. active profile    server/active-scope-context.ts  X-Active-Profile-Ids on every request incl. chat
3. entity type       shared/entity-registry.ts
4. parent / owner    shared/owner-resolution.ts      explicit > active profile > self (Everyone) > STOP
5. duplicates        shared/duplicate-guard.ts       high → reuse · medium → ask · low → create
6. validation        shared/write-validation.ts      owner exists, parent exists, dates, money
7. financial state   shared/financial-status.ts      (documents) paid evidence or explicit instruction
8. idempotent write  shared/ai-operation-ids.ts      (chat) operation id stored on ai_action_log
9. commit            server/storage.ts proxy         write journal + mutation-scope guard
10. invalidate       shared/storage-domains.ts → client/src/lib/cache-bus.ts
11. integrity        shared/entity-integrity.ts      conflicts logged, never silently folded
12. anomaly log      server/integrity-log.ts
```

---

## Rule by rule

| # | Rule | Status | Enforced by | Pinned by |
|---|---|---|---|---|
| 1 | Reads never mutate | **Added** | `shared/turn-scope.ts` classifies every chat message READ/CREATE/UPDATE/DELETE/MIXED before any tool runs; `server/mutation-scope.ts` runs the turn in an AsyncLocalStorage scope; the engine refuses write tools on a READ turn (`read_only_turn`) and the storage proxy (`server/storage.ts`) refuses write‑shaped methods inside that scope — fast paths and the bulk executor included. History is context, never authorization. `shared/ai-claim-check.ts` lets a read turn describe past saves but still refuses a first‑person claim of a fresh write. | `tests/turn-scope.test.ts`, `tests/read-only-turn-guard.test.ts`, `tests/storage-proxy-read-only.test.ts` |
| 2 | request_id / operation_id, idempotent replay | **Added** | `shared/ai-operation-ids.ts` derives `op_<tool>_<hash>` from the client's request id + tool + normalized input + ordinal; `ai_action_log` gains `turn_id`, `request_id`, `operation_id` with a unique index (`migrations/20260922_ai_operation_ids_and_chat_runs.sql`); the engine looks the id up before executing and returns the stored result (`status: "deduped"`). The client sends `Idempotency-Key` = its message id. | `tests/read-only-turn-guard.test.ts` ("same request replayed does not write twice") |
| 3 | No transaction without transaction evidence | **Added** | `shared/financial-status.ts`: document kind (quote/estimate/invoice/receipt/bill/payment_confirmation/statement/contract) + `financialStatus` per extracted item; `decideExpenseCreation` allows an expense only when status is `paid`. Enforced at all three write paths: upload auto‑create (`server/ai-engine.ts`), confirm‑extraction body (`server/routes.ts`), reviewed plan (`server/action-executor.ts`, `shared/extraction-actions.ts`). | `tests/financial-status.test.ts`, `tests/action-executor-financial-gate.test.ts` |
| 4 | Explicit instruction beats inference | **Added** | `detectExpenseInstruction` ("nothing paid", "do not create an expense", "log this as an expense") is checked first in `decideExpenseCreation`; the classifier prompt no longer says "paid OR owed". | same as Rule 3 |
| 5 | One canonical owner relationship | **Existing** | `linked_profiles` is the sole ownership truth (`shared/ownership.ts`); `server/ownership-writer.ts` is the single writer; DB guard `migrations/20260729_linked_profiles_ownership_guard.sql`; contract test bans direct writes. The 11 duplicated default‑to‑self blocks in storage now call one helper (Rule 6). | `tests/smoke/contracts/no-direct-ownership-writes.test.ts`, `tests/ownership.test.ts` |
| 6 | Selected profile is a hard boundary | **Added** | `server/active-scope-context.ts` installs the `X-Active-Profile-Ids` header for every request (chat included — `client/src/components/chat/chat-stream.ts` now sends it); `shared/owner-resolution.ts` → explicit owner, else the single active profile, else self only under Everyone, else `OwnerRequiredError` (409 `OWNER_REQUIRED`). Storage `createX` and the AI's `aiDefaultOwner` use it; a named‑but‑unknown owner returns `needsOwner` instead of writing to self. `useProfileScope` no longer falls back to first‑selected; finance import no longer falls back to `profiles[0]`. | `tests/owner-resolution.test.ts`, `tests/active-scope-create.test.ts` |
| 7 | Scope applied at query time | **Existing (partial)** | All storage getters accept `profileIds` and push down via GIN (`server/supabase-storage.ts _applyProfileFilter`); `/api/documents`, `/api/stats`, `/api/dashboard-enhanced` push down; the rule itself is one function (`shared/profile-filter.ts` → `shared/scope.ts`) pinned by a contract test. Not changed here: list routes still fetch‑then‑filter in memory (correct results, no leak; a performance follow‑up). | `tests/smoke/contracts/no-inline-profile-filters.test.ts` |
| 8 | Canonical entity graph | **Existing** | `liability_asset_links`, `liability_profile_links`, `liability_payments.liability_profile_id` (`shared/schema.ts`); one payment door `server/liability-payments.ts payBillOccurrence`. | `tests/liability-payment-parity.test.ts` |
| 9 | One real liability = one profile | **Existing** | `resolveExistingLiability` idempotent upsert (`server/supabase-storage.ts`); AI `create_liability` dedups on name+owner+type. Multi‑signal scoring (lender, account no.) is Rule 35's guard for the ledger types; for liabilities it stays name+owner+type. | `tests/liability-types.test.ts` |
| 10 | Child records stay children | **Existing** | Extraction never creates profiles/obligations (`server/action-executor.ts` refusal filter); `writeObligation` is update‑only. | `tests/extraction-creates-no-entities.test.ts` |
| 11 | One canonical source per field | **Added** | One alias table (`shared/profile-field-canon.ts` `CANONICAL_ALIASES`); `shared/registry-fields.ts` now folds through it (was the opposite direction); canonical readers `shared/liability-fields.ts` (`readInterestRatePct`, `readBalance`, `readMonthlyPayment`, `readStoredDueDate`) replace every inline chain. | `tests/no-inline-liability-field-chains.test.ts` (static scan), `tests/profile-field-canon.test.ts` |
| 12 | Derived values from shared functions | **Added** | `shared/liability-derived.ts deriveLiabilityMetrics` (months/payments remaining, percent paid, equity, payoff) replaces the AI's closed‑form months‑left and profile‑detail's private amortization; `shared/expense-ledger.ts` (`sumExpenses`, `monthlySpend`, `spendByCategory`, one `savingsRate`) replaces the inline reduces. | `tests/liability-derived.test.ts`, `tests/expense-ledger.test.ts` |
| 13 | One date engine | **Added** | `shared/temporal-status.ts getRecordTemporalStatus(record, today)` → status, nextOccurrence, overdueBy, dueIn, displayLabel. The AI context, the Tier‑1 fact answer and the liability header chip all call it (the Sept 25 / Oct 25 split). | `tests/temporal-status.test.ts` |
| 14 | History ≠ schedule | **Hardened** | Advancement was already occurrence‑driven; the last "lastPaid + one cycle" inference in `shared/liability-schedule.ts` is removed — no schedule means no due date. | `tests/audit-fixes-2026-09.test.ts` (updated) |
| 15 | Ledger‑based finance | **Added (calc)** | Manual `expenses` totals now come from `shared/expense-ledger.ts` on every surface; payloads state `ledger: "manual" \| "connected"`. Deliberately not done: merging the manual and Stripe ledgers (product decision). | `tests/expense-ledger.test.ts` |
| 16 | Saved means committed | **Hardened** | Ten success toasts moved from `onMutate` to `onSuccess`. | `tests/no-optimistic-success-toasts.test.ts` |
| 17 | Deterministic invalidation | **Hardened** | Server side was already write‑journal driven (`server/write-journal.ts`). Client: `expenses`/`incomes` now reach profile detail; any bust clears the search palette cache (`onCacheBust`). | `tests/cache-bus-expense-domains.test.ts` |
| 18 | No stale value shown as final | **Hardened** | The 3.5 s cap on "Updating…" is gone; revalidating/error state threaded into every dashboard section. | `tests/dashboard-error-not-zero.dom.test.tsx` |
| 19/20 | Linked data via relationship | **Added** | `trackers.linked_habit_id` (`migrations/20260922_tracker_linked_habit.sql`); `server/habit-rename-cascade.ts` renames a mirror tracker on habit rename (route + AI); `FIELD_ORIGIN` in `shared/schema.ts` documents canonical / copied / snapshot fields. | `tests/habit-rename-cascade.test.ts` |
| 21 | Saved = every field persisted | **Existing** | Journal saves content + mood + tags in one request; toast after `await`. | `tests/journal*` (existing) |
| 22 | Background AI jobs survive navigation | **Added** | `ai_chat_runs` (running/completed/failed) keyed by the client's request id; `GET /api/chat/runs/:id`; a sent message is `pending` in the chat cache and the page restores its reply on mount instead of re‑sending. A completed request replayed returns the stored result. | `tests/storage-proxy-read-only.test.ts` (run store) |
| 23 | Canonical search destinations | **Added** | Every search row is stamped `href` server‑side (`shared/search-match.ts`); incomes and goals are now searchable; list‑only types deep‑link with `?highlight=type:id` consumed by `client/src/hooks/useRecordHighlight.ts`. | `tests/search-href.test.ts`, `tests/entity-routes.test.ts` |
| 24 | One route resolver | **Added** | `shared/entity-routes.ts routeForEntity(type, id)`; chat receipts, search, notifications (`client/src/lib/notification-route.ts`), dashboard activity, calendar and wellness all use it; the dead `?open=`, `?focus=`, `/documents` links are gone. | `tests/entity-routes.test.ts` |
| 25 | Internal metadata hidden | **Hardened** | `shared/system-fields.ts` inventory + `isSystemFieldKey`; `isReservedFieldKey` delegates; Developer Mode shows them read‑only. | `tests/system-fields.test.ts` |
| 26 | Provenance of estimates | **Added** | `ProvenancedValue.isEstimated`; `formatProvenanced` renders `≈`; Wellness and tracker badges mark estimated distance/calories. | `tests/estimation-engine.test.ts`, `tests/wellness-readout.test.ts` |
| 27 | Test data isolated | **Existing (hardened)** | Separate fixture account + name patterns (`shared/test-data.ts`); `/api/stats` and the AI finance snapshot now exclude test rows unless `includeTestData`. No `is_test` column was added. | `tests/test-data-filter.test.ts` |
| 28 | One profile collection for pickers | **Added** | Shared `PERSON_TYPES` / offerable helper; the Calendar picker's nonexistent `entityType` filter (always empty) is fixed; pickers dedupe by id. | `tests/profile-pickers-canonical.test.tsx` |
| 29/30 | Four states, error ≠ empty | **Added** | Eleven error‑swallowing `queryFn`s removed; `numOrUnknown` renders "—" + retry on error. | `tests/dashboard-error-not-zero.dom.test.tsx` |
| 31 | AI retrieves, doesn't reconstruct | **Existing** | `shared/fact-lookup.ts` Tier‑1, `server/finance-ai-tools.ts`, `shared/loan-facts.ts`; now also `getRecordTemporalStatus`. | `tests/fact-lookup.test.ts` |
| 32 | No fabricated relationships | **Hardened** | A named owner that does not resolve returns `needsOwner` (STOP and ask) instead of the legacy "returning first". | `tests/owner-resolution.test.ts` |
| 33 | Conflicting facts warn | **Added** | `shared/entity-integrity.ts validateEntityIntegrity` groups aliases by identity; conflicts are logged (`conflicting_canonical_facts`), the canonical value wins, alternates park under `_integrity.stale`; the liability page shows "These records conflict". | `tests/entity-integrity.test.ts` |
| 34 | Schema + relationship validation | **Added** | `shared/write-validation.ts` at the storage `createX` chokepoints (owner exists, parent exists, calendar days, money bounds). | `tests/write-validation.test.ts` |
| 35 | Universal duplicate guard | **Added** | `shared/duplicate-guard.ts findPossibleDuplicates` (owner/type/date/amount/name/source/request_id); storage reuses a high‑confidence twin, AI tools ask on medium (`needsConfirmation`), REST returns 409 `POSSIBLE_DUPLICATE`. | `tests/duplicate-guard.test.ts` |
| 36 | Activity by event id | **Added** | `recentActivity` rows carry the entity id; dedupe by `type|id`. | `tests/chat-engine-qa-2026-09-18.test.ts` (extended) |
| 37 | Calendar source types | **Added** | `sourceType` on every timeline item; labels from `KIND_LABELS` (Income, Birthday, Document Expiration…). | `tests/calendar-source-type.test.ts` |
| 38 | Anomalies fail loudly | **Added** | `server/integrity-log.ts logIntegrity` with kinds `ai_read_triggered_write`, `duplicate_write`, `scope_mismatch`, `idempotent_replay`, `conflicting_canonical_facts`, `owner_unresolved`, `validation_failed`, `stale_dependency`; fed by the engine gate, the envelope verifier, the storage guards and the integrity validator. | `tests/read-only-turn-guard.test.ts` |
| 39 | Entity registry | **Added** | `shared/entity-registry.ts ENTITY_REGISTRY` composed from the existing facet modules (domains, ownership, search fields, routes, deletion, calendar, finance, icon). | `tests/entity-registry.test.ts` |
| 40 | Shared domain services | **Existing → extended** | The consolidation that already existed for asset value / net worth / monthly conversion is extended by Rules 11‑15, 23‑24, 39. | the tests above |

---

## Permanent regression checks

Local suite (`npm test`) — the rules' tests are listed at the end of
`vitest.config.ts` under their rule comments. Pre‑push contract suite —
unchanged; the ownership and profile‑filter contracts still gate every push.

The "Permanent regression rules" from the brief map to:

| Brief | Test |
|---|---|
| Read‑only safety (income count unchanged after a read follow‑up) | `tests/read-only-turn-guard.test.ts` |
| Document safety (unpaid estimate → document, no expense) | `tests/financial-status.test.ts`, `tests/action-executor-financial-gate.test.ts` |
| Ownership (Profile A selected → owner A) | `tests/active-scope-create.test.ts` |
| Finance consistency (one expense in every total) | `tests/expense-ledger.test.ts`, `tests/cache-bus-expense-domains.test.ts` |
| Liability consistency (same APR/next due everywhere) | `tests/temporal-status.test.ts`, `tests/no-inline-liability-field-chains.test.ts`, `tests/entity-integrity.test.ts` |
| Payment hierarchy | `tests/liability-payment-parity.test.ts` (existing) |
| Duplicate protection (replay identical operation) | `tests/read-only-turn-guard.test.ts`, `tests/duplicate-guard.test.ts` |
| Linked‑data update (rename habit → tracker) | `tests/habit-rename-cascade.test.ts` |
| Save persistence | existing journal tests |
| Navigation persistence (leave, return, no duplicate) | `tests/storage-proxy-read-only.test.ts` (run store) + Rule 2 replay test |
| Scope isolation | `tests/smoke/contracts/isolation.test.ts`, `tests/profile-scope.test.ts` (existing) |

---

## Deliberately not added

- **`is_test` column** (Rule 27): the fixture account is already a separate
  workspace and totals exclude test‑patterned rows by default; a column across
  every table would be a wide schema change for no additional isolation.
- **Merging the manual and connected ledgers** (Rule 15): both are canonical
  for what they record; surfaces now declare which ledger they report.
- **Query‑time pushdown for every list route** (Rule 7): the storage layer
  supports it; the remaining fetch‑then‑filter routes are correct today and are
  a performance follow‑up.
- **Expense calendar adapter** (Rule 37): expenses are past transactions, not
  dated commitments.
