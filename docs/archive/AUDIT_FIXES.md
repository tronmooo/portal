# Portol Audit Fix Plan

## ROOT CAUSES ALREADY FIXED
1. **storage.ts** — `require()` fails in ESM mode → replaced with static import for SupabaseStorage
2. **ai-engine.ts** — Anthropic client created at module-load before dotenv runs → lazy-init with getClient()

## REMAINING FIXES NEEDED

### Quick Actions (dashboard.tsx ~line 4084-4300)
- Add toast error messages when validation fails (instead of silent `return`)
- Weight: show "Enter a weight between 0.1 and 1500 lbs" toast on invalid
- Expense: show "Amount and description required" toast on invalid
- Task: show "Enter a task title" toast on invalid
- Journal: show "Write something first" toast on invalid

### Tracker CRUD (trackers.tsx)
- Create tracker: require non-empty name (show error if empty)
- Add field: require non-empty label
- Delete entry: verify the trash button actually works (check onClick handler)
- Negative values: add min="0" to numeric inputs, reject negative on submit
- Unrealistic values: add max bounds per tracker type
- Zero values: allow zero for some (like BP readings) but not for weight/sleep

### Goals (dashboard.tsx goals section)
- Prevent empty title
- Prevent target ≤ 0
- Prevent negative targets
- Cap progress at target (or allow overshoot with visual indicator)
- Reject negative progress
- Refresh UI after progress update

### Journal (journal.tsx)
- Require mood or content before save
- Add edit button to existing entries
- Add delete button with confirmation
- Show error toast on save failure

### Habits (habits.tsx)
- Remove "Custom" from frequency options (or implement it)
- Add delete confirmation dialog
- Require name before creation

### Settings (settings.tsx)
- Fix dark mode toggle (check ThemeProvider)
- Fix export data — check the endpoint and download logic
- Add error feedback for failed operations

### Profile Validation (profiles.tsx create/edit dialog)
- Email format validation
- Phone: numeric-only or formatted input
- Date: validate month/day combos (no Feb 30)
- Blood type: dropdown with valid options only

### Server-side Validation (routes.ts)
- Add server-side validation for all POST/PUT endpoints
- Reject negative amounts, empty required fields
- Return proper error messages
