# Production audit 2026-07-29 — remediation

Response to the production audit against commit `a6ba6c3`. Every finding below
was **re-verified against the live database before any change was written** —
the audit's numbers all reproduced exactly.

Verification: `npm run check` (typecheck), `npm test` (1765 tests, 132 files),
`npm run test:migrations` (throwaway PostgreSQL cluster).

---

## Blockers

### 1. Cross-user profile associations — FIXED

**Verified in production first.** The audit's two rows reproduced exactly, and
turned out to be a *mirrored swap* between two accounts:

| Row | Owner | Pointed at | Owned by |
| --- | --- | --- | --- |
| `habits` `32394c86…` "Drink 8 glasses of water" | `d2064ce8…` | profile `e0654d9a…` "Rex" | `6f63cf74…` |
| `trackers` `a9c97993…` "Medication - Mom" | `6f63cf74…` | profile `1e0b9eef…` "Mom" | `d2064ce8…` |

A wider sweep across all ten `linked_profiles` tables also found dangling
references to profiles that no longer exist: 3 in `events`, 4 in `habits`, 4 in
`incomes` (counting soft-deleted rows, which matter because they can be
restored or updated later).

**Fix:** `migrations/20260729_linked_profiles_ownership_guard.sql`

1. Prunes every invalid element from every `linked_profiles` column. Data-driven
   from `information_schema`, so it covers both the JSONB tables and the
   `text[]` tables (`incomes`, `journal_entries`) without a hardcoded list.
2. Installs `enforce_linked_profiles_ownership()` as a `BEFORE INSERT OR UPDATE`
   trigger on all ten tables. It rejects any reference that is non-UUID,
   missing, or owned by another user.
3. Verifies, and fails the migration if anything invalid survived.

**Two deliberate design decisions**, both documented in the migration header:

- **Invalid references are removed, not re-pointed.** Re-pointing would invent
  an association the user never made. The migration records that tracker
  `a9c97993…`'s owner has their own "Mom" profile (`fc3a2470…`) so a human can
  re-point it deliberately; the habit's owner has no "Rex" profile at all.
- **"Profile must still be active" is enforced only for newly added links.**
  Enforcing it on every element would mean soft-deleting a profile retroactively
  bricks every unrelated `UPDATE` on every row that ever referenced it — turning
  a cleanup into an outage. Adding a link to a soft-deleted profile is still
  rejected, which is what actually prevents new bad data.

**Tests** (`npm run test:migrations`, 9 groups): cross-account INSERT rejected;
cross-account UPDATE rejected; legitimate same-user associations still work;
dangling reference rejected; soft-deleted link rejected; grandfathered links do
not block unrelated updates; `text[]` tables enforced too; empty/null accepted;
re-running the migration repairs 0 rows.

### 2. AI reports writes that never occurred — FIXED

**Root cause, two independent defects that compounded:**

1. `SupabaseStorage.logEntry()` ran an `INSERT` and then returned an entry
   object **assembled from local variables**. It never asked the database what
   it had stored, so a write that did not persist still produced a perfectly
   well-formed success value.
2. `log_tracker_entry` was **absent from `TOOL_ENTITY` in `server/ai-envelope.ts`
   entirely**. Tracker-entry writes therefore got the `success: true` envelope
   with *no verification computed at all* — `database_record_exists` was never
   even calculated. The envelope then hardcoded `success: true` for anything
   that did not throw, leaving it to the model to notice a discrepancy that was
   not in its input. It reported "logged 24 oz" for a row that did not exist.

**Fix:**

- `logEntry()` now uses `.insert(...).select().maybeSingle()`, so the INSERT
  returns the row as committed. A missing row throws; a row whose id, tracker or
  user does not match what we submitted throws. The value returned to callers is
  now read from storage, not reconstructed from intent. Same read-back contract
  added to the in-memory storage.
- Added `getTrackerEntry(id)` to `IStorage` and both implementations — an
  authoritative by-primary-key read-back.
- Registered `log_tracker_entry` / `update_tracker_entry` / `delete_tracker_entry`
  in the envelope, verified via a new `byId` hook. `byId` is preferred over the
  list scan wherever available: it is one indexed lookup instead of a per-user
  list read (also helps blocker 3), and it **cannot be fooled by a truncated
  list** — tracker entries are capped at the 50 newest per tracker, so a list
  scan could report a good write as failed.
- **Failed verification is now an error, not a success.** `finalizeToolResult`
  returns `success: false` with an `error` when a create/update reads back
  absent, or when a delete reads back still-present. Because the engine already
  gates on `!result.error`, this automatically means a failed write no longer
  writes an action-log row and no longer renders a success action card — it
  reaches the model as a failure.
- Tightened the system-prompt rule to name the failure mode explicitly.

**Tests:** `tests/tracker-entry-write-verification.test.ts` drives the real
`logEntry()` against a scripted Supabase double covering failed, delayed,
interrupted and mismatched inserts plus duplicate-submit protection;
`tests/ai-envelope.test.ts` covers the envelope's verification and failure
contract for tracker entries.

> One existing test asserted `expect(env.success).toBe(true)` on an
> unverified write, commented *"envelope reports; the MODEL decides how to
> phrase it"*. That assertion encoded the defect. It has been inverted, with the
> reasoning recorded at the test.

### 3. Production API timeouts — PARTIALLY FIXED (see caveat)

**What I could verify:** `vercel.json` declares `maxDuration: 60` for
`api/index.js`, matching the reported 60s timeouts, and `300` for `api/ai.js`.

**Root cause found in code:** all **eight** Anthropic client constructions used
the SDK defaults — a **10-minute timeout with 2 retries**. A single slow
upstream call could occupy the entire 60s function budget many times over, and
the platform killed the request before the call gave up. Several call sites also
built a brand-new client per request, discarding HTTP keep-alive.

**Fix:** `server/anthropic-client.ts` provides shared, memoized, budget-bounded
clients with two presets matched to the two serverless functions:

| Preset | Per attempt | Attempts | Worst case | Function limit |
| --- | --- | --- | --- | --- |
| `standard` | 22s | 2 | 44s | 60s (`api/index.js`) |
| `extended` | 90s | 2 | 180s | 300s (`api/ai.js`) |

All eight sites now use it. `tests/anthropic-budget.test.ts` pins the invariant
that worst case (timeout × attempts) stays inside the `maxDuration` **read from
`vercel.json` itself**, so changing one without the other fails the build.

**Caveat — this is the honest part.** The Vercel MCP tools return no teams for
this account, so I could **not** pull the runtime-error clusters to confirm
which routes produced the 195 timeouts, and I could not measure P50/P95/P99.
The bounded-call fix addresses the clearly-unbounded external calls found by
reading the code, but **the audit's remaining latency asks — parallelising
independent reads, removing redundant context queries, persisting operation
progress, and splitting long work into resumable jobs — are NOT done.** Those
need the per-route latency data to target correctly; guessing at them would be
churn. Treat blocker 3 as mitigated, not closed.

---

## Other confirmed issues

| Status | Issue |
| --- | --- |
| **Fixed** | Three active events reference deleted/missing profiles — pruned by the blocker-1 migration, which also covers 4 in `habits` and 4 in `incomes` that the audit did not list. |
| **Fixed** | Three active tracker entries reference soft-deleted trackers — `migrations/20260729_tracker_entry_orphans.sql` back-fills them and adds a trigger so soft-deleting a tracker cascades to its entries (and restoring brings back exactly the entries that went down with it, never ones deleted individually beforehand). |
| **Fixed** | Auto-profile creation raced the unique self-profile constraint — the loser of that race is the index working correctly, so `server/auth.ts` now recognises SQLSTATE 23505 and logs it as information instead of an error. Note the underlying check-then-act is inherent to serverless (each instance has its own cache); the constraint is the real guard, and it holds. |
| **Fixed** | Chat input relied on placeholder text — added a persistent visible `<label>` bound via `htmlFor`. |
| **Fixed** | Vercel did not identify the project framework — added `"framework": "vite"` and the config `$schema`. |
| **Not fixed — needs a human decision** | **25 duplicate profile groups / 34 excess active rows.** I checked whether these could be safely auto-retired. They cannot: 3 are referenced by other records, and **all 34 carry their own content** (non-empty `fields`, `tags`, `notes`, or `linked_*` arrays). An automated merge would destroy user data. These should go through the existing reviewed `merge_profiles` flow. A DB unique index cannot be added until they are resolved. |
| **Not fixed — dashboard setting** | **Supabase leaked-password protection disabled.** Confirmed still the only outstanding security advisor. This is a project auth setting, not source-controlled and not reachable from the MCP tools — enable it at Auth → Providers → Password. See <https://supabase.com/docs/guides/auth/password-security>. |
| **Not reproduced** | **Redundant `/user` authentication calls.** `server/auth.ts` already implements both a 60s token cache *and* in-flight single-flight coalescing, and the client does not call `getUser` repeatedly. The remaining same-second duplicates are most likely one per concurrent serverless instance, each with its own module-level cache — inherent to the platform, and not fixable without a shared cache. I did not change anything here rather than invent a fix for a cause I could not confirm. |
| **Not investigated** | Reminder/event time conflict; profile rename reporting false success; note, medication and liability attaching to the wrong profile; journal date change silently failing; expense reassignment retaining an extra profile; orphaned liability payment profile. These are separate write-path correctness bugs. The blocker-2 verification work makes a *silent* false success much less likely across every mapped write tool, but each of these needs its own reproduction and fix. |

---

## Running the tests

```bash
npm run check           # typecheck
npm test                # 1765 unit/integration tests
npm run test:migrations # migrations against a throwaway PostgreSQL cluster
```

## Deployment note

The two migrations in `migrations/` are **not applied to the production
database by this change.** They are idempotent, self-verifying, and tested, but
they install triggers that reject writes and they mutate existing rows, so they
should be applied deliberately and observed. Apply
`20260729_linked_profiles_ownership_guard.sql` first, then
`20260729_tracker_entry_orphans.sql`.
