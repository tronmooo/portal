# Portol App Changes Summary

## FILE 1: `client/src/components/CalendarView.tsx`
### Feature A: Agenda View
- Added `CalendarDays` to lucide-react imports
- Extended `viewMode` state type to include `"agenda"` (was `"month" | "week" | "day"`, now `"month" | "week" | "day" | "agenda"`)
- Added "Agenda" button to the view mode toggle switcher
- Added full agenda view rendering after the day view section:
  - Collects all events from `itemsByDate`, filters to upcoming (>= today), sorts chronologically
  - Groups by date string with sticky date headers
  - Shows up to 50 items with colored type indicators
  - Empty state shows CalendarDays icon with "No upcoming events"
  - Clicking an item opens the detail dialog

## FILE 2: `client/src/pages/profiles.tsx`
### Feature B: Profile Cover Banner (profiles list)
- Added `getProfileBanner()` helper function before `ProfileCard` component
  - Returns dark gradient strings based on profile type (self, person, pet, vehicle, asset, etc.)
- Replaced the subtle top gradient tint div with a visible `h-12` banner at the top of each profile card
  - Shows profile type label in small white text at bottom-right of banner

## FILE 3: `client/src/pages/profile-detail.tsx`
### Feature B: Profile Cover Banner (detail page)
- Added same `getProfileBanner()` helper function in the helpers section
- Replaced the hero header's `bg-gradient-to-b` Tailwind class with inline `style={{ background: getProfileBanner(profile?.type || '') }}`

### Feature C: Activity Feed Tab
- Added `{ value: "activity", label: "Activity", testId: "tab-activity" }` to `DEFAULT_TABS`
- Added `"activity"` case to `getTabsForType` data-driven filtering (checks relatedExpenses + relatedTasks + relatedEvents)
- Added `"activity"` to the `alwaysShow` list so empty tabs still appear
- Added Activity `TabsContent` rendering:
  - Collects items from `profile.relatedExpenses`, `profile.relatedTasks`, `profile.relatedEvents`
  - Sorts by date descending
  - Shows colored dots, title, subtitle, and date for each item
  - Empty state shows Activity icon with "No activity yet"

## FILE 4: `client/src/pages/settings.tsx`
### Feature D: Data Export
- Added "Export Your Data" card section between Data Management and Privacy & Security cards
- Two export buttons:
  - **Export as JSON**: Fetches all data (profiles, tasks, expenses, events, habits, goals) and downloads as JSON
  - **Export Expenses as CSV**: Fetches expenses and downloads as CSV with Date, Description, Amount, Category columns
- `Download` icon was already imported from lucide-react

## FILE 5: `client/src/pages/tasks.tsx`
### Feature E: Swipe-to-act on task lists
- Added `useRef` to React imports
- Added `SwipeableItem` component with touch gesture handling:
  - Tracks touch start/move/end with threshold-based activation (72px)
  - Shows colored background labels for left and right swipe actions
  - Smooth spring-back animation on release
- Wrapped active task items with `SwipeableItem`:
  - Swipe left → mark task as "done"
  - Swipe right → snooze (set due date to tomorrow)
- Wrapped completed task items with `SwipeableItem`:
  - Swipe left → reopen task (set status to "todo")
  - Custom label "↩ Reopen" with blue color
