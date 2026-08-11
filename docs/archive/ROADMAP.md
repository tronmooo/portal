# LifeOS — Full Roadmap

> 10 major improvements, organized into 5 phases.  
> Each phase builds on the last. Estimated per-phase effort in parentheses.

---

## Phase 1: Foundation — Data That Survives (Session 1)

Everything else depends on this. No point building features on top of disappearing data.

### 1A. Persistent Database (SQLite via Drizzle ORM)
- **What:** Replace in-memory Maps in `storage.ts` with SQLite using the Drizzle ORM already in `package.json`
- **Why:** Currently all data (profiles, documents, trackers, expenses, events, habits, tasks, journal, obligations, artifacts, memories) vanishes on server restart
- **How:**
  - Create Drizzle schema tables in `shared/schema.ts` for all 12+ entity types
  - Add `drizzle-kit` migrations
  - Rewrite `MemStorage` class → `SqliteStorage` class implementing the same `IStorage` interface
  - Seed data migrated from current hardcoded samples
  - All existing API routes stay the same — only the storage layer changes
- **Files touched:** `shared/schema.ts`, `server/storage.ts`, `drizzle.config.ts`, new `migrations/` folder
- **Risk:** Schema design must handle the flexible `fields: Record<string, any>` on Profiles and `extractedData` on Documents — use JSON columns

### 1B. Data Export / Import / Backup
- **What:** `/api/export` returns full JSON dump of all data; `/api/import` restores from a JSON file
- **Why:** Safety net. User can download their life data anytime, restore it anywhere
- **How:**
  - `GET /api/export` → iterate all storage methods, return `{ profiles: [...], trackers: [...], ... }`
  - `POST /api/import` → validate JSON shape with Zod, clear + re-insert all entities
  - Dashboard settings gear icon → "Export Data" / "Import Data" buttons
- **Files touched:** `server/routes.ts`, `dashboard.tsx` (settings dialog)

---

## Phase 2: See Your Data — Visualizations & Search (Session 2)

### 2A. Tracker Visualizations & Charts
- **What:** Line charts, trend graphs, and sparklines for all trackers
- **Why:** 5 trackers with entries but zero visual output. Tracking without visualization is just data entry.
- **How:**
  - Recharts (already installed) for full charts on Trackers page
  - Each tracker detail view: line chart of entries over time, min/max/avg stats, goal line if set
  - Dashboard Health Snapshot: add mini sparklines next to each metric
  - Weight tracker: BMI trend overlay
  - Blood Pressure: systolic/diastolic dual line with normal range shading
  - Sleep: bar chart by day with 7-8hr target zone
  - Running: cumulative distance, pace trend
- **Files touched:** `trackers.tsx` (major rewrite), `dashboard.tsx` (sparklines in HealthSnapshot)

### 2B. Global Search
- **What:** Command-palette style search (Cmd+K) that searches across ALL entities
- **Why:** "Type Tesla, see everything" — profile, loan, expenses, insurance doc, events
- **How:**
  - `GET /api/search?q=tesla` → backend fuzzy searches all entity types by name/title/tags/fields
  - Frontend: `cmdk` component (already in dependencies!) as a Cmd+K dialog
  - Results grouped by type: Profiles, Documents, Tasks, Expenses, Trackers, Events, Journal
  - Click a result → navigate to it (profile detail, document viewer, etc.)
  - Recent searches saved in React state
- **Files touched:** `server/routes.ts` (new endpoint), new `client/src/components/CommandSearch.tsx`, `App.tsx` (Cmd+K listener)

---

## Phase 3: Rich Entity Experiences (Session 3)

### 3A. Profile Detail Pages — Full Hub Experience
- **What:** Transform profile detail from a basic card into a rich, tabbed hub
- **Why:** Each profile should feel like opening a dossier — everything about Mom, Max, or the Tesla in one place
- **How:**
  - **Info Tab:** Editable fields grid, avatar upload, tags, notes
  - **Documents Tab:** All linked documents with thumbnails, expiration status, upload button to add more
  - **Finances Tab:** Linked expenses list, spending total, spending by month chart
  - **Trackers Tab:** Linked trackers with mini charts (e.g., Max's weight tracker, Tesla's mileage)
  - **Timeline Tab:** Chronological feed of all activity related to this profile (expenses, tracker entries, document uploads, tasks)
  - **Tasks Tab:** Linked tasks with status
  - Profile-to-profile relationships (Mom is related to Me, Max belongs to the household)
- **Files touched:** `profile-detail.tsx` (major rewrite), `server/routes.ts` (enhanced detail endpoint)

### 3B. Document Viewer + Editable Extracted Data
- **What:** Full document detail page with image/PDF preview alongside editable extracted fields
- **Why:** AI extracts data from uploads but there's no way to view the document, correct mistakes, or add missing fields
- **How:**
  - Document detail view: left panel = image/PDF preview (zoomable), right panel = extracted data fields
  - Each extracted field is editable — click to change value
  - "Add Field" button to manually add fields the AI missed
  - Expiration date highlighting (red if expired, yellow if soon)
  - "Link to Profile" button — assign document to a profile
  - Download original file button
- **Files touched:** `DocumentViewer.tsx` (major upgrade), new route `/documents/:id` in `App.tsx`

---

## Phase 4: Intelligent Chat & Automation (Session 4)

### 4A. Chat That Can Do Everything
- **What:** Upgrade AI engine from pattern-matching to full tool-use agent
- **Why:** Currently handles ~10 hardcoded patterns. Should handle ANY app operation via natural language.
- **How:**
  - Switch from regex fast-path to Anthropic tool_use (function calling)
  - Define tools for every CRUD operation:
    - `search(query)` — find anything
    - `create_profile(type, name, fields)`, `update_profile(id, changes)`, `delete_profile(id)`
    - `create_task(title, priority, due)`, `complete_task(id)`, `delete_task(id)`
    - `log_tracker_entry(tracker, values)`, `create_tracker(name, unit, category)`
    - `create_expense(description, amount, category)`, `delete_expense(id)`
    - `create_event(title, date, time)`, `update_event(id, changes)`
    - `create_habit(name, frequency)`, `checkin_habit(name)`
    - `journal_entry(mood, content)`
    - `upload_document(name, type)` — triggers file picker
    - `navigate(page)` — switch the UI to a specific page
    - `get_summary(entity_type)` — "how am I doing on habits this week?"
    - `recall_memory(query)` — "what was that thing I saved about..."
  - Keep fast-path regex for common quick actions (speed)
  - Fall through to full AI agent for complex/ambiguous requests
  - Chat can now answer questions: "When does my insurance expire?", "How much have I spent on food this month?", "What's Max's vet's number?"
- **Files touched:** `server/ai-engine.ts` (major rewrite), `server/routes.ts` (chat endpoint changes)

### 4B. Multi-Document Batch Upload with Smart Routing
- **What:** Drop multiple files at once, AI classifies and routes each one
- **Why:** Uploading 10 documents one at a time is painful. AI should auto-sort them.
- **How:**
  - Chat file upload accepts multiple files
  - For each file: AI vision extracts data + determines type (license, insurance, medical, receipt, etc.)
  - AI proposes profile linkage: "This looks like a vet record — link to Max?"
  - Batch confirmation UI: grid of uploaded docs with proposed types + profile links, user confirms or adjusts
  - Process all on confirm
- **Files touched:** `chat.tsx` (multi-file upload), `server/routes.ts` (batch endpoint), `ai-engine.ts` (classification logic)

---

## Phase 5: Polish & Personalization (Session 5)

### 5A. Notifications & Reminders System
- **What:** Proactive alerts for document expirations, overdue tasks, bills due, habit streak risks, and custom reminders
- **Why:** App should work FOR you, not wait for you to check it
- **How:**
  - `GET /api/notifications` endpoint scans all data for actionable items:
    - Documents expiring within 30/7/0 days
    - Tasks overdue or due today
    - Bills due within 7 days (non-autopay)
    - Habits at risk of breaking streak (not checked in today)
    - Custom reminders set via chat ("remind me to call Mom Friday")
  - Notification bell icon in header with unread count badge
  - Notification dropdown panel with dismiss/snooze actions
  - Dashboard alerts banner already exists — enhance it with notification data
- **Files touched:** `server/routes.ts`, new `client/src/components/NotificationBell.tsx`, `dashboard.tsx`, `App.tsx` (header)

### 5B. Customizable Dashboard Layout
- **What:** Drag-and-drop to reorder dashboard sections, toggle visibility of sections
- **Why:** Not everyone cares about the same things. Make it feel like YOUR operating system.
- **How:**
  - "Customize" button on dashboard header
  - In customize mode: sections become draggable, toggle switches to show/hide each section
  - Layout preference stored in a `user_preferences` table (or JSON blob)
  - Sections: Stat Cards, Alerts, Mood/Habits, Today's Schedule, Documents, Profiles, Journal, Finance, Obligations, Health, Calendar, Insights, Recent Activity
  - Save + restore layout on page load
- **Files touched:** `dashboard.tsx`, `server/storage.ts` (preferences), `server/routes.ts` (preferences endpoint)

---

## Dependency Graph

```
Phase 1 (Foundation)
  ├── 1A. Database ← everything depends on this
  └── 1B. Export/Import ← needs database
          ↓
Phase 2 (Visualization)
  ├── 2A. Tracker Charts ← needs persistent data to be meaningful
  └── 2B. Global Search ← needs database for efficient querying
          ↓
Phase 3 (Rich Entities)
  ├── 3A. Profile Hub ← needs search + charts for embedded views
  └── 3B. Document Viewer ← needs persistent docs
          ↓
Phase 4 (Intelligent Chat)
  ├── 4A. Full AI Agent ← needs all CRUD endpoints stable
  └── 4B. Batch Upload ← needs document viewer + AI agent
          ↓
Phase 5 (Polish)
  ├── 5A. Notifications ← needs database + all entity types stable
  └── 5B. Custom Dashboard ← needs all sections finalized first
```

---

## Per-Session Deliverables

| Session | Deliverable | User Impact |
|---------|------------|-------------|
| 1 | Database + Export/Import | Data survives forever. Backup button. |
| 2 | Charts + Search | See trends. Find anything instantly. |
| 3 | Profile hubs + Doc viewer | Each entity feels complete and connected. |
| 4 | Smart chat + Batch upload | Talk to your data. Dump files and go. |
| 5 | Notifications + Custom layout | App works for you. Feels like yours. |

---

## Technical Notes

- **Database choice:** SQLite (via `better-sqlite3` + Drizzle) is simplest for this architecture — no external DB server, file-based, persists in the workspace. Drizzle ORM and drizzle-kit are already in package.json.
- **No breaking changes:** Every phase preserves the existing `IStorage` interface. Frontend queries stay the same. Only the implementation changes.
- **Recharts** is already installed for charts. `cmdk` is already installed for command palette search. `framer-motion` is installed for drag animations.
- **AI model:** Anthropic Claude via `@anthropic-ai/sdk` — already wired. Tool use just requires adding tool definitions to the API call.
