# Full App Testing Checklist

A complete, button-by-button / page-by-page QA checklist for the Portal app.
Work through each category. For every item verify: it renders, it does what it
says, it shows correct loading/empty/error states, and it persists after refresh.

Legend: `[ ]` not tested · `[~]` partial / has issue · `[x]` passes

---

## 0. Test setup & environment

- [ ] App builds cleanly (`npm run build`)
- [ ] Type check passes (`npm run check`)
- [ ] Unit tests pass (`npm test`)
- [ ] Dev server starts (`npm run dev`) with no console errors on load
- [ ] App works in both light and dark mode
- [ ] App works at desktop, tablet, and mobile widths
- [ ] App works after a hard refresh on every route (deep-linking works)
- [ ] No uncaught errors in browser console during a full walkthrough
- [ ] Test as a brand-new (empty) account AND an account with lots of data

---

## 1. Authentication & Account

### Sign in / Sign up (`/` redirect → auth page)
- [ ] Sign In tab: email + password → success routes into app
- [ ] Sign In with wrong password shows clear error (`text-auth-error`)
- [ ] Sign Up tab: email + password + confirm
- [ ] Sign Up password/confirm mismatch is blocked with message
- [ ] Sign Up with already-registered email shows correct error
- [ ] "Sign in with Google" OAuth flow completes and returns to app
- [ ] "Forgot password" link → email input → submit shows confirmation
- [ ] Password reset email link opens `/reset-password` and lets you set a new password
- [ ] Reset password with mismatched fields is blocked
- [ ] After reset, old password no longer works, new one does
- [ ] "Back to sign in" links work from forgot/signup views
- [ ] Session persists across refresh (stay logged in)
- [ ] JWT is attached to API requests (no 401s while logged in)
- [ ] Expired/invalid token redirects to auth instead of silent failure
- [ ] Sign out (from Settings and sidebar) clears session and returns to auth
- [ ] Protected routes redirect to auth when logged out

---

## 2. Global shell & navigation

### Sidebar (desktop) — `app-sidebar`
- [ ] Each item navigates correctly: Chat `/`, Dashboard `/dashboard`, Linked `/linked`, Calendar `/calendar`, Artifacts `/artifacts`
- [ ] Active item is visually highlighted on the matching route
- [ ] Sidebar collapse/expand toggle (`SidebarTrigger`) works and persists
- [ ] Sidebar accent colors render per item

### Mobile bottom nav — `mobile-nav`
- [ ] Shows on small screens, hidden on desktop
- [ ] Same 5 destinations navigate correctly
- [ ] Active state highlights correctly
- [ ] Doesn't overlap page content / safe-area handled

### Top bar
- [ ] Theme toggle (`button-theme-toggle`) switches light/dark and persists
- [ ] Calendar quick button navigates to `/calendar`
- [ ] Settings entry navigates to `/settings`
- [ ] Notification bell opens notifications (see §17)
- [ ] Command search trigger opens command palette (see §16)
- [ ] User dropdown menu opens; sign-out works

### Routing edge cases
- [ ] Unknown URL renders Not Found page (`not-found`) with working "go home"
- [ ] Hash-based navigation works (back/forward browser buttons)
- [ ] Aliased routes resolve: `/bills`→obligations, `/health`→trackers, `/linked`→trackers, `/dashboard/finance|habits|journal|obligations|tasks`
- [ ] Lazy-loaded pages show loader, then render (no permanent spinner)
- [ ] Error boundary catches a thrown page error without white-screening the whole app

---

## 3. Chat / AI (`/`)

- [ ] Type a message and Send (`button-send`) → assistant responds
- [ ] Enter-to-send and Shift+Enter newline behave correctly
- [ ] Empty message can't be sent
- [ ] Voice input button (`button-voice-input`) requests mic and transcribes
- [ ] Attach file (`button-attach`) → file appears as attachment chip
- [ ] Camera capture (`button-camera`/`input-camera`) works on mobile
- [ ] Remove attachment (`button-remove-attachment`) clears it
- [ ] Add more files (`button-add-more-files`) appends without losing existing
- [ ] Send with attachment (`button-send-attachment`) uploads + responds
- [ ] Batch upload: select profile per item / global profile, "Upload all"
- [ ] "Save only" (`button-save-only`) stores files without AI processing
- [ ] Smart-fill PDF (`button-smart-fill-pdf`) triggers smart-fill flow (see §21)
- [ ] New doc / New sheet buttons create artifacts and open editor
- [ ] Chat search (`button-chat-search` + `input-chat-search`) filters history
- [ ] Reset chat (`button-reset-chat`) clears the conversation (with confirm)
- [ ] AI extraction confirmation flow: review extracted data → confirm/cancel writes to the right entities
- [ ] Long responses scroll; auto-scroll to newest message
- [ ] Network failure mid-response shows an error, not a frozen UI
- [ ] AI actions that create records (tasks, expenses, profiles, etc.) actually persist and appear on their pages

---

## 4. Dashboard (`/dashboard`)

- [ ] KPIs / hero cards load with real numbers (not perpetual skeletons)
- [ ] Hero KPI popups (`HeroKPIPopups`) open with drill-down detail
- [ ] AI summary card loads; refresh button (`button-refresh-ai-summary`) regenerates
- [ ] AI suggestions render and are actionable
- [ ] Quick task input (`input-quick-task`) adds a task that shows on Tasks page
- [ ] Goal quick-create (title/target/unit/deadline/progress inputs) saves a goal
- [ ] Each dashboard widget links to its full page
- [ ] Empty-account dashboard shows sensible empty states, not errors
- [ ] Numbers match the underlying pages (finance totals, task counts, etc.)

---

## 5. Profiles (`/profiles`, detail `/profiles/:id`)

### List
- [ ] Profiles list loads; search (`input-search-profiles`) filters
- [ ] Empty state "Add profile" (`button-add-profile-empty`) opens create flow
- [ ] Profile type selector (`ProfileTypeSelector`) shows available types
- [ ] Create profile: name, tags, type-specific dynamic fields save correctly
- [ ] Dynamic form (`DynamicProfileForm`) renders correct fields per type (person, pet, vehicle, account, subscription, loan, etc. — verify each `input-field-*`)
- [ ] Created profile appears in list and opens detail

### Detail (very interaction-heavy — 300+ testids)
- [ ] All tabs/sections render (overview, documents, linked items, AI summary, tree)
- [ ] Edit each field type and save → persists after refresh
- [ ] AI summary (`/profiles/:id/ai-summary`) loads and refreshes
- [ ] Relationships / tree view (`/profiles/:id/tree`) renders
- [ ] Link / unlink other profiles (`/link`, `/unlink`) updates both sides
- [ ] Find value / lookup value features return results
- [ ] Attach documents to profile; they appear under documents tab
- [ ] Delete profile (with confirm) removes it and cleans up links
- [ ] Shared tabs component (`ProfileSharedTabs`) behaves consistently

---

## 6. Trackers / Linked (`/trackers`, `/linked`, `/health`)

### List & create
- [ ] Tracker list loads; create menu (`button-create-menu`) opens
- [ ] Create tracker (name, unit, category, goal target) → saves
- [ ] Create from empty state (`button-create-tracker-empty`) works
- [ ] Create asset (`button-create-asset`) and create liability (`button-create-liability`) flows
- [ ] Cancel / submit buttons behave (`button-create-cancel`/`button-create-submit`)
- [ ] Filter and clear filter (`button-clear-filter`) work

### Tracker detail
- [ ] Add entry (`button-add-entry-detail`) with value/date → appears in list & chart
- [ ] Edit entry (inline / `trackers/:id/entries/:entryId` PATCH) saves
- [ ] Delete entry (confirm/cancel) removes it
- [ ] Add field (`button-add-field`) adds custom field
- [ ] Rename tracker (`button-rename-tracker-detail`) persists
- [ ] Delete tracker (confirm/cancel) removes it
- [ ] Goal progress bar reflects entries vs target
- [ ] Upload document to tracker (`button-upload-document-global` + profile select)
- [ ] Document search (`input-search-documents-global`) filters
- [ ] Smart entry (`/trackers/smart-entry`) parses natural language input
- [ ] Chart/visualization renders for numeric trackers

---

## 7. Finance (`/finance`, `/dashboard/finance`)

### Income
- [ ] Add income (`button-add-income`): amount, date, description, category, frequency → saves
- [ ] Edit income (`button-save-edit-income`) updates
- [ ] Delete income removes it
- [ ] Recurring frequency creates correct projections
### Expenses
- [ ] Add expense (`button-add-expense`): amount, description, vendor, category, profile
- [ ] Save expense persists; appears in list
- [ ] Category filter (`select-category-filter`) filters list
- [ ] Delete expense works
### Paychecks
- [ ] Add paycheck (`button-add-paycheck`): amount, date, source
- [ ] Confirm paycheck (`/paychecks/:id/confirm`) updates status
- [ ] Delete paycheck works
### Cashflow
- [ ] Add cashflow (`button-add-cashflow`): month/week, projected vs actual income/expenses
- [ ] Save cashflow persists; cashflow view/`/api/cashflow` reflects it
### Totals & integrity
- [ ] Totals/summaries recompute correctly after each add/edit/delete
- [ ] Negative / zero / very large amounts handled
- [ ] Currency formatting consistent
- [ ] Bank CSV import (`/import/bank-csv`) maps columns and creates transactions

---

## 8. Tasks (`/tasks`, `/dashboard/tasks`)

- [ ] New task (`button-new-task`): title, description, due date, priority, profile, tags
- [ ] Submit task (`button-submit-task`) saves and shows in list
- [ ] Toggle complete updates status (and dashboard count)
- [ ] Edit task persists
- [ ] Delete task (`button-confirm-delete-task`) removes it
- [ ] Restore task (`/tasks/:id/restore`) brings it back
- [ ] Filter/sort by priority, due date, profile, completion
- [ ] Overdue tasks visually flagged
- [ ] Empty state renders

---

## 9. Habits (`/habits`, `/dashboard/habits`)

- [ ] Create habit (`button-create-habit` / empty-state variant): name, profile
- [ ] Save habit (`button-save-habit`) persists
- [ ] Daily check-in (`/habits/:id/checkin`) marks done; streak increments
- [ ] Delete a check-in (`/habits/:id/checkin/:checkinId`) reverts streak
- [ ] Edit habit persists; restore (`/habits/:id/restore`) works
- [ ] Delete habit removes it
- [ ] Streak / calendar visualization is accurate across day boundaries

---

## 10. Journal (`/journal`, `/dashboard/journal`)

- [ ] New journal entry (`button-new-journal`)
- [ ] Fields save (affirmation, "make it amazing", profile, body)
- [ ] Save journal (`button-save-journal`) persists; appears in list
- [ ] Edit existing entry updates
- [ ] Delete entry removes it
- [ ] Date handling correct; entries ordered chronologically

---

## 11. Obligations / Bills (`/obligations`, `/bills`, `/dashboard/obligations`)

- [ ] Obligations list loads (`ObligationsManager`)
- [ ] Create obligation (recurring bill) saves
- [ ] Occurrences generate (`/obligation-occurrences`, `/obligations/:id/materialize`)
- [ ] Mark occurrence status (`/obligation-occurrences/:occId/status`)
- [ ] Reschedule occurrence (`/obligation-occurrences/:occId/reschedule`)
- [ ] Pay obligation (`/obligations/:id/pay`) records payment
- [ ] Edit / delete obligation works
- [ ] "Go to calendar" link (`link-go-to-calendar-tab`) navigates correctly
- [ ] Upcoming/overdue bills surface on dashboard and calendar

---

## 12. Calendar & Google Calendar sync (`/calendar`)

- [ ] Calendar renders current month/week (`CalendarView`)
- [ ] Tab switch Calendar ↔ Obligations (`tab-calendar`/`tab-obligations`)
- [ ] Events from `/api/events` show on correct days
- [ ] Create event; edit event; delete event persist
- [ ] Timeline view (`/api/calendar/timeline`) renders
- [ ] Obligations/bills appear on their due dates
- [ ] Google Calendar connect flow (`button-gcal-sync` in Settings) authorizes
- [ ] Sync status (`/calendar/sync-status`, `/calendar/status`) reflects connected state
- [ ] Manual sync (`/calendar/sync`) pulls/pushes events
- [ ] Export single event/item to GCal (`/calendar/export/:id`)
- [ ] "Not connected" badge (`badge-gcal-not-connected`) shows when disconnected
- [ ] Calendar manager panel (`CalendarManagerPanel`) actions work

---

## 13. Artifacts & Documents (`/artifacts`, `/documents/:id`)

- [ ] Artifacts list loads; search (`input-artifacts-search`) filters
- [ ] Open a document → detail page renders (`DocumentViewer`)
- [ ] Open a sheet/spreadsheet → renders (`UniverSheet`)
- [ ] Create new document and new sheet from chat or artifacts
- [ ] Duplicate artifact (`/artifacts/:id/duplicate`)
- [ ] Toggle item (`/artifacts/:id/toggle/:itemId`) for checklist-type artifacts
- [ ] Document detail: add field (`input-new-field-key`/`value`) saves
- [ ] Edit document metadata (PATCH `/documents/:id`)
- [ ] Download / view file (`/documents/:id/file`) returns the right file
- [ ] Send document by email (`/documents/:id/send-email`)
- [ ] Delete document / artifact removes it
- [ ] Link documents to profiles/trackers (`DocumentLinkPicker`) works
- [ ] Large file and unsupported file type handled gracefully

---

## 14. Editor — docs & sheets (`/editor/:id`, `/editor/new/:type`)

### Document mode
- [ ] Title edit (`input-editor-title`) saves
- [ ] Formatting buttons each work: bold, italic, underline, code, H1, H2, bullet list, ordered list, link
- [ ] Link button prompts for URL and inserts a working link
- [ ] Save (`button-editor-save`) persists; reload shows saved content
- [ ] Autosave (if present) doesn't lose edits
### Sheet mode
- [ ] Formula bar (`input-formula-bar`) edits cells; formulas compute
- [ ] Insert chart (`button-sheet-insert-chart`): title, range → creates chart
- [ ] Chart save (`button-chart-save`) persists
### Shared editor actions
- [ ] Back (`button-editor-back`) returns without losing saved work
- [ ] Duplicate (`button-editor-duplicate`)
- [ ] Download (`button-editor-download`) exports correct format
- [ ] Print (`button-editor-print`) opens print view
- [ ] Template (`button-editor-template`) applies a template
- [ ] Delete (`button-editor-delete`) with confirm
- [ ] Links sidebar toggle (`button-toggle-links-sidebar`) shows linked entities
### Sharing (see also §19)
- [ ] Enable share (`button-share-enable`) creates a public link
- [ ] Copy share URL (`button-share-copy`)
- [ ] Revoke share (`button-share-revoke`) disables the public link immediately

---

## 15. Insights & Weekly review (`/insights`)

- [ ] Insights load (`/api/insights`, `insights-engine`)
- [ ] Anomalies (`/api/anomalies`) surface unusual activity
- [ ] AI digest (`/api/ai-digest`) renders
- [ ] Generate weekly review (`button-generate-review`, `/weekly-review/generate`)
- [ ] Scan receipt (`button-scan-receipt` + `input-receipt-file`) → extracts → save expense (`button-save-expense`)
- [ ] Stale valuations / cashflow / loan schedules show where relevant
- [ ] Cron weekly review endpoint works (`/api/cron/weekly-review`)

---

## 16. Search

- [ ] Command palette opens (keyboard shortcut + trigger button)
- [ ] Typing filters across pages/entities (`/api/search`)
- [ ] Selecting a result navigates to it
- [ ] AI search (`/api/search/ai`) returns relevant results
- [ ] Esc / click-outside closes palette
- [ ] No results state renders

---

## 17. Notifications

- [ ] Bell shows unread count (`NotificationBell`, `/api/notifications`)
- [ ] Opening shows list; items link to their source
- [ ] Mark read / clear works
- [ ] New events (due bills, reminders) generate notifications

---

## 18. Sharing & public views (`/share/:token`)

- [ ] Public share page loads for a valid token without login
- [ ] Public artifact endpoint (`/api/public/artifacts/:token`) returns data
- [ ] Revoked / invalid token shows a proper "not available" page (not a crash)
- [ ] Shared view is read-only (no edit/delete leaks)
- [ ] Share create/delete (`/artifacts/:id/share`) toggles access correctly

---

## 19. Settings (`/settings`)

- [ ] Account card shows correct user email (`text-user-email`)
- [ ] Change password (`button-change-password` → current/new/confirm → `button-save-password`)
- [ ] Wrong current password is rejected
- [ ] Appearance: theme + hue slider (`hue-slider`) updates app accent live and persists
- [ ] Notifications toggles persist (`/api/preferences/:key`)
- [ ] AI settings card options persist
- [ ] Privacy card links to `/privacy` and `/terms`
- [ ] Integrations: Google Calendar connect/disconnect (see §12)
- [ ] Data → Export (`button-export`, `/api/export`) downloads full data
- [ ] Data → Import (`button-import` + `input-import-file`, `/api/import`) restores data
- [ ] CSV import (`button-csv-import` + `input-csv-file`)
- [ ] Clear cache (`button-clear-cache`) clears local state safely
- [ ] Delete all data (`button-delete-data` + typed confirm `input-delete-confirm`, `/api/data/all`) — destructive, requires confirmation
- [ ] Sign out (`button-signout-settings` → confirm/cancel)
- [ ] Back button (`button-back`) returns to previous page

---

## 20. Data: import / export / migration / integrity

- [ ] Export → Import round-trip preserves all entities and links
- [ ] Audit log (`/api/audit-log`) records create/update/delete
- [ ] Activity feed (`/api/activity`) reflects recent actions
- [ ] Stats (`/api/stats`) accurate
- [ ] Cleanup endpoints behave (`/cleanup/tracker-entries`, `/cleanup/migrate-documents-to-storage`)
- [ ] Entity links (`/api/entity-links`) create/delete and related lookups work
- [ ] Asset↔party, liability↔asset, liability↔profile links create/edit/delete correctly
- [ ] Deleting a parent cleans up or safely orphans its links (no dangling references)

---

## 21. Smart Fill / Receipt extraction / Uploads

- [ ] Smart-fill analyze (`/smart-fill/analyze`) reads a PDF/doc and proposes fields
- [ ] Smart-fill render (`/smart-fill/render`) produces filled output
- [ ] SmartFillDialog/Trigger UI flows work end to end
- [ ] Receipt extract (`/receipt-extract`) parses amount/vendor/date
- [ ] Single upload (`/upload`), batch (`/upload/batch`), save-only (`/upload/save-only`)
- [ ] Upload progress + error handling (oversized, wrong type, network drop)
- [ ] Uploaded files retrievable and linked to the chosen profile

---

## 22. PWA / Offline / Mobile

- [ ] Install prompt (`InstallPrompt`) appears and installs the PWA
- [ ] Offline indicator (`OfflineIndicator`) shows when network drops
- [ ] App shell loads offline; queued actions sync on reconnect (if supported)
- [ ] Capacitor iOS build: status bar, splash screen, keyboard behave
- [ ] Camera / file pickers work on mobile
- [ ] Touch targets large enough; no horizontal scroll
- [ ] Keyboard shortcuts (`KeyboardShortcuts`) work on desktop and don't fire on mobile

---

## 23. Cross-cutting quality

### Loading & empty & error states
- [ ] Every list/page has a skeleton/loader, an empty state, and an error state
- [ ] Failed API calls show a toast/message and allow retry
- [ ] No infinite spinners; no flash of empty content that should have data

### Forms & validation
- [ ] Required fields enforced; invalid input shows inline errors
- [ ] Submitting disables the button / prevents double-submit
- [ ] Cancel discards changes; unsaved-changes guard where relevant
- [ ] Dates, numbers, currency, email validated consistently

### Security
- [ ] All `/api/*` (except public/share) require auth and reject without token
- [ ] A user cannot read/modify another user's data (row-level isolation)
- [ ] Share tokens grant read-only access only
- [ ] Security headers present (`security-headers.ts`)
- [ ] No secrets/keys leaked to the client bundle
- [ ] File uploads validate type/size; no path traversal

### Performance
- [ ] Lazy-loaded pages load quickly; bundles reasonable
- [ ] Large lists (many profiles/expenses/entries) stay responsive
- [ ] No obvious memory leaks navigating between pages repeatedly

### Accessibility
- [ ] All interactive elements keyboard-reachable and focus-visible
- [ ] Buttons/inputs have labels/aria where needed
- [ ] Color contrast adequate in both themes
- [ ] Dialogs trap focus and close on Esc

### Error reporting
- [ ] Error boundary + Sentry (`sentry.ts`, `errorReporter`) capture crashes
- [ ] A thrown error in one section doesn't take down the whole app (`SectionErrorBoundary`)

---

## 24. API endpoint smoke coverage

Hit each endpoint group at least once (auth'd) and confirm 2xx + correct shape.
Verify create→read→update→delete cycles for the entity families below:

- [ ] profiles, profile-types, profile detail/tree/ai-summary/find-value
- [ ] trackers + entries (+ smart-entry, migrate-to-self)
- [ ] tasks (+ restore)
- [ ] habits (+ checkin, restore)
- [ ] journal
- [ ] expenses, incomes, paychecks, budgets, cashflow
- [ ] obligations (+ occurrences, materialize, pay)
- [ ] events / calendar (status, sync, timeline, export)
- [ ] documents (+ file, send-email), artifacts (+ share, duplicate, toggle)
- [ ] goals
- [ ] memories (+ recall)
- [ ] assets/liabilities/parties links + ownership-history + loans schedule
- [ ] chat, chat-artifacts, ai-transform, ai/summary, receipt-extract, smart-fill
- [ ] search, search/ai, insights, anomalies, ai-digest, weekly-review
- [ ] notifications, activity, audit-log, stats, dashboard-enhanced
- [ ] preferences (get/put), onboarding status/complete
- [ ] export, import, import/bank-csv, data/all (delete)
- [ ] version, warmup (health checks return ok)

---

## 25. First-run / onboarding

- [ ] Onboarding wizard (`OnboardingWizard`) shows for a new account
- [ ] Onboarding status (`/api/onboarding-status`) reflects progress
- [ ] Complete onboarding (`/api/onboarding/complete`) and it doesn't reappear
- [ ] Quick-create FAB (`QuickCreateFab`) opens and creates each entity type
- [ ] Skipping onboarding still leaves the app fully usable
