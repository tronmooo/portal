# Dashboard Scoping & Data Isolation

**Status:** Authoritative contract. Every dashboard widget and filter must obey this.

## The one rule

| Scope | What it shows |
|---|---|
| **A profile is selected** (one or many) | **Personal dashboard** — only that selection's data, including per-person widgets. |
| **"Everyone"** | **Household dashboard** — a *distinct* aggregate layout. No per-person widgets. |
| **Default (first load)** | The **primary user** = the single `self` profile. Falls back to "Everyone" only if no `self` profile exists. |

> Profile filter → only that profile's data. Everyone → aggregate analytics. No mixed data, no exceptions.

## Why two different dashboards

Person-level concepts (habits, journal streaks, personal goals, personal budgets,
health trackers) are only meaningful for **one** individual. Summing or averaging
them across people produces nonsense ("household journal streak"). So the
aggregate view is a **different dashboard**, not a person dashboard with bigger
numbers.

## The three shapes

1. **Personal dashboard** — default (your `self`), or any single person/pet selected.
   Net-worth share, assets, liabilities, budgets, **habits, journal, trackers,
   health, goals**, tasks, calendar, personal insights. (The existing section grid.)

2. **Household dashboard** — the "Everyone" scope. `HouseholdDashboard` in
   `client/src/pages/dashboard.tsx`. Shows ONLY aggregate surfaces:
   - Combined net worth / total assets / total liabilities (`HeroKPISection`).
   - **Per-profile summary cards** with each person's net worth + asset/liability
     counts (`ProfileSummaryGrid`) — this is the profile summary **and** the
     asset/liability ownership breakdown. Click a card → that person's personal dashboard.
   - Household needs-attention + upcoming/shared bills + today's schedule.
   - Cross-profile AI insights + a recent-activity feed across everyone.
   - **Deliberately omits:** habits, journal, personal goals, personal budgets,
     health trackers, and the per-person KPI tiles.

3. **Multi-select (2+ profiles)** — renders the **personal** dashboard merged
   across the selected people (their habits/journal/goals combined). Per product
   decision: "more than one person but not Everyone" = merged personal view.

## Data isolation

- **Single source of truth for scope:** `passesProfileFilter()`
  (`shared/profile-filter.ts`) on the server (`/api/stats`,
  `/api/dashboard-enhanced`, `/api/insights`) and `computeNetWorth()`
  (`shared/net-worth.ts`) for net-worth math. The household per-profile cards
  reuse `computeNetWorth` so they agree with the personal dashboard to the dollar.
- **Default seeding:** `initDefaultProfileFilter()` (`client/src/lib/profileFilter.ts`)
  seeds the `self` profile on first load and is idempotent — it never overrides a
  user's explicit choice (including an explicit "Everyone").
- **No personal-widget leakage in aggregate is structural:** the household view
  simply does not render the personal components, so there is no path for a
  habit/journal/goal to appear in "Everyone".

## Invariants (regression targets)

- Fresh user with a `self` profile lands on the personal dashboard (not Everyone).
- "Everyone" renders `data-testid="household-dashboard"` and contains **no**
  habits / journal / personal-goals / health widgets.
- A record linked only to Jane never appears under Bob's scope, and no
  per-person record appears in "Everyone".
