# The Orchestration Layer — Canonical Actions Across Every Door

**Status:** Authoritative. Added 2026-08-22 (branch `claude/central-orchestration-layer-0y2uad`).
**Companion:** `ARCHITECTURE.md` (state/cache contract), `tests/door-parity-*.test.ts` (enforcement).

## Why this exists

The app's writes arrive through five DOORS: AI chat tools, REST routes, document
extraction, deterministic chat fast paths, and the bulk logger. Historically
each door carried its own copy of the business rules — three expense-creation
implementations, two tracker-entry validation sets, per-door category
vocabularies — so the same user intent produced different results depending on
which door recorded it, and fixing a bug in one door left it alive in the
others. QA became: test → failure → point patch → the same failure through a
different door.

The fix is architectural, not model-side. **The AI interprets; the app owns
consequences.** Interpretation (which tool, which entity, which words mean a
completion) stays at the door. Everything after — validation, dedup,
canonicalization, attribution, the implied writes, and the post-write contract
— lives in ONE service per entity that every door calls.

## The shape

```
chat tool / REST route / extraction confirm / fast path / bulk op
        │  (door-specific interpretation only)
        ▼
canonical service — server/actions/*
        │  validate → dedup → canon → attribute → write → implied writes
        ▼
runMutation() — server/mutation-outcome.ts  (the door-agnostic contract)
        │  before-snapshot → envelope read-back → undo ledger (source=door)
        │  → ChatMutation manifest
        ▼
client sync — chat payload `mutations` / REST `X-Write-Mutations` header
        │  write-sync.ts + chat-sync.ts → cache-patch + cache-bus
        ▼
UI is correct before any refetch
```

## The pieces

| Piece | File | Owns |
|---|---|---|
| Mutation contract | `server/mutation-outcome.ts` | `runMutation()`: one post-write pipeline for every door; `MutationDoor` recorded as the undo-ledger row's `source`; REST manifest transport (`X-Write-Mutations`) |
| Expense service | `server/actions/expense-service.ts` | bounds, recurrence guard, per-door dedup windows, category via `shared/expense-canon.ts`, attribution incl. the "for \<Name\>" safety net |
| Tracker-entry service | `server/actions/tracker-entry-service.ts` | value guards (`shared/tracker-entry-guards.ts`) + normalization + dedup window + **implied writes**: habit auto-checkin (structural, in storage) and linked-goal progress |
| Event service | `server/actions/event-service.ts` | title+date structural idempotency, category canon, weekday-set recurrence, attribution |
| Profile-fact service | `server/actions/profile-fact-service.ts` | "the source entity owns its own dates": birthday → `dateOfBirth`, expiration → named field; the calendar rule is DERIVED (`dateRuleKey` is pure), so restating a fact through any door can never duplicate it |
| Profile resolver | `server/entity-resolver.ts` `resolveProfileByName` | exact → word-boundary both directions → ambiguity surfaced, never guessed. "Roy" never matches "Royale" |
| Tool classification | `shared/ai-tool-classification.ts` | THE read-only tool/action sets (four hand-synced copies before) |
| Date vocabulary | `shared/date-rules.ts` `DateRuleType` | THE union; `shared/temporal-rules.ts` re-exports it |
| Older exemplars | `server/habit-completion.ts`, `server/content-service.ts` | the pattern this layer generalizes — they predate it and already worked this way |

## The invariants (machine-enforced)

- **Door parity** — same semantic input through any door ⇒ same DB end state,
  same manifest, door-tagged ledger row: `tests/door-parity-*.test.ts` +
  `tests/door-parity/harness.ts`.
- **No bypass** — direct `storage.createExpense/createEvent/logEntry` calls are
  budgeted per file, budgets only go down:
  `tests/smoke/contracts/no-bypass-canonical-services.test.ts`.
- **One cache-bust path** — no inline `bustCache` outside the middleware;
  every cached key prefix covered:
  `tests/smoke/contracts/no-inline-cache-busts.test.ts`.
- **Dedupes are honest** — a duplicate returns the existing row with
  `deduped: true`; it writes no ledger row (undo would destroy the original)
  and claims no create in the manifest.

## How to add behavior (the loop-breaker)

1. A failure report arrives ("logged X, page shows Y"). Trace it as
   **interpretation → service → persistence → contract → cache → UI** and find
   which stage broke — do not patch the door where the symptom appeared.
2. A rule fix goes in the SERVICE (or shared canon module); it is then fixed
   for chat, REST, extraction, fast path and bulk at once.
3. Pin it in the entity's door-parity test.
4. A new write path (route, tool, importer) calls the service. The bypass
   budget fails CI if it doesn't.

## Explicitly deferred (decisions, not oversights)

- **Calendar aggregation ×4** (`SupabaseStorage.getCalendarTimeline`,
  `MemStorage` copy, client `useCalendarOccurrences`, `/api/date-rules`): all
  four compose the same shared adapters (`calendar-adapters` /
  `calendar-occurrences` / `date-rules`) but with different filtering/window
  glue (~350 lines in supabase-storage alone). Unifying them is its own
  project: write a golden test against current SupabaseStorage output FIRST
  and treat divergences as explicit decisions. Read-path only — no write can
  fork through it.
- **`shared/habit-intent.ts` vs `shared/habit-completion-intent.ts`**: they
  answer different questions (intent to create/manage vs. report of
  completion) and each carries its own tests; merging is cosmetic.
- **Remaining direct-write sites**: enumerated with reasons in the bypass
  guard's budgets (bulk import loops where the dedup window would fight
  legitimately repeating rows; fast-path quick logs; engine-internal
  self-heal/merge mechanics).
- **ARCHITECTURE.md §5.3 optimistic-mutation remainder**: `write-sync.ts` now
  patches caches from the server response (and from server manifests) for
  every REST write, so the remaining sites are pre-response UX polish.
