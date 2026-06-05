# Ownership Redesign — Architecture Review, Data Model, Calculation Audit & Plan

## 1. The bug, root-caused

An asset (e.g. **Home**) showed **"50% owned"** that the user never assigned.

Two independent mechanisms were fighting, and a database trigger invented the 50%:

1. **`asset_party_links`** — fractional ownership rows (`ownership_percentage`). This
   is what the dashboard/net-worth math reads.
2. **`profiles.fields.ownerProfileId` + `fields.countToward`** — a *separate*
   single-owner + "Owner's net worth vs Parent chain" toggle (the old
   `OwnerControl` card). The net-worth math does **not** read this, so it only
   ever added confusion.
3. **`parentProfileId`** — nesting/containment, which the math *also* consulted as
   an "inherited owner," producing phantom attributions.

**The 50% itself:** `migrations/20260511_ownership_invariant.sql` installed an
`AFTER INSERT/DELETE` trigger that, whenever the owner percentages for an asset
summed to **> 100**, **silently rewrote every owner to an even split**
(`floor(10000/N)/100`). Adding a second 100% owner → sum 200 → trigger →
**both set to 50%**. The user never chose 50%; the database did.

## 2. Decisions (confirmed with the user, 2026-06)

| Question | Decision |
|---|---|
| Unowned asset counts toward… | **Self ("Me") at 100%** |
| New asset default ownership | **Auto 100% to me** (editable) |
| Nesting vs ownership | **Decoupled** — nesting is *location only*; net worth uses ownership % exclusively |
| Default split | **Never 50%.** Ownership only exists when explicitly assigned; must total **exactly 100%** |

## 3. Target architecture — single source of truth

`shared/ownership-model.ts` is the ONE place ownership rules live. Server and
client both import it, so the rules can never drift.

```
resolveOwners(links, selfId)      → effective owners (explicit, else Self-100%)
shareForParty(party, links, self) → a party's % of one asset
shareForParties(ids, links, self) → combined % for a filter selection
validateOwnership(links)          → { valid, total, configured, errors }  (must total 100%)
distributeEvenly(n)               → suggestion only; never auto-applied
```

Rules encoded & unit-tested (`tests/ownership-model.test.ts`, 22 cases):
- Explicit owners win; with none, **Self owns 100%** (`implicit: true`).
- Nesting/`parentProfileId` is **never** consulted for net worth.
- A single explicit owner stays 100% — **"Me" is never silently made a 50% co-owner**.
- Non-owner roles (co-signer, guarantor, authorized user) are excluded from share math.

## 4. What has been implemented (this branch)

- **`shared/ownership-model.ts`** + **22 tests** — the source of truth. ✅
- **Server net-worth rewired** to the model, removing the parent-chain crediting
  and 4× duplicated share logic:
  - `getDashboardEnhanced` (dashboard popup + finance: `assetBreakdown`,
    `liabilityBreakdown`, `totalAssetValue`, `totalLiabilities`). ✅
  - `getProfileAssetValue` (chat / profile residual value). ✅
- **Atomic, validated write path** — `storage.setAssetOwners(assetId, owners[])`
  validates the full set totals 100% (or empty) and applies a **safe diff**
  (removals/decreases first, then increases/adds) so the per-asset sum never
  transiently exceeds 100. Exposed as **`PUT /api/profiles/:id/owners`**. ✅
- **Migration `20260605_ownership_no_autoequalize.sql`** — drops the
  auto-equalizing triggers and replaces them with a non-destructive guardrail
  that *rejects* (never rewrites) a sum > 100. Existing percentages are left
  untouched — the system will never silently change ownership again. ✅
- **`OwnershipEditor` component** (`client/src/components/OwnershipEditor.tsx`) —
  the new canonical control: per-owner **sliders + manual % inputs**, **live
  100% validation**, **"Split evenly"**, a clear **total badge / "Not set →
  counts toward you at 100%"** summary, **ownership history/audit trail**, and a
  single atomic save. The old `OwnerControl` (single-owner picker + "Counts
  toward / Parent chain" toggle + "Rollups credit Joe" banner) now delegates to
  it. ✅
- Removed the **hardcoded 50%** default in the liability co-owner editor (now
  defaults to the remaining share to reach 100%). ✅

Everything above passes `tsc`, the production build, and the unit tests.

## 5. To apply the fix to existing data

1. **Run the migration** `migrations/20260605_ownership_no_autoequalize.sql`
   against Supabase (it drops the auto-equalize trigger). *I can't run it from
   this sandbox — it needs DB access.*
2. **Re-assign the affected asset(s)** in the new Ownership editor (e.g. set Home
   to Joe 100%, or Joe 50 / Me 50 — whatever you intend). The old 50/50 rows are
   left as-is until you change them, so they won't silently "correct" to
   something else.

## 6. Remaining work (proposed next phases)

1. **Liability parity** — add `setLiabilityOwners` + `PUT /api/profiles/:id/liability-owners`
   and reuse `OwnershipEditor` on liability profiles (the model already supports it).
2. **Retire the legacy `fields.ownerProfileId` / `countToward`** fields entirely
   (data cleanup + remove any remaining readers) so there is exactly one
   ownership mechanism.
3. **AI writes** (`server/ai-engine.ts`) — route AI-created ownership through
   `setAssetOwners` so AI can't recreate sum>100 states.
4. **Reports/analytics/insights** — confirm they read `financeSnapshot` (already
   model-correct) rather than recomputing.
5. **Nesting UX** — relabel the "Ownership Tree" containment view as
   "Contained in / Location" to make decoupling explicit in the UI.

## 7. Blast radius reference (consumers of ownership)

Server: `getDashboardEnhanced`, `getProfileAssetValue` (both migrated),
`getProfileDetail` (co-owner children — display only), `ai-engine.ts` (writes — phase 3).
Client: `HeroKPIPopups` "% owned" badge (reads server `share` — now correct),
dashboard/finance net-worth (read `financeSnapshot` — now correct),
asset/liability detail ownership editors.
