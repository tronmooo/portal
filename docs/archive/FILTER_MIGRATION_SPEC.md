# Universal Multi-Select Filter Migration Spec

## New Components Created
- `/client/src/lib/profileFilter.ts` — ALREADY UPDATED with multi-select support
- `/client/src/components/MultiProfileFilter.tsx` — ALREADY CREATED

## Backend Changes (ALREADY DONE)
- `/api/stats` accepts `?profileIds=id1,id2` (comma-separated)
- `/api/dashboard-enhanced` accepts `?profileIds=id1,id2`
- Storage methods updated with `filterProfileIds?: string[]` param

## Frontend Pages to Migrate

### 1. Dashboard (`client/src/pages/dashboard.tsx`)

**Current:** Single-select `<Select>` dropdown with "Me", "Everyone", and individual profiles.

**Change:**
- Remove the `<Select>` component and its imports (SelectTrigger, SelectValue, SelectContent, SelectItem)
- Import `{ MultiProfileFilter }` from `@/components/MultiProfileFilter`
- Import `{ getProfileFilter }` from `@/lib/profileFilter`
- Replace the profile filter state management:
  - Remove `const [profileFilter, setProfileFilter] = useState<string>(...)`
  - Remove `primaryProfiles`, `selectedProfileName`, `resolvedFilterId`, `statsProfileParam` useMemos
  - Remove the `useEffect` that syncs to `setDashboardProfileFilter`
  - Add: `const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);`
  - Add: `const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);`
  - Compute: `const statsProfileParam = filterIds.length > 0 ? '?profileIds=' + filterIds.join(',') : '';`
  - The `<MultiProfileFilter>` onChange callback: `({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }`
- Update query keys to use `filterIds` instead of `resolvedFilterId`
- Replace the `<Select>` JSX with: `<MultiProfileFilter onChange={({mode, selectedIds}) => { setFilterMode(mode); setFilterIds(selectedIds); }} compact />`
- Keep all the child components (NeedsAttentionSection, TasksSection, GoalsSection) working — they receive `profileId` prop. For multi-select, pass `profileIds={filterIds}` instead, OR keep passing single `profileId` for backward compat by joining with comma.
- Actually, the simplest approach: compute `resolvedFilterId` as undefined (everyone) when filterMode==="everyone", or pass profileIds param.

### 2. Trackers/Linked (`client/src/pages/trackers.tsx`)

**Current:** Has its own `<Select>` dropdown with "Me", "Everyone", individual profiles.

**Change:** Same pattern as Dashboard. Replace `<Select>` with `<MultiProfileFilter>`. The filtering logic already filters `relatedTrackers` by `resolvedFilter` — just update to check against an array of IDs instead of a single ID.

### 3. Calendar (`client/src/pages/calendar-page.tsx`)

**Current:** No profile filter at all.

**Change:** Add `<MultiProfileFilter>` in the header next to the title. Filter events by `linkedProfiles` matching any of the selected IDs. The events are already fetched, just filter client-side:
```tsx
const filteredEvents = filterMode === "everyone" ? events : events.filter(e => 
  (e.linkedProfiles || []).some(id => filterIds.includes(id)) || 
  (hasSelf && (e.linkedProfiles || []).length === 0)
);
```

### 4. Finance (`client/src/pages/finance.tsx`)

**Current:** Uses `getDashboardProfileFilter()` to read the shared single-select filter.

**Change:** Add `<MultiProfileFilter>` in the header. Filter expenses client-side using the same linkedProfiles pattern.

### 5. Tasks (`client/src/pages/tasks.tsx`)

**Current:** Uses `getDashboardProfileFilter()` to read the shared single-select filter.

**Change:** Add `<MultiProfileFilter>` in the header. Filter tasks client-side.

### 6. Document Detail (`client/src/pages/document-detail.tsx`)

**Current:** Has a "Link to Profile" section where you can add/remove profile links.

**Change:** Keep the existing linking UI (checkboxes for which profiles a doc belongs to). This is ALREADY multi-select. No filter dropdown needed here — the profile linking is the filter mechanism for documents.

## Pet Health Tab Fix (`client/src/pages/profile-detail.tsx`)

### Issues from Screenshot:
1. "QUICK LOG" section should not appear — remove it entirely from the Health tab
2. "Link Existing" and "+ New Tracker" buttons should be removed from the Health tab (they clutter the view — tracker management belongs on the main Trackers page)
3. The "running" tracker shouldn't appear on a pet's health tab (it's a custom category, not health)

### Fix:
In the `HealthTabView` function (line ~2751):
1. DELETE the entire "Section 4: Quick Log" block (lines ~3019-3058)
2. DELETE the `quickLogNames`, `quickLogTrackers`, `quickLogOpen`, `quickLogValue` state and logic
3. REMOVE the "Link Existing" and "+ New Tracker" buttons
4. Keep the expandable tracker cards with their inline "Log Entry" forms (those are fine)
5. In the empty state, keep the QuickHealthButton buttons to create initial trackers (Weight, BP, etc.) — those are fine as one-time setup buttons

## IMPORTANT RULES
- NO localStorage — sessionStorage is OK for filter persistence
- Hash routing mandatory (`/#/path`)
- All data must come from Supabase, never fabricated
- The filter component is already built at `client/src/components/MultiProfileFilter.tsx`
- The profileFilter.ts module is already updated at `client/src/lib/profileFilter.ts`
