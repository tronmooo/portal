# Dashboard Scoping & Data Isolation

**Status:** Authoritative contract. Every dashboard widget and filter must obey this.

## The one rule

| Scope | What it shows |
|---|---|
| **A profile is selected** (one or many) | **Section-grid dashboard** — only that selection's data. |
| **"Everyone"** | The **same section-grid dashboard** (Executive Daily Briefing etc.), aggregated across all profiles. |
| **Default (first load)** | The **primary user** = the single `self` profile. Falls back to "Everyone" only if no `self` profile exists. |

> Profile filter → only that profile's data. Everyone → the same layout with
> aggregate data. No mixed data, no exceptions.

## One layout, every scope (2026-07-09)

The "Everyone" scope used to render a *distinct* `HouseholdDashboard` layout
(Net Worth hero, Today's Schedule, AI Summary stack). Per user request that
component was removed: every scope, Everyone included, now goes through the
same section grid so the Executive tab shows the dense Daily Briefing layout
regardless of the profile filter. Scoping is purely a **data** concern:

1. **Selected (one or many profiles)** — every widget's queries pass
   `?profileIds=…` and show only that selection's data.

2. **Everyone** — the same widgets omit the `profileIds` param and the server
   returns aggregates across all profiles.

## Data isolation

- **Single source of truth for scope:** `passesProfileFilter()`
  (`shared/profile-filter.ts`) on the server (`/api/stats`,
  `/api/dashboard-enhanced`, `/api/insights`) and `computeNetWorth()`
  (`shared/net-worth.ts`) for net-worth math.
- **Default seeding:** `initDefaultProfileFilter()` (`client/src/lib/profileFilter.ts`)
  seeds the `self` profile on first load and is idempotent — it never overrides a
  user's explicit choice (including an explicit "Everyone").

## Invariants (regression targets)

- Fresh user with a `self` profile lands on their own scope (not Everyone).
- "Everyone" renders the same section grid as any other scope, with every
  widget's data aggregated across all profiles (no `profileIds` param).
- A record linked only to Jane never appears under Bob's scope.
