# LifeOS Task Plan — Dashboard Responsive + Calendar System

## Task 1: Dashboard Responsive Fix
- File: `client/src/pages/dashboard.tsx` (4238 lines)
- The outer wrapper is `<div className="h-full overflow-y-auto p-3 md:p-4 space-y-3">`
- Need to ensure NO horizontal overflow, NO horizontal dragging on mobile
- All grids need responsive breakpoints for mobile
- Two-column layout `<div className="grid md:grid-cols-2 gap-3">` stacks on mobile already
- Check all inner grids: `grid-cols-2`, `grid-cols-4`, etc.
- Dashboard header buttons may overflow on small screens — need wrapping
- All Card content should respect min-w-0 and overflow-hidden
- Remove calendar section from DEFAULT_SECTIONS array (move to standalone page)
- Remove CalendarView import from dashboard

## Task 2: Auto-generate Calendar Events
- When subscriptions/profiles with dates are created, auto-generate events
- When tasks with due dates are created, auto-generate events
- When obligations with nextDueDate are created, auto-generate events
- Backend: `server/supabase-storage.ts` and `server/ai-engine.ts` need hooks
- Subscription profiles have fields like `renewalDate`, `cost`, `plan`
- Person profiles have `birthday` field
- Medical profiles have `nextVisit` field
- Vehicle profiles have `nextService` field
- Loan profiles have `startDate`, `monthlyPayment` fields
- Tasks have `dueDate` field
- Obligations have `nextDueDate` and `frequency` fields

## Task 3: Dedicated Calendar Page
- Already exists at `client/src/pages/calendar-page.tsx` (197 lines) — but basic list view
- Already exists CalendarView component at `client/src/components/CalendarView.tsx` (1047 lines) — has month grid
- Need to add a Calendar button to the top-right header in App.tsx
- Route already NOT registered — need to add `/calendar` route in App.tsx
- Calendar page should aggregate ALL data sources into a unified timeline
- Should be fully interactive: click events to edit, click to create new
- The CalendarView already has create/edit dialogs and CRUD

## Key Architecture Notes
- Hash routing: `useHashLocation` from wouter
- Auth: Supabase JWT tokens
- Storage: `server/supabase-storage.ts`
- No localStorage (sandboxed iframe)
- Existing CalendarView already fetches `/api/calendar/timeline` for unified items
