# Dashboard scope contract

One rule governs every net-worth number the dashboard renders:

> The client reads roll-up totals (asset value, liabilities, net worth) from
> `financeSnapshot` returned by `GET /api/dashboard-enhanced`. It does NOT run
> its own walk over `allProfiles` to recompute them.

`/api/dashboard-enhanced` already filters by the active profile selection
(`?profileIds=a,b`) and computes `financeSnapshot.totalAssetValue` and
`financeSnapshot.totalLiabilities` with the full ownership model: direct
selection, `asset_party_links` / `liability_profile_links` co-ownership
percentages, and parent-residual share (a person gets `100% - claimed
co-owner %` of an item hung under them). That computation in
`server/supabase-storage.ts` (`getDashboardEnhanced`) is the single source of
truth. Do not change its math to make a surface agree; fix the surface to read
the snapshot.

## Why this exists

Filtering the dashboard to one person used to show the hero Net Worth tile at
`$0` while the Finance card and the Net Worth popup on the same screen showed
the real number. The three surfaces disagreed because each computed net worth a
different way. The hero already read the server snapshot; the others walked the
profile tree on the client with their own, narrower rules. When the underlying
`asset_party_links` data was wrong (see the auto-ownership fix below) the
server snapshot and the client walks diverged and the screen contradicted
itself.

## The five legacy "ownership" definitions, now collapsed

Before this contract, five competing definitions of "what does this person own"
ran in production at once:

1. Server `party_links` + parent residual — hero Net Worth tile, AI summary.
2. Client parent-only walk — bottom Finance card.
3. Client parent + co-owner walk — Net Worth popup.
4. Client parent-ancestor walk — Linked page liabilities chip.
5. Entity `linkedProfiles` list — events, tasks, expenses, obligations, docs.

Definitions 2, 3, and 4 are the net-worth walks that caused the visible drift.
They are now collapsed onto definition 1: every net-worth surface consumes
`financeSnapshot`.

- Bottom Finance card (`client/src/pages/dashboard.tsx`, `FinanceWidget`) reads
  `data.totalAssetValue` / `data.totalLiabilities` from the snapshot.
- Net Worth drill-down (`dashboard.tsx`) reads the same snapshot totals.
- Net Worth popup (`client/src/components/dashboard/HeroKPIPopups.tsx`,
  `NetWorthPopup`) fetches `/api/dashboard-enhanced` for the active filter and
  reads its snapshot totals.

Each of these keeps its former client walk only as a `?? clientWalk` fallback
for the brief window before the snapshot query resolves. The fallback uses `??`,
not `||`, so a legitimate snapshot value of `0` is never overridden by a stale
non-zero walk.

Definition 5 (`linkedProfiles`) is a separate system for per-entity scoping
(which expenses/tasks/events belong to a filter). It is unrelated to net worth
and is intentionally left as-is.

## Related fix: server-side ownership data

The contract only holds if the server snapshot has correct ownership data. The
auto-ownership hook in `server/routes.ts` (profile create) previously ignored
`parentProfileId` and force-linked every new asset/liability to Self at 100%,
which is what made one person's net worth read `$0`. It now treats a non-Self
parent chain as explicit ownership and links the owning person
(`resolveAutoOwner` in `shared/ownership.ts`). Existing wrong rows are not
backfilled; only new creates are correct.

## How this is guarded

- `tests/dashboard-card-consistency.test.ts` pins the `?? clientWalk`
  precedence so a future edit can't silently switch a surface back to `||` or
  back to a client walk.
- `tests/auto-ownership-hook.test.ts` pins `resolveAutoOwner`.
- `tests/e2e-dashboard-filters.test.ts` (run via `npm run test:e2e`) seeds a
  known three-person tree against production and asserts the snapshot
  partitions correctly per filter.
