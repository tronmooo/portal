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
auto-ownership hook previously ignored `parentProfileId` and force-linked every
new asset/liability to Self at 100%, which is what made one person's net worth
read `$0`. It now treats a non-Self parent chain as explicit ownership and links
the owning person (`resolveAutoOwner` in `shared/ownership.ts`).

There is exactly ONE auto-ownership writer: `storage.createProfile`
(`server/supabase-storage.ts`). Every create path — the REST `POST /api/profiles`
handler and the AI engine's many `storage.createProfile` calls — funnels through
it, so resolving the owner there covers them all. A second hook used to run in
the `POST /api/profiles` route on top of the storage one. With the storage hook
fixed to link the person, the two writers raced: the storage hook linked the
person at 100% and the route hook linked Self at 100%, so the asset briefly had
two 100% owners. The DB trigger `trg_asset_party_ownership_sum`
(`migrations/20260511_ownership_invariant.sql`) fires on insert when
`SUM(ownership_percentage) > 100` and equalizes the rows, turning 100/100 into
50/50 — which is why a filtered person showed half their net worth instead of
zero or the full amount. The route hook was removed so SUM stays 100 and the
trigger never rebalances. Existing wrong rows are not backfilled; only new
creates are correct.

## How this is guarded

- `tests/dashboard-card-consistency.test.ts` pins the `?? clientWalk`
  precedence so a future edit can't silently switch a surface back to `||` or
  back to a client walk.
- `tests/auto-ownership-hook.test.ts` pins `resolveAutoOwner`.
- `tests/e2e-dashboard-filters.test.ts` (run via `npm run test:e2e`) seeds a
  known three-person tree against production and asserts the snapshot
  partitions correctly per filter.

---

# Dashboard render contract (2026-07-25)

A second rule, about *how many times* a datum may appear, not which number it
shows:

> Every datum has exactly one owning block. A second mention is a *pointer* (a
> count, a streak chip), never a *copy* (a readable row).

## The eight blocks

| # | Block | Renders |
|---|---|---|
| 1 | **Pulse** | always — sticky strip: net worth, cash flow, wellness, streak |
| 2 | **Needs Attention** | hides at zero — the only red on screen |
| 3 | **Today** | always — merged timeline, progress bar, one synthesis line |
| 4 | **Next 14 Days** | always, collapsed to a count; expands on tap |
| 5 | **Money** | hides at zero — near-term only, not a Finance tab replacement |
| 6 | **Habits & Trackers** | hides at zero — streaks + one-tap logging |
| 7 | **Open Projects** | hides at zero |
| 8 | **Quick Capture** | always, last — capture is where the thumb already is |

Empty hide-at-zero blocks roll up into a single grey "All clear" line directly
above Quick Capture.

**Cut, not moved:** Notifications (the bell owns it), Recently Added (⌘K owns
it), the six-tile KPI grid (Pulse owns it), the standalone AI Executive Brief
(one line inside Today), Document Expirations as its own card.

## Where the rows come from

`client/src/components/dashboard/useBriefingModel.ts` is the single derivation.
It normalizes the queries into `BriefingItem`s keyed `${kind}:${id}`, then
assigns blocks by a **priority cascade**:

```
attention → today → next14 → money → habits → projects
```

Passes run in that order against one shared `push`, which refuses a key it has
already seen. An item therefore lands in its highest-priority block and cannot
appear in a second. This is the mechanism, not a convention — a new block
cannot reintroduce double-rendering without deliberately bypassing `push`.

Four consequences worth knowing before editing it:

- **Timeline `task` / `habit` / `obligation` rows are dropped on purpose.**
  `/api/tasks`, `/api/habits` and `financeSnapshot.upcomingBills` are
  authoritative and carry live state (completion, payment status); the timeline
  copies do not. Consuming both is what put bills in "Calendar · Next 14d" as
  well as "Bills & Obligations".
- **Bucket order is the product decision.** Moving a rule between passes moves
  the row between blocks; it never duplicates it.
- **Habits live in Today, not in Needs Attention.** The spec listed "habits due"
  under both. A habit is a routine, not something late, and block 2 is the only
  red on screen — filling it with unchecked habits every morning is the noise
  this redesign exists to remove. Today's progress bar needs them anyway.
- **Block 6's streak chips are aggregates, not rows.** They summarize the same
  habits block 3 lists, so they are computed from `habitRows` rather than
  `push`ed as items. Only trackers — a different entity — are pushed into the
  `habits` bucket. `tests/dashboard-dedup.test.ts` pins both halves.

Pulse's net worth reads `financeSnapshot.totalAssetValue` /
`totalLiabilities`, per the scope contract above. It must never re-walk
profiles to recompute them.

## Where popups come from

`client/src/components/dashboard/popups/` — one `PopupHost` mount point, one
`PanelRequest` atom mirrored into `?panel=&sub=&focus=`, and a `registry` of
dynamically imported panels. The invariants:

1. **Nothing mounts while closed.** `PopupHost` returns `null` without a
   request. A panel rendered with `open={cond}` instead is a regression —
   its hooks and queries then run on every dashboard render.
2. **No popup module is a static import of the dashboard.** All three live
   behind `import()` so they stay off the first-paint path.
3. **Reads never invalidate.** Panels seed from the briefing's cache via
   `useSeededList` (same query keys) and refetch in the background. Freshness
   is a *write-time* concern, handled by `invalidateDomain()`.
4. **Triggers prefetch on `pointerdown`,** which fires ~80–120 ms before the
   click resolves on touch.

Blocks 3 and 6 are the exception to "rows open panels": habit check-in and
tracker logging mutate optimistically in place, because one-tap logging that
opens a dialog first is not one tap.

## How this is guarded

- `tests/dashboard-dedup.test.ts` drives `buildBriefingModel` with fixtures and
  asserts no key is ever emitted twice, that block sizes sum to the model, and
  that both spec overlaps stay resolved.
- `tests/executive-sections.test.tsx` mounts the real component and asserts the
  render rules (always / hides-at-zero / collapsed) plus one DOM row per datum.
- `tests/dashboard-popup-perf.test.ts` pins the four structural invariants
  above at source level (they are not observable from a render test).
