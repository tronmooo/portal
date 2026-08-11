# Stabilization Audit — Single Source of Truth

Status date: 2026-06-04
Branch: `claude/app-stabilization-audit-h4Fcp`

This document records the stabilization audit requested: identify every model,
document the ownership / filtering / classification / sync rules, and enforce
**one source of truth** so dashboard, filters, popups, AI chat, calendar,
obligations, assets, liabilities, and linked profiles agree to the dollar.

The audit found that most of the consolidation was already shipped across prior
stages (see `shared/scope.ts`, `shared/ownership.ts`, `shared/net-worth.ts`).
This pass closed a remaining divergence (duplicated asset/liability type sets in
the server dashboard) and locked the rules with regression tests.

---

## 1. Models / entities

| Entity            | Table              | Ownership storage                              |
| ----------------- | ------------------ | ---------------------------------------------- |
| Profiles          | `profiles`         | own `id` + `parent_profile_id` column          |
| Assets            | profile subtype    | `asset_party_links` (fractional %)             |
| Liabilities       | profile subtype    | `liability_profile_links` (fractional %)       |
| Subscriptions     | profile + obligation | recurring obligation (NOT a balance-sheet item) |
| Obligations       | `obligations`      | `linked_profiles` JSONB                        |
| Budgets           | `budgets`          | scoped by `profileId`                          |
| Trackers          | `trackers`         | `linked_profiles` JSONB                        |
| Calendar events   | `events`           | `linked_profiles` JSONB                        |
| Expenses          | `expenses`         | `linked_profiles` JSONB                        |
| Habits            | `habits`           | `linked_profiles` JSONB                        |
| Tasks / Goals     | `tasks` / `goals`  | `linked_profiles` JSONB                        |
| Income / Journal  | `incomes` / `journal_entries` | `linked_profiles` JSONB             |
| Dashboard metrics | derived            | computed from the above under the active filter |

## 2. Ownership rules (single writer)

- **One writer.** All ownership writes go through `setOwners` in
  `server/ownership-writer.ts`, using primitives in `shared/ownership.ts`. No
  other code writes `linked_profiles` or a junction table.
- **Default to self.** `normalizeOwners(candidate, selfId)` drops non-UUID
  entries and, if nothing usable remains, assigns the record to the current
  user (`defaultedToSelf`). "If no owner is specified → Mine."
- **Auto-owner for assets/liabilities.** `resolveAutoOwner` walks the parent
  chain: a person ancestor owns it; a Self ancestor (or no parent) → Self; an
  orphan tree → no auto-claim (prevents the "Jane Doe" bug where Self claimed
  every person's asset).
- **Names are only labels.** Ownership is stored as IDs only.

## 3. Filtering rules (single decision)

- **One primitive.** `isInScope(candidateOwnerIds, ctx, orphanPolicy)` in
  `shared/scope.ts` is the only place the "is this in scope?" decision lives.
  Both `passesProfileFilter` (entities) and `isProfileInNetWorthScope`
  (asset/liability profiles) delegate to it.
- **No active filter ⇒ everything passes.**
- **Orphan policy.** Entities with no `linkedProfiles` belong to "me" — visible
  when the selection includes a self profile (`belongs_to_self`). Asset/
  liability profiles use `out_of_scope` (every profile is its own owner).
- **Consequence:** every dashboard card, popup, chart, calendar item,
  obligation, asset, liability, tracker, and budget filters through the same
  decision, so a selected profile yields one consistent answer everywhere.

## 4. Classification rules (single type set)

- **Canonical sets** live ONLY in `shared/asset-value.ts`:
  `ASSET_PROFILE_TYPES` and `LIABILITY_PROFILE_TYPES`, read via
  `isAssetProfile` / `isLiabilityProfile`.
- **Subscriptions are obligations, never assets.** `subscription` is absent
  from both sets. A subscription's `cost` field is a recurring expense and must
  never reach net worth (BUG-NW-1). Locked by
  `tests/asset-classification.test.ts`.
- **THIS PASS — divergence removed:** `server/supabase-storage.ts` previously
  inlined six hardcoded copies of these sets in its dashboard / net-worth
  breakdown code. They were identical but free to drift. All six now import the
  canonical constants. A regression guard fails the build if any production file
  re-inlines those literals.

## 5. Sync rules

- **Calendar auto-generation.** `autoGenerateProfileEvents` creates events from
  profile date fields (renewal, birthday, next service, next visit) and from
  obligation `nextDueDate` / `frequency`, so the calendar reflects the same
  records the rest of the app holds.
- **Monthly normalization.** Recurring amounts use `toMonthlyAmount` (exact
  52/12, 26/12 multipliers) everywhere, so spend totals match across surfaces
  (BUG-20260528-monthly-multipliers).

---

## QA checklist — expected vs. actual

| Area | Check | Expected | Actual |
| --- | --- | --- | --- |
| Ownership | Create record with no owner | Assigned to current user / Mine | ✅ `normalizeOwners` defaults to self |
| Ownership | Asset created under a person | That person owns it (not Self) | ✅ `resolveAutoOwner` |
| Filter | Select a profile | Every card/popup/chart/calendar shows only that owner's data | ✅ single `isInScope` |
| Filter | No filter active | All records show | ✅ inactive selection = everyone |
| Filter | Orphan entity, self selected | Shows | ✅ `belongs_to_self` |
| Classification | Subscription with cost | Excluded from net worth | ✅ not in type sets; test-locked |
| Classification | Subscription | Treated as obligation | ✅ obligation `kind: "subscription"` |
| Dashboard | Net worth on dashboard vs finance vs popup | Same number | ✅ all route through `computeNetWorth` / shared sets |
| Dashboard | Server asset breakdown | Uses canonical type sets | ✅ consolidated this pass |
| Popup | Net Worth popup rows | Sum to the headline total | ✅ server builds the breakdown arrays |
| AI chat | "Add Netflix subscription" | Creates subscription/obligation, not an asset | ✅ `ai-engine.ts` subscription path |
| Calendar | Obligation with due date | Appears on calendar | ✅ `autoGenerateProfileEvents` |
| Sync | Monthly spend totals | Consistent multipliers | ✅ `toMonthlyAmount` |

## Regression coverage added this pass

`tests/asset-classification.test.ts` (5 tests):

1. `subscription` absent from both canonical type sets.
2. A subscription profile with a `cost` field is neither asset nor liability.
3. `computeNetWorth` ignores a subscription's cost entirely (assets = 0).
4. A real asset alongside a subscription counts only the asset.
5. Build guard: no production file re-inlines a canonical type-set literal.

Full unit suite: **180 passing.** `tsc --noEmit`: clean.

> Note: the network-dependent smoke contract suite (`tests/smoke/**`) requires
> live Supabase access and cannot run in the sandboxed CI environment used for
> this branch ("Host not in allowlist"). It is unaffected by these changes.
