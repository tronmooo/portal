# Manual test script — post-mutation synchronization

These are the workflows the automated suite cannot cover: they need a real
browser, a real account and a real network. Run them against a deploy that has
migration `20260825_user_domain_versions.sql` applied.

**Open DevTools → Network, filter `/api/`, and keep it open for every test.**
Several checks are about what does *not* get requested.

Two things to watch throughout:

- **The frame test.** The change must be visible in the same frame the button
  stops spinning — not "quickly", not "after a beat". If you can see a number
  catch up, that is a failure.
- **The navigate test.** Navigating immediately after a write must show the new
  value, not the old one with a spinner over it.

---

## 1. Liability payment (the reference case)

**Setup.** Create a liability with a known balance — say a $10,000 auto loan at
6% APR, $400/month. Note the dashboard's Net Worth before you start.

**Act.** Open the liability, record a $400 payment.

**Verify immediately, without refreshing:**

| Where | Expected |
|---|---|
| Payment history | the $400 payment is listed |
| Remaining balance | $9,650 (a $50 interest / $350 principal split) |
| Liability card | the new balance |
| Owner's profile page → financial totals | reduced by $350 |
| Dashboard → Liabilities tile | reduced by $350 |
| Dashboard → Net Worth | increased by $350 |
| Recent activity | "Paid $400 — Car loan" |

**Then navigate to the dashboard immediately.** It must already show the new
numbers.

**In Network:** the `POST .../payments` response carries `X-Write-Manifest` and
`X-Data-Version`. Exactly one round of dependent GETs follows, and when they
land nothing on screen changes — they confirm what you can already see.

**What a failure looks like:** the balance drops but Net Worth holds its old
value for a second and then jumps. That means the tile is not deriving its
delta — check `useLiveTotal` is wired at that site.

---

## 2. Asset value change

Change an asset's value. Immediately verify: asset detail, the assets list, the
owner's profile, Total Assets, Net Worth, dashboard.

**Also:** reload the page right after. The new value must survive the reload —
the dashboard bootstrap payload is persisted to localStorage and seeds ~24
caches, and it used to seed the pre-write value back in.

---

## 3. Cross-profile

With profiles A and B:

1. Note A's totals, B's totals, and the Everyone totals.
2. Record a financial change on A.
3. **A's values change. B's do not. Everyone changes by the same amount as A.**

Switch the profile filter to B and back to A without refreshing; both must be
correct in both directions.

---

## 4. Edit, then delete

1. Record a payment. Edit its amount. Every dependent screen follows.
2. Delete it. It disappears from the history **and** the balance goes back up.
3. Navigate away and back. It stays deleted — a response already in flight when
   you deleted must not put it back (that is what the tombstones prevent).

---

## 5. AI chat vs manual

Record the same payment twice — once through the form, once by telling chat
"log a $400 payment on the car loan" — on two equivalent liabilities.

**The rows must match:** the same principal/interest split, the same remaining
balance, and the same three balance fields updated. Both must refresh the same
screens on the same timescale. This is the parity that used to fail: chat wrote
one of the three balance fields and did its own arithmetic.

**Also try a recurring bill** ("paid my phone bill"). It must log the charge and
advance the due date — not reduce a balance.

---

## 6. The narrowing (what phase 5 bought)

1. Load the Trackers page so its data is warm.
2. Go and record a liability payment.
3. Return to Trackers.

**It should come from cache — no spinner, no `/api/trackers` request.** Before
this change every write changed every cache key, so this navigation was a cold
recompute. This is the clearest single check that per-domain versions are on.

To confirm the flag works, set `PER_DOMAIN_VERSIONS=0` and repeat: Trackers goes
cold again. Set it back.

---

## 7. Two tabs

Open the app in two tabs. Write in tab A.

Tab B updates. **In tab B's Network panel there should be no `/api/stats` or
`/api/dashboard-enhanced` request while it is in the background** — background
tabs mark the aggregates stale rather than each racing to recompute them.

---

## 8. Clear cache

Settings → Clear cache. The button should finish when the data is actually back,
with no dead half-second and no stale flash.

---

## 9. Nothing got slower

Time a simple write (add an expense) before and after. The response should not
be slower — one version bump per write now instead of two, and the client no
longer waits for the refetches the write triggers.
