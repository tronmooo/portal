# Dashboard Redesign Instructions

## Goal
Rewrite `/home/user/workspace/lifeos/client/src/pages/dashboard.tsx` to implement the new layout.

## Current File
The backup is at `client/src/pages/dashboard.tsx.backup` (1768 lines).

## Key Constraints
- NO localStorage (sessionStorage OK)
- Hash routing (`/#/path`)
- Use existing shadcn/ui components from `@/components/ui/`
- Use `apiRequest` from `@/lib/queryClient` for ALL API calls
- Use `@tanstack/react-query` for data fetching
- Keep the `MultiProfileFilter` component from `@/components/MultiProfileFilter`
- Keep the `getProfileFilter` / `setDashboardProfileFilter` from `@/lib/profileFilter`
- Keep all existing API endpoints (they work)
- Use lucide-react icons
- The dashboard has a Customize dialog that lets users show/hide/reorder sections — KEEP THIS
- The dashboard has an Import/Export feature — KEEP THIS
- On mobile, the 3 desktop action buttons collapse into a ⋮ overflow DropdownMenu — KEEP THIS

## New Layout (top to bottom)

### 1. HEADER (keep existing)
- "Dashboard" title + MultiProfileFilter + overflow menu (mobile) / buttons (desktop)

### 2. METRICS BAR (move to FIRST position)
- Full-width row of 6 compact stat tiles in a 3×2 grid on mobile, 6-col on desktop
- Each tile: bold value + small label, tappable to open detail popup
- Stats: Open Tasks, Monthly Spend (ACTUAL sum of expenses this month), Habits %, Journal Streak, Upcoming Bills, Expiring Docs
- Color: neutral by default, amber for warnings, red for critical only

### 3. TWO-COLUMN LAYOUT (below metrics)
On mobile: single column stacked. On desktop: 2-column grid.

**Left column:**

#### A. TODAY'S SCHEDULE
- Show today's calendar events in compact rows
- Time + title + location (if any)
- Max 5 events visible, "+N more" if more exist
- Empty state: "No events today"

#### B. HEALTH SNAPSHOT  
- 2×2 grid of the 4 most important health trackers
- Each tile: name, latest value with unit, 7-day sparkline
- Tappable to view full tracker

**Right column:**

#### C. ACTION REQUIRED (replaces Needs Attention)
- Show MAX 5 most urgent items (overdue first, then due-soon)
- Each item: colored left border (red=overdue, amber=due-soon), title, detail, action buttons
- Action buttons: ✓ Complete (tasks), 🕐 Snooze, × Dismiss
- Footer: "+N more items need attention" link that expands or opens full list in a Sheet/Dialog
- NO REDUNDANCY: items shown here are NOT shown in any other section

#### D. GOALS
- Show active goals with compact progress bars
- Each: title, target, progress %, deadline
- Tappable to update progress

### 4. BILLS SUMMARY (single column, below the 2-col grid)
- Summary header: "Monthly Total: $X" 
- Grouped by timeframe: "Due this week" / "Due in 2 weeks" / "Due this month"
- Each group shows total, items collapsed by default
- Click to expand individual bills

### 5. RECENT ACTIVITY (compact, at bottom)
- Max 5 entries, humanized text
- "4h ago: Logged weight 179 lbs" not "Logged Weight: 179"
- Grouped by time proximity

## Widget Rendering
Keep the existing `renderSection` pattern that maps section IDs to components.
Keep the `CustomizeDialog` for show/hide/reorder.
But change the DEFAULT section order to match the new layout:
```
["kpis", "today", "needs-attention", "health", "goals", "obligations", "activity"]
```

Remove "upcoming" section entirely (it was 100% redundant with needs-attention).
Remove "trends" section (empty/useless).

## Section IDs to Keep
- `kpis` → Metrics Bar
- `today` → Today's Schedule 
- `needs-attention` → Action Required (max 5 items)
- `health` → Health Snapshot
- `goals` → Goals
- `obligations` → Bills Summary
- `activity` → Recent Activity

## Section IDs to REMOVE
- `upcoming` → DELETE (redundant)
- `trends` → DELETE (empty)

## Important Existing Code to Preserve
1. `MultiProfileFilter` integration (filterIds, filterMode state)
2. `CustomizeDialog` component
3. `TasksPopup` component (popup for viewing all tasks)
4. All Dialog popups (Spending Breakdown, Bills, Tasks, Expiring Docs)
5. Export/Import functionality
6. `CollapsibleSection` component (simplified version)
7. `MiniStat` component (compact version)
8. `handleExport`, `handleImport` functions
9. The mobile overflow DropdownMenu
10. Query keys and API calls

## Detailed Component Specs

### CollapsibleSection (keep simplified)
```tsx
function CollapsibleSection({ icon, label, count, children, ...}) {
  // Already redesigned: borderless div, compact header button, tight padding
}
```

### ActionRequired (NEW — replaces NeedsAttentionSection)
- Show overdue tasks + overdue bills + due-today items
- Sort by urgency: overdue (oldest first) → due today → due this week
- CAP at 5 items displayed
- Each row: ~30px height, left color accent, title, detail, action buttons
- Footer: if totalCount > 5, show "+{totalCount - 5} more" button that opens a Sheet with the full list
- The Sheet should have all items scrollable

### HealthSnapshot (replaces HealthSection)
- 2×2 grid on mobile, 4-col on desktop
- Filter to the 4 most recently active health trackers
- Each tile: tracker name, latest value + unit, mini sparkline (use recharts AreaChart like the profile health tab does)
- Tap opens tracker detail dialog

### GoalsCompact (replaces GoalsSection)
- Vertical list of active goals
- Each: title (left), progress bar (middle, small), percentage + deadline (right)
- Tap opens edit dialog
- No duplicate goals (already cleaned in DB)

### BillsSummary (replaces ObligationsSection)
- Header shows total monthly obligations
- Group by urgency: "Overdue", "This Week", "This Month"
- Each group: summary line with total, expandable to show individual items
- Individual items: name + amount on one line

### ActivityFeed (replaces ActivitySection)
- Max 5 items
- Humanize: "Logged weight 179 lbs" not raw data
- Group consecutive entries: if 3 calorie logs in the same hour, show "Logged 3 calorie entries"
- Relative time: "4h ago", "Yesterday", etc.

## File Structure
The entire dashboard should be in a single file. Keep it under 1500 lines if possible.
Reuse existing component patterns from the current file.
