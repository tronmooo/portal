# Ownership Consolidation Plan — the fix for "it works one day, breaks the next"

Written 2026-05-28. This is a **plan**, not a code change. Nothing in the app
has been touched. Read it, and when you're ready, the work below can be done in
small reviewable stages.

---

## 1. The root cause, in one sentence

Your app stores the single idea **"which profile does this thing belong to?"**
in *three competing systems at once*, and every write path has to update all of
them by hand — so the moment one path forgets one of them, two screens disagree
and a number goes wrong. Fixing the symptom on one screen never removes the
disagreement, so a different screen breaks next week.

This is not a bug. It is a **data-model problem**. That is why no single prompt
has ever fixed it: every prompt fixed a *symptom* and left the *cause* in place.

---

## 2. The evidence

### 2a. The same concept is stored six+ ways

| Representation | Where it lives | Example fields |
|---|---|---|
| Embedded array on the entity | `linkedProfiles: string[]` on Tracker, Task, Expense, Income, Event, Obligation, Artifact, Document, Goal, Journal, Habit | `shared/schema.ts` |
| Embedded "owner" object/array in `fields` | `fields.owners`, `fields.ownerIds`, `fields.linkedProfileIds` | read by `shared/net-worth.ts` |
| Parent pointer (stored twice) | `parentProfileId` (column) **and** `fields._parentProfileId` (JSON) | `shared/schema.ts:245`, `net-worth.ts:46` |
| Reverse arrays on the profile | `linkedTrackers`, `linkedExpenses`, `linkedTasks`, `linkedEvents` | `Profile` interface |
| Per-type junction tables | `profile_trackers`, `profile_expenses`, `profile_tasks`, `profile_events`, `profile_obligations`, `profile_documents` | `server/supabase-storage.ts` |
| Relational link tables | `asset_party_links`, `liability_profile_links`, `liability_asset_links` (with ownership %) and a generic `entity_links` | `shared/schema.ts`, `supabase-storage.ts` |

That's **three parallel "what is linked to what" systems**: embedded arrays,
per-type junction tables, and relational link tables — plus a fourth generic one
(`entity_links`) that's half-built.

### 2b. The two "canonical" readers don't even agree

- `shared/profile-filter.ts` decides if an item passes the filter using **only**
  the `linkedProfiles` array, with an "orphans belong to self" rule.
- `shared/net-worth.ts` decides if a profile is in scope using `id`,
  `parentProfileId`, `_parentProfileId`, `fields.owners`, `fields.ownerIds`,
  **and** `fields.linkedProfileIds` — and has **no** orphan/self rule.

Both files have comments calling themselves the canonical source. They are not
the same logic. Two "single sources of truth" = zero sources of truth.

### 2c. The regeneration engine is in your own bug comments

`server/supabase-storage.ts` is littered with manual sync code like:

```
// BUG-20260528-ownership-isolation: sync profile_expenses junction.
await this.supabase.from("profile_expenses").delete()...
```

Every create/update/delete has to update the embedded array **and** the matching
`profile_*` junction **and** (for assets/liabilities) the party-link table. These
were patched one at a time, each as a separately-discovered bug. Any code path
that updates the array but forgets the junction (or vice-versa) produces a view
that's silently wrong until you happen to open it. **That is the weekly breakage.**

---

## 3. Why the existing safety net doesn't catch it

`REGRESSION_TESTS.md` + the smoke suite were a real, good step. But:
- The fast gates (`tsc`, unit tests) run at the **code** layer. This bug lives at
  the **data** layer (array vs junction divergence), which they can't see.
- The smoke contract suite runs against **one** fixture account with a small,
  clean shape. The divergence shows up on **messy real data** (legacy rows with
  no link, co-owned assets, profiles edited before a sync path existed).

So the net is real but has a hole exactly where this bug lives.

---

## 4. The target: one source of truth

**Decision to make (my recommendation in bold):**

> **Make the embedded `linkedProfiles: string[]` array the single source of truth
> for simple "this item belongs to these profiles" linkage. Keep the relational
> `asset_party_links` / `liability_profile_links` tables ONLY for the one case a
> flat array can't express — fractional/role-based ownership used in net-worth.
> Delete everything else: the `profile_*` junction tables as a *source*, the
> `fields.owners/ownerIds/linkedProfileIds` variants, and the duplicate
> `_parentProfileId`.**

Why this target (vs. "make the junction tables canonical"):
- `linkedProfiles` is already the most widely used shape and is what the filter
  reads. Fewest readers need to change.
- A single-user personal app does not need join-table query performance; the data
  is small. Embedded arrays are simpler to reason about and verify.
- It collapses three write targets into **one**, which removes the sync code that
  is literally generating the bugs.

If you'd rather make the junction tables the source of truth instead, the plan
shape is identical — only the direction of the migration flips. Either works; the
**non-negotiable** part is that there is exactly **one** source, not three.

### The one resolver everyone uses

After consolidation, exactly one function answers "is X in scope of the filter?",
used by the filter, net worth, the dashboard, and every page:

```
resolveLinkedProfiles(entity): string[]   // reads ONLY linkedProfiles
isInScope(entity, ctx): boolean            // the single rule, incl. orphan/self
```

`profile-filter.ts` and `net-worth.ts` both import and call these. No file is
allowed to re-implement scope logic.

---

## 5. The work, in safe reviewable stages

Each stage is independently shippable, behind the existing pre-push gate, and
each adds a regression test so it can never silently come back. **No "big bang."**

**Stage 0 — Freeze the shape (no behavior change).**
- Write ONE resolver module (`shared/ownership.ts`) with `resolveLinkedProfiles`
  + `isInScope`. Point `profile-filter.ts` and `net-worth.ts` at it. They keep
  reading the same fields for now, but through one function.
- Add a unit test that feeds the same entity to both old call sites and asserts
  identical answers. This locks in "they now agree" before anything moves.

**Stage 1 — One write path.**
- Route every create/update of every entity through a single
  `setLinkedProfiles(entityType, id, ids)` in storage that writes `linkedProfiles`
  and (transitionally) mirrors the junction. One function, one place to be right.
- Delete the scattered per-endpoint sync blocks; they now call the one function.

**Stage 2 — One read path.**
- Make every GET resolve scope through the Stage 0 resolver reading
  `linkedProfiles` only. Stop reading `fields.owners/ownerIds/linkedProfileIds`
  and `_parentProfileId`. (Asset/liability % ownership still reads the party-link
  tables — that's the deliberate exception.)

**Stage 3 — One-time data migration.**
- A migration script that, per user, computes the union of every existing
  representation (array ∪ junctions ∪ `fields.*` ∪ party-links) and writes the
  canonical `linkedProfiles` so no existing link is lost. Dry-run + row-count
  report first; back up the table; then apply.

**Stage 4 — Delete the dead systems.**
- Drop the `profile_*` junction tables (or stop writing them) and remove the
  `fields.owners/ownerIds/linkedProfileIds` and `_parentProfileId` code. Now there
  is physically only one place the data can live, so divergence is impossible.

**Stage 5 — Lock it.**
- A contract test that, for each entity type, creates an item linked to profile A,
  then asserts it appears under filter A and is absent under filter B — and that
  the net-worth total under filter A equals the sum of A's in-scope assets. This
  is the test that would have caught every one of the recurring bugs.

---

## 6. Guardrails so it can't regress

1. **One module owns scope logic.** Add a lint/grep check in the pre-push hook
   that fails if `fields.owners`, `ownerIds`, `linkedProfileIds`, or
   `_parentProfileId` reappear anywhere outside the migration script.
2. **One write function.** Same idea: fail the gate if a `profile_*` table is
   written outside `setLinkedProfiles`.
3. **The Stage 5 cross-check test** stays in the append-only ledger.

---

## 7. Honest limits (what I can and can't promise)

- This **stops the recurring ownership/filter/net-worth breakage at its source.**
  That is the one pattern your last five commits and this whole plan are about.
- It is **not** a blanket "everything in the app now works." There may be
  unrelated bugs elsewhere; those get the reproduce-then-fix-then-regression-test
  treatment, one at a time.
- I **cannot verify against your live data from this environment** (no Supabase
  credentials here). Stages 3–4 in particular touch real data and must be run
  with a backup and a dry-run first, ideally where the live DB is reachable.
- Estimated size: Stages 0–2 are mechanical and low-risk (a day-ish of careful
  work). Stage 3 (migration) is the one to go slow on. Stage 4 is irreversible,
  so it goes last and only after 0–3 are proven.

---

## 8. Recommended first move

Do **Stage 0 only**. It changes no behavior, it's fully reversible, and the moment
it lands, `profile-filter.ts` and `net-worth.ts` can no longer disagree — which
removes the single most common cause of "this number is wrong." Everything after
that is optional and incremental, and you can stop at any stage with the app in a
better state than before.
