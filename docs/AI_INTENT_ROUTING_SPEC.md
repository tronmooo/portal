# AI Intent-Routing Specification

**The master contract for how the chat turns natural language into database
actions.** Implement against this document, not against individual bug
reports. When a sentence breaks, the fix is to strengthen the rule family it
belongs to — never to special-case the phrase.

The prime directive, above every rule below:

> **The AI never executes directly from the raw sentence.** A message is first
> turned into a complete structured interpretation — who, what, when, how
> much, for every action it contains — and only then does anything touch the
> database. Database uniqueness rules are a safety net, never a substitute for
> language understanding.

Status legend used throughout:
- ✅ **enforced** — deterministic code path, regression-tested
- ⚠️ **prompt-only** — the model is instructed but nothing checks it
- ❌ **missing** — not implemented

---

## 1. The pipeline contract

Every chat message flows through this pipeline. Each stage names the module
that owns it — one owner per concern, shared by every entry point.

| # | Stage | Owner | Notes |
|---|-------|-------|-------|
| 1 | HTTP entry, rate limit, idempotency, timezone capture | `server/routes.ts` `POST /api/chat` (~:1312) | `Idempotency-Key` replay cache; user TZ stamped on storage |
| 2 | **Deterministic intent plan** — before ANY model call | `parseTurnPlan()` in `shared/ai-intent.ts` | One `ParsedIntent` {entity, operation, target, fields, confidence} per write-shaped clause. Advisory below confidence 0.7; blocking only when the whole message parsed (`exhaustive`) |
| 3 | Fast paths (doc open, quick weight/BP/mood logs) | `server/ai-engine.ts` `tryFastPath()` | Bails on multi-intent messages |
| 4 | Fresh DB context snapshot + system prompt | `buildSystemPrompt()` (~:4924) | Snapshot beats conversation history; history is for reference resolution only |
| 5 | **Deterministic directives appended to the user turn** | `buildContentRoutingDirective` (note/journal/task), `buildReferentDirective` (`shared/referent-resolution.ts` — who is "she"), `buildDistributionDirective` (`shared/distribution.ts` — who gets how much) | Appended to the USER turn, never the cached system prompt |
| 6 | Path selection | `shouldUseBulkPath()` in `shared/action-split.ts` | ≥4 action clauses and no mixed read/update signals → bulk |
| 7a | **Bulk path**: one forced `extract_actions` call emits the WHOLE plan, then each op executes independently | `server/ai-bulk-log.ts`, `runBulkLogPath()` | Full plan-before-write; self-audits coverage against clause count |
| 7b | **Agentic loop**: model emits tool calls, each gated then executed | `ai-engine.ts` main loop (~:15290+) | ≤15 rounds / ≤60 tool calls / 90 s |
| 8 | **Routing gate** on every non-read tool call | `shared/ai-tool-routing.ts` | Stale-replay block, duplicate-create-in-turn block (owner-scoped), note-vs-journal hard block, create-downgraded-to-update block. Refusals return model-facing corrective directives |
| 9 | Validation → before-rows capture → execute → read-back verify → undo ledger → cache manifest | `validateAiPayload`, `server/ai-envelope.ts` | Every write verified by re-read; `ChatMutation[]` tells the client exactly what changed |
| 10 | Per-operation outcome ledger | `OperationOutcome` (`ok \| failed \| skipped \| deduped`) | No rollback by design: action 3 failing never undoes 1, 2, 4, 5 — and never claims they failed |
| 11 | **Claim check** — reply vs. what actually executed | `ai-engine.ts` (~:16064) | A reply claiming success with zero executed writes is replaced with an honest failure; bulk replies are built deterministically from outcomes, not by the model |

---

## 2. Rule families

### 2.1 Who does this belong to? — ownership & entity resolution

Every stored object carries its owner in `linked_profiles` (JSONB uuid[] on
the entity row — the sole source of ownership truth, `shared/ownership.ts`).
Tracker **entries** additionally stamp a scalar `profileId`
(`shared/schema.ts` InsertTrackerEntry) — that scalar is what makes per-person
dedup possible.

- ✅ People/pets/assets/liabilities resolve via `resolveProfileByName`
  (`ai-engine.ts` ~:6380): exact → word-boundary → materially-more-specific,
  returning `found | ambiguous | none`. Ambiguous → ask, never guess.
- ✅ Tasks/habits/goals/events resolve via `resolveActionable`
  (`server/entity-resolver.ts`) with the same ask-on-ambiguity policy and
  cross-kind hints ("no task, but a habit by that name exists").
- ✅ Pronouns ("she", "it") resolve deterministically BEFORE the model sees
  the turn (`shared/referent-resolution.ts`): only when the message names
  nobody itself and exactly one candidate appears in a recent USER turn.
  Anything else stays a question. Pinned by `tests/qa-2026-08-22-findings.test.ts`.
- ✅ "me" / "myself" / no profile = the self profile. Orphans (empty
  `linkedProfiles`) belong to Self (`shared/profile-filter.ts`).
- ✅ "Everyone" = empty profile selection. It renders a household view over
  owned records (`shared/scope.ts`, `HouseholdDashboard`); it never erases or
  rewrites ownership.
- ⚠️ `matchProfileByName` (legacy) silently picks the first match on
  ambiguity; still used by `create_habit`. Backlog item 7.

**Never let one profile's data block another profile's data.** See §3.

### 2.2 What kind of thing is this? — classification

- ✅ Note vs Journal vs Task: `shared/content-routing.ts`, enforced as a HARD
  gate (a journal tool on an explicit note request is blocked, not advised).
  Explicit user intent ("make this a journal entry") beats inference.
- ✅ Tracker vs habit vs task vs event vs recurring rule: tool schema +
  per-domain prompt CRUD tables; `shared/habit-intent.ts` for explicit
  habit create/check-in intent.
- ✅ Semantic, not keyword: "I ran two miles" → tracker; "run two miles
  tomorrow" → task/event; "I run every Monday" → habit; "running has helped
  my mood" → journal — encoded in prompt rules + content router confidence.

### 2.3 Create, append, update, delete, complete, or query?

- ✅ Structural: operation derives from the tool name
  (`toolOperation()` in `shared/ai-tool-routing.ts`): `delete_*`/`remove_*` →
  delete; `create_*`/`log_*`/`add_*` → create; `complete_*`/`checkin_*`/
  `pay_*` → complete; `get_*`/`search*`/`query_*`/`recall_*` → read; rest →
  update.
- ✅ **Append is a species of create that must never be deduped as one**:
  `ENTRY_APPEND_TOOLS` (`log_tracker_entry`, `journal_entry`, `log_income`,
  `add_liability_payment`, `log_medication_dose`, …) are exempt from the
  one-record-per-turn guard — two entries on one tracker in a turn is the
  normal case.
- ✅ Create is never silently downgraded to update
  (`create_downgraded_to_update` block): a same-named record existing is not
  permission to update it — ask instead.
- ✅ Questions are reads: `shared/ai-intent.ts` `detectOperation()` — a
  question is a read even when it contains a write verb. Reads are never
  gated and never create data.

### 2.4 How many actions hide in the sentence?

- ✅ One message legitimately produces 1–60 writes across domains.
  `shared/action-split.ts` counts action clauses conservatively (questions
  dropped; "mac and cheese" survives). ≥4 clauses → the bulk path extracts
  the complete operation list in ONE model call before any write.
- ✅ Coverage is audited: bulk extraction retries once if it produced fewer
  ops than the deterministic clause count; the reply-side rule requires every
  clause to map to a tool call or an explicit "not logged because…".
- ✅ Multiple actions in one message are NOT duplicates of each other — the
  turn-level dedup key is `{entity, name, owner}`, and append tools are
  exempt entirely.

### 2.5 How are values distributed? — each / both / together / respectively

Owner: `shared/distribution.ts` (deterministic, mirrors the referent
resolver), emitting a `[DISTRIBUTION]` directive on the user turn, plus the
DISTRIBUTION WORDS prompt block. Pinned by `tests/distribution.test.ts`.

- ✅ "Sarah and I **each** ran 3 miles" / "we **both** took our vitamins" →
  the value applies PER PERSON: one write per subject, same value, each with
  its own owner. Same value + different owner is two records, never a dup.
- ✅ "**Together** we drove 400 miles" / "$60 **in total**" → SHARED TOTAL:
  never logged once per person (that double-counts). Stated split → use it;
  otherwise record once for the user and say it was shared, or ask if the
  split matters.
- ✅ "Bob and Jane ran 2 and 3 miles **respectively**" → ordered pairing,
  one write per (name, value) pair. Value-count ≠ subject-count → no reading
  (ambiguity stays a question).
- ✅ Refusals: questions, negations, bare coordination without a
  distribution word, and multi-value "each" sentences produce NO directive —
  a half-understood hint is worse than none.

### 2.6 What does context refer to? — pronouns, follow-ups, corrections

- ✅ Pronoun resolution: §2.1. `[REFERENT]` directive settles it; two-or-more
  candidates → ask (prompt rule 4/4a).
- ✅ Corrections update, never append: per-domain update tools
  (`update_tracker_entry` for "actually make that 3 miles",
  `update_liability_payment` for "that payment was actually $1450",
  `update_memory` — "NEVER save a second memory for a correction"), plus the
  `undo_last_action` ledger. Back-reference detection (`hasBackReference`,
  `shared/ai-intent.ts`) keeps correction-shaped messages from being blocked
  as stale replays.
- ✅ Corrections target the referenced record only, not every match.
- ⚠️ No regression tests for write corrections end-to-end. Backlog item 5.

### 2.7 What does tense mean?

- ✅ Past = log; future = task/event; recurring language = habit/rule;
  hypotheticals and negations create nothing. Deterministic vetoes live in
  `shared/habit-completion-intent.ts` (FUTURE_OR_HYPOTHETICAL, NEGATION,
  INTERROGATIVE with a polite-command carve-out, third-person-subject guard)
  — pinned by `tests/habit-completion-pipeline.test.ts`.
- ⚠️ Those deterministic vetoes protect HABITS only; for expenses, tasks and
  trackers, negation/hypothetical safety is prompt-only. Backlog item 4.
- ✅ Quoted speech never self-resolves a pronoun; quoted strings are stripped
  before resolution (`stripLiterals`).

### 2.8 What date does it belong to?

- ✅ Explicit calendar dates parse timezone-safely
  (`shared/timezone.ts` `parseNaturalCalendarDate`: spoken forms, missing
  years roll forward, past years preserved for backdating) — the heaviest
  test coverage in the repo (`tests/date-rules.test.ts`,
  `tests/temporal-rules.test.ts`, `tests/timezone-dst.test.ts`,
  `tests/entry-date-anchor.test.ts`).
- ✅ Relative words ("yesterday", "next Friday") are resolved BY THE MODEL
  from the prompt's live date table (current date + 7-day weekday reference),
  and `create_event` must emit an explicit YYYY-MM-DD or ask.
- ✅ Once parsed, backdating is correct: date-only values anchor to noon in
  the USER's timezone, and the entry is saved on the referenced day, not the
  message day.
- ❌ The `log_tracker_entry.at` parser is bare `new Date()` although its
  schema promises natural language — "yesterday" silently becomes NOW.
  `journal_entry.entryDate` silently falls back to today on any non-ISO
  value. Backlog item 3.

### 2.9 Where should it appear? — multi-representation facts

- ✅ Recurrence is RULE-BASED, never materialized copies:
  `shared/temporal-rules.ts` (rules derived, idempotent `dateRuleKey`),
  `shared/task-occurrences.ts` (projected), `shared/habit-schedule.ts`
  (predicate), `shared/date-math.ts` (clamped date arithmetic, shared with
  the client).
- ✅ A birthday belongs to the profile AND the calendar — the calendar
  derives yearly occurrences from the profile field; `create_event` redirects
  bare birthday titles into the profile field.
- ❌ The prompt's birthday instruction ("ALWAYS also create_event '🎂 X's
  Birthday'") defeats both dedup defenses (the emoji breaks the label parser;
  the missing forProfile breaks shadow suppression) → duplicate birthday
  renders. Backlog item 2.

### 2.10 Reuse before create — and what counts as a real duplicate

**The duplicate contract: same owner + same underlying record identity +
same relevant value/time-window. Never "same activity type happened in the
same chat turn." Owner is always part of the key.**

Four dedup layers (each a safety net for the one above, none a substitute
for interpretation):

1. **Turn-level routing guard** (`shared/ai-tool-routing.ts`): blocks a
   second CREATE of `{entity, name, owner}` in one turn. Append tools exempt.
   ✅ owner-scoped (commit `a96453a`). Pinned by `tests/ai-turn-integrity.test.ts`.
2. **30-second in-memory lock** (`ai-engine.ts` `isDuplicateCreation`): keys
   for task/expense/event all include `forProfile`. ✅
3. **2-minute DB read-back window** per tool handler:
   - tracker entries ✅ profile-scoped (commit `1e9cad7`) **and compares
     explicit values only** — enrichment estimates (steps/duration/calories)
     drift as history accrues and are provenance, not identity;
   - expenses ✅ owner-set-scoped; events ✅ owner-set-scoped; tasks ✅
     unowned-is-Self, not a wildcard (all three fixed 2026-08-24).
   All pinned by `tests/dedup-owner-scope.test.ts`.
4. **DB uniqueness**: habits UNIQUE(user_id, name); trackers partial unique
   (user_id, name). ⚠️ Neither includes profile, which forces name-mangled
   per-person trackers ("Running - Sarah"). Backlog item 6.

Tracker reuse ladder (`pickTrackerForLog`, `ai-engine.ts`, unit-tested):
prefer the target's owned tracker → adopt an orphan (and persist the
adoption) → clone per-person ONLY when every name match belongs to someone
else. Identity matching is centralized in `shared/tracker-identity.ts` —
key equality or token-boundary containment, never raw `.includes`.

### 2.11 Explicit vs inferred values

- ✅ User-stated values are saved exactly; estimates only fill MISSING
  fields, are marked (`_enrichment.estimated` with assumptions), and never
  overwrite explicit values (`applyEnrichmentToValues`).
- ✅ Estimates are excluded from duplicate identity (§2.10 layer 3).

### 2.12 What must NOT trigger a write

- ✅ Questions (read-only, §2.3), negations and hypotheticals (habit domain
  deterministic, elsewhere prompt — §2.7), comparisons and general
  discussion (front-door/advisory path), quoted speech (stripped in
  resolution; prompt forbids logging quotes as the user's own data).
- ✅ The claim check guarantees the REPLY can't pretend a write happened:
  unsupported success claims are replaced with grounded summaries.

### 2.13 When to ask a question

- ✅ Bias to action for clear CRUD; ask ONLY when ambiguity changes the
  result: two-or-more matching profiles/entities, ambiguous medication
  ("recency is not consent"), unresolvable event date, vague reads
  ("how much have I spent" → over what period?), "Log 20" with no metric.
- ✅ "Sarah and I ran two miles" never needs a follow-up (distribution
  module + append exemption make it two writes).
- ✅ Save-then-ask ordering for asset details: save to the closest match
  first, then ask one short question if genuinely ambiguous.

### 2.14 Manual actions and AI actions share business logic

- ✅ Habit completion is ONE pipeline (`server/habit-completion.ts`
  `completeHabitOccurrence`) reached by the manual checkbox route, the AI
  `checkin_habit` tool, AI inference from activity reports, and tracker
  writes (auto-checkin runs inside both storages' `logEntry`). Idempotency
  is structural (clamp to remaining).
- ❌ Two known breaches: the deterministic fast path calls
  `storage.checkinHabit` directly (no mirror write, fabricated streak
  number), and UN-completing a habit doesn't remove the mirrored tracker
  entry on either entry point. Backlog item 8.

### 2.15 UI updates after a write

- ✅ The server returns a `ChatMutation[]` manifest naming exactly what
  changed; `client/src/lib/chat-sync.ts` patches rows synchronously and
  invalidates via the single-owner domain map (`client/src/lib/cache-bus.ts`,
  cross-tab via BroadcastChannel). Server caches bust through the write
  barrier with read-your-writes versioning.
- ❌ Chat action-card Edit/Undo handlers bypass `invalidateDomains` with
  hardcoded 3-key lists; there is no `finance` domain in
  `shared/entity-domains.ts`. Backlog item 9.

### 2.16 Failures

- ✅ Per-operation isolation: a failed action never blocks or rolls back its
  siblings ("one habit failing must not stop the others"). Every operation
  reports `ok | failed | skipped | deduped`; bulk replies enumerate exactly
  which succeeded and which failed, built deterministically from outcomes.
- ✅ Tool errors are translated before reaching the user (model-facing
  directives never leak); failures are recorded to the failure log for
  observability.

---

## 3. The canonical worked example

> "Sarah and I both ran two miles yesterday and remind us to run again Friday."

Interpretation (before any write):

| # | type | owner | payload |
|---|------|-------|---------|
| 1 | tracker_entry (append) | Self | Running, distance 2 mi, date = yesterday (resolved in user TZ) |
| 2 | tracker_entry (append) | Sarah Miller | Running, distance 2 mi, date = yesterday |
| 3 | task/reminder | Self | "Run", due Friday (resolved date) |
| 4 | task/reminder | Sarah Miller | "Run", due Friday |

Enforcement points: distribution module reads "both … two miles" as
per-person (§2.5); append exemption keeps 1+2 from colliding (§2.3); the
2-minute window tells them apart by `profileId` (§2.10); tense splits the
past-tense log from the future-tense reminders (§2.7); "yesterday"/"Friday"
resolve before persistence (§2.8); four `OperationOutcome`s report exactly
what landed (§2.16).

---

## 4. Prioritized gap backlog

Work these top-down; each is a rule-family strengthening, not a phrase patch.

1. ~~Owner-blind 2-min dedup for expenses/events, task unowned-wildcard~~ —
   **fixed 2026-08-24** with regression tests (`tests/dedup-owner-scope.test.ts`).
2. **Birthday dual-representation**: prompt (`buildSystemPrompt`, birthday
   block) mandates a "🎂 X's Birthday" event with no `forProfile`; the
   emoji breaks `parseBirthdayLabel`'s redirect and the missing profile link
   defeats shadow suppression (`shared/calendar-adapters.ts`). Fix: prompt
   should pass a bare "X's Birthday" title WITH forProfile, or drop the
   create_event half entirely and rely on the profile-derived occurrence.
3. **Relative dates in `log_tracker_entry.at` / `journal_entry.entryDate`**:
   route both through `parseUserDateTime` (already used by tasks) instead of
   bare `new Date()` / strict-ISO-with-silent-fallback.
4. **Generalize negation/hypothetical vetoes** beyond habits: lift the
   regexes from `shared/habit-completion-intent.ts` into a shared veto module
   consulted by expense/task/tracker writes (or the routing gate).
5. **Write-correction regression tests**: "actually make that 3 miles" /
   "that was actually $92" through `update_tracker_entry` /
   `update_liability_payment` against the storage double.
6. **Per-profile tracker uniqueness**: today the DB unique index is
   (user_id, name), so per-person trackers get mangled names
   ("Running - Sarah", "Running 2") partially hidden at read time; the
   ai-engine comment even denies the index exists. Decide: composite index
   including owner, or keep suffixing but heal ALL suffix forms.
7. **Retire `matchProfileByName`** (silently guesses on ambiguity) — migrate
   `create_habit` and the create_profile parent fallback to
   `resolveProfileByName`.
8. **Unify the remaining habit paths**: fast-path check-in must go through
   `completeHabitOccurrence` (mirror write, honest streak); un-completion
   must delete the `_habitId` mirror entry on both the AI and manual routes.
9. **Cache-bus leaks**: chat action-card Edit/Undo must call
   `invalidateDomains`; add a `finance` domain to `shared/entity-domains.ts`
   and finance cache prefixes to the server barrier.
10. **CI runs nothing**: `.github/workflows/ci.yml` runs typecheck + build
    only — the ~190-file unit suite (where every rule above is pinned) runs
    only when someone types `npm test`. Add it to CI.
11. **Bulk whitelist hygiene**: `create_reminder` is whitelisted in
    `server/ai-bulk-log.ts` but no such tool exists (reminders are tasks);
    extraction emitting it fails at execute. Remove or alias to
    `create_task`.
12. **Three read-only tool lists** (`READ_ONLY_TOOLS`, the inline array in
    the loop, and the `toolOperation` regex) must stay in lockstep; only one
    pair is guarded by tests today.
13. **Ownership writer adoption**: AI-engine ownership writes bypass the
    `server/ownership-writer.ts` chokepoint (and its audit trail); asset
    ownership writes bypass `setAssetOwners` and can still create sum>100
    states (see OWNERSHIP_REDESIGN.md open items).

---

## 5. How to extend this spec

Adding a new language capability = adding a deterministic shared module +
a directive + prompt rules + unit tests, in that order (the referent and
distribution resolvers are the templates). Adding a new write tool = naming
it so `toolOperation()` classifies it correctly, deciding if it's an append
tool, and making its handler's dedup key include the owner. If a change
can't say which rule family it strengthens, it's a phrase patch — rethink it.
