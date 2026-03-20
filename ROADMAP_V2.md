# LifeOS — Production Roadmap v2

> The original 5-phase roadmap is COMPLETE. This is the next evolution.
> Focus: AI intelligence everywhere, cross-entity connections, weekly AI reports, 
> smart goals, spending analytics, and production hardening.

---

## Phase 6: AI Intelligence Everywhere

### 6A. Weekly AI Digest — Claude-Generated Personal Report
- **What:** Every time you open the dashboard (or on-demand), an AI-generated weekly report card analyzing ALL your data
- **Why:** The insights section is rule-based and shallow. A real AI analysis finds patterns humans miss: "You sleep better on days you exercise", "Your spending spikes on weekends", "You haven't seen a doctor since your last checkup"
- **How:**
  - New endpoint `GET /api/ai-digest` that sends a curated data snapshot to Claude
  - Prompt includes: tracker trends (7-day, 30-day), habit streaks, spending patterns, task completion rate, journal mood arc, upcoming obligations, document expirations
  - Claude returns structured JSON: `{ headline, score (1-100), sections: [{ title, insight, recommendation, severity }], correlations: [{ a, b, insight }] }`
  - Replaces the static InsightsSection on dashboard with a rich AI Digest card
  - Cached for 1 hour (don't re-call Claude on every page load)
  - "Refresh Insights" button to force re-generation
- **AI Prompt Angles:**
  - Cross-entity correlations: "On days you meditate, your mood averages 4.2 vs 3.1"
  - Spending analysis: "You've spent 40% more on food this month vs last month"
  - Health trend analysis: "Your blood pressure has improved since you started running"
  - Goal proximity: "At your current rate, you'll hit 175 lbs by April 15"
  - Risk alerts: "Your car insurance expires in 12 days and you have no renewal document"

### 6B. AI-Powered Profile Insights
- **What:** Each profile detail page gets an AI-generated summary/analysis specific to that entity
- **Why:** When you open Max's profile, you should see "Max's last vet visit was 8 months ago, vaccination is due next month, you've spent $1,240 on Max this year"
- **How:**
  - New endpoint `GET /api/profiles/:id/ai-summary` 
  - Sends profile data + linked documents + linked expenses + linked trackers to Claude
  - Claude returns a natural language summary + action items
  - Displayed as a card at the top of the profile detail page
  - Different prompts per profile type:
    - **Person:** relationships, recent interactions, upcoming events
    - **Pet:** health records, vet visits, vaccinations due
    - **Vehicle:** mileage, insurance status, maintenance schedule, loan payoff
    - **Account/Subscription:** cost analysis, value assessment
  - Cached per profile, invalidated when profile data changes

### 6C. Smart Goals System
- **What:** Set measurable goals tied to trackers/habits/finances with AI-powered progress tracking
- **Why:** Tracking without goals is aimless. "I want to lose 10 lbs by June" should drive notifications, insights, and chat awareness
- **How:**
  - New `goals` table: `{ id, title, type, target, current, unit, deadline, trackerId?, category, status, milestones[] }`
  - Goal types: weight_loss, savings, habit_streak, spending_limit, fitness_distance, custom
  - Goals appear on dashboard as progress bars with projected completion date
  - AI chat can create/update goals: "I want to run 100 miles this quarter"
  - Notifications when ahead/behind pace
  - AI digest references goal progress: "You're 60% to your running goal with 45 days left — on track"
  - Add `create_goal`, `update_goal`, `get_goal_progress` tools to ai-engine

---

## Phase 7: Financial Intelligence

### 7A. Spending Analytics Dashboard
- **What:** Rich financial analytics with category breakdowns, month-over-month trends, budget tracking
- **Why:** The current Finance Snapshot is a simple total. Users need to understand WHERE their money goes.
- **How:**
  - New "Finance" section in dashboard (or expand existing):
    - Monthly spending by category (stacked bar chart)
    - Month-over-month trend line
    - Top merchants/vendors
    - Daily spending heatmap (calendar grid)
    - Category budget limits with progress bars
    - Spending velocity: "You're spending $47/day — on pace for $1,410 this month"
  - Budget system: set monthly limits per category
  - Obligations integration: total monthly committed vs discretionary
  - AI analysis: "Your grocery spending is 30% higher than your 3-month average"

### 7B. Net Worth Tracker
- **What:** Aggregate view of all financial positions — loans, obligations, investments, savings
- **Why:** LifeOS knows about your car loan, rent, subscriptions, and assets. Show the big picture.
- **How:**
  - Pull from: obligations (liabilities), profiles of type "investment"/"asset"/"loan"
  - Manual entry for bank account balances (new tracker type)
  - Monthly snapshot tracking
  - Chart: net worth over time
  - Breakdown: assets vs liabilities

---

## Phase 8: Connected Intelligence

### 8A. Cross-Entity Relationship Engine
- **What:** Explicit and inferred connections between all entities
- **Why:** "Show me everything related to my Tesla" should surface: the profile, the loan, insurance documents, maintenance expenses, registration document, mileage tracker
- **How:**
  - New `entity_links` table: `{ sourceType, sourceId, targetType, targetId, relationship, confidence }`
  - AI auto-links on creation: new expense mentioning "Tesla" → link to Tesla profile
  - Manual linking UI on each entity
  - Relationship graph visualization (optional)
  - Search leverages links: searching "Tesla" returns the profile AND all linked entities
  - AI tools: `link_entities`, `get_related_entities`

### 8B. Smart Tags & Categories
- **What:** AI auto-suggests tags for all entities based on content, and allows custom tag taxonomies
- **Why:** Tags are powerful for cross-cutting views but painful to manage manually
- **How:**
  - When creating any entity, AI suggests relevant tags
  - Tag-based filtered views: "Show everything tagged 'medical'"
  - Auto-categorization of expenses (grocery receipt → category: groceries, vendor: Safeway)
  - Tag cloud on dashboard showing most-used tags
  - Color-coded tags per category

---

## Phase 9: Production Hardening

### 9A. Error Boundaries & Loading States
- **What:** Graceful error handling, skeleton loaders, empty states for every component
- **Why:** Right now, if an API fails, sections just disappear. Production apps degrade gracefully.
- **How:**
  - React Error Boundary around each dashboard section
  - Skeleton loaders for every query-dependent component (most already have these)
  - Retry logic on failed queries
  - Toast notifications for all CRUD success/failure
  - Offline detection banner

### 9B. Keyboard Shortcuts & Accessibility
- **What:** Full keyboard navigation, ARIA labels, screen reader support
- **Why:** Power users live on keyboard. Accessibility is non-negotiable for production.
- **How:**
  - Keyboard shortcuts: Cmd+K (search ✓), Cmd+N (new task), Cmd+J (journal), Cmd+E (expense), Cmd+/ (help)
  - Shortcut cheatsheet dialog
  - Focus management in dialogs
  - ARIA labels on all interactive elements
  - Skip-to-content links
  - High contrast mode support

### 9C. Onboarding Flow
- **What:** First-time user experience that guides setup
- **Why:** New users see sample data and have no idea where to start
- **How:**
  - Detect empty/fresh database
  - Step-by-step wizard: "Let's set up your LifeOS"
    1. Create your self profile (name, basic info)
    2. Add 1-2 people (family, partner)
    3. Add a pet or vehicle
    4. Set up a health tracker
    5. Upload a document
  - Progress bar, skip button, "I'll do this later"
  - After onboarding, clear sample data

---

## Phase 10: Data Portability & Integrations

### 10A. Google Calendar Sync
- **What:** Two-way sync with Google Calendar
- **Why:** Events should flow in from existing calendar, not be manually duplicated
- **How:**
  - Use the already-connected `gcal` connector
  - Import events from Google Calendar → LifeOS events
  - New events in LifeOS → optionally create in Google Calendar
  - Sync indicator on events (source: google_calendar vs manual)

### 10B. Receipt Scanner via Chat
- **What:** Upload a receipt photo, AI extracts line items as individual expenses
- **Why:** One receipt photo should create 5-10 categorized expenses automatically
- **How:**
  - Enhanced `processFileUpload` for receipt type
  - AI extracts: vendor, date, line items (description + price), tax, total
  - Creates multiple expenses from one upload
  - Links to relevant profiles (grocery store → household)

---

## Implementation Priority

| Priority | Item | Why First |
|----------|------|-----------|
| 1 | 6A. Weekly AI Digest | Biggest wow factor — transforms static dashboard into living intelligence |
| 2 | 6C. Smart Goals | Users need direction. Goals drive engagement. |
| 3 | 7A. Spending Analytics | Financial visibility is universally valued |
| 4 | 6B. Profile AI Insights | Makes each profile page feel alive |
| 5 | 8A. Cross-Entity Links | Deep connections make the data truly useful |
| 6 | 9A. Error Boundaries | Production stability |
| 7 | 9C. Onboarding Flow | First impression for new users |
| 8 | Everything else | Incremental improvements |

---

## Technical Notes

- All AI endpoints cache results (1-hour TTL for digest, per-entity for profiles)
- New tables: `goals`, `entity_links`, `ai_cache`
- AI digest costs ~1 Claude call per generation — acceptable at 1/hour max
- Budget system uses existing preferences API for limits
- Entity links are bidirectional in queries, stored once
