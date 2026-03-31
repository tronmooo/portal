# LifeOS — Roadmap v3: Production Stack & Integrations

> v1 (core app) ✅ — v2 (AI intelligence) ✅ — v3: real database, auth, integrations, production infrastructure.

---

## Current State (What Exists Today)

| Layer | Current | Status |
|-------|---------|--------|
| **Frontend** | React + Tailwind + shadcn/ui + Recharts + framer-motion | ✅ Production-quality |
| **Backend** | Express.js on port 5000 | ✅ Working |
| **Database** | SQLite via better-sqlite3 (local file) | ⚠️ Single-user, resets on redeploy |
| **Auth** | None | ❌ Anyone can access |
| **AI Chat** | 24 Anthropic tool_use tools — CRUD everything | ✅ Working |
| **Hosting** | Perplexity Computer static deploy + port proxy | ⚠️ Prototype only |
| **Integrations** | None (gcal connector available but unwired) | ❌ |
| **Domain** | Auto-generated URL | ❌ |

### What the AI Chat CAN Do Today (24 tools)

| Action | Tool | Status |
|--------|------|--------|
| Search everything | `search` | ✅ |
| Get stats/summary | `get_summary` | ✅ |
| Recall saved facts | `recall_memory` | ✅ |
| Create profile | `create_profile` | ✅ |
| Update profile | `update_profile` | ✅ |
| Delete profile | `delete_profile` | ✅ |
| Create task | `create_task` | ✅ |
| Complete task | `complete_task` | ✅ |
| Delete task | `delete_task` | ✅ |
| Log tracker entry | `log_tracker_entry` | ✅ |
| Create tracker | `create_tracker` | ✅ |
| Create expense | `create_expense` | ✅ |
| Delete expense | `delete_expense` | ✅ |
| Create event | `create_event` | ✅ |
| Update event | `update_event` | ✅ |
| Create habit | `create_habit` | ✅ |
| Check in habit | `checkin_habit` | ✅ |
| Create obligation | `create_obligation` | ✅ |
| Pay obligation | `pay_obligation` | ✅ |
| Journal entry | `journal_entry` | ✅ |
| Create artifact | `create_artifact` | ✅ |
| Save memory | `save_memory` | ✅ |
| Open document | `open_document` | ✅ |
| Navigate to page | `navigate` | ✅ |
| Create goal | `create_goal` | ✅ |
| Get goal progress | `get_goal_progress` | ✅ |
| Update goal | `update_goal` | ✅ |
| Link entities | `link_entities` | ✅ |
| Get related entities | `get_related` | ✅ |

### What's MISSING from Chat CRUD

| Gap | Missing Tool | Priority |
|-----|-------------|----------|
| Update task (change title, priority, due date) | `update_task` | High |
| Update expense (change amount, category) | `update_expense` | High |
| Delete habit | `delete_habit` | Medium |
| Delete obligation | `delete_obligation` | Medium |
| Delete event | `delete_event` | Medium |
| Update obligation (change amount, frequency) | `update_obligation` | Medium |
| Update habit (rename, change frequency) | `update_habit` | Medium |
| Delete tracker | `delete_tracker` | Medium |
| Update tracker (rename) | `update_tracker` | Low |
| Delete journal entry | `delete_journal` | Low |
| Delete goal | `delete_goal` (exists in UI, needs chat tool) | Low |
| Delete artifact | `delete_artifact` | Low |

---

## Phase 11: Complete Chat CRUD Coverage

> **Goal:** The AI chat becomes a true command line for your entire life. Every action possible in the UI is also possible via chat.

### 11A. Missing Update Tools
Add to ai-engine.ts:
- `update_task` — change title, description, priority, dueDate, status by partial title match
- `update_expense` — change amount, category, description, vendor by description match
- `update_obligation` — change amount, frequency, nextDueDate by name match
- `update_habit` — change name, frequency, targetDays by name match

### 11B. Missing Delete Tools
Add to ai-engine.ts:
- `delete_habit` — by name match
- `delete_obligation` — by name match
- `delete_event` — by title match
- `delete_tracker` — by name match (with confirmation: "this will delete all entries")
- `delete_journal` — by date match
- `delete_artifact` — by title match

### 11C. Bulk Operations
- `bulk_complete_tasks` — "mark all overdue tasks as done"
- `bulk_delete` — "delete all expenses from last month" (with confirmation)
- `undo_last` — revert the last action (keep a 10-action undo stack)

### 11D. Chat Context Awareness
- After any CRUD operation, include affected entity IDs in the response so the UI can highlight/navigate to them
- "What did I just create?" should recall the last 5 actions
- Multi-step conversations: "Create a profile for my sister → her name is Sarah → she lives in LA → her birthday is March 5"

**Effort: ~2-3 hours. No infrastructure changes needed. Pure code additions to ai-engine.ts + storage methods.**

---

## Phase 12: PostgreSQL + Supabase Migration

> **Goal:** Replace SQLite with a real cloud database. Data persists across deploys, supports multiple devices, enables row-level security.

### Current Problem
- SQLite file lives on the deployment server
- Redeploying resets the database
- No multi-device access
- No backup/restore
- No concurrent access

### 12A. Database Migration
- **Target:** Supabase (PostgreSQL) — free tier: 500MB, 50K monthly active users
- **Migration path:**
  1. Create Supabase project
  2. Migrate SQLite schema → PostgreSQL with Drizzle ORM (already in the template)
  3. Replace `better-sqlite3` calls with Drizzle + Supabase PostgreSQL
  4. Add connection pooling (Supabase provides PgBouncer)
  5. Migrate seed data → Supabase seed SQL
- **Schema changes for PostgreSQL:**
  - JSONB columns for `fields`, `tags`, `values`, `extractedData` (proper querying)
  - Full-text search indexes on `name`, `title`, `description`, `content`
  - Foreign key constraints (currently just string IDs)
  - Timestamp columns with `DEFAULT now()`
  - UUID generation via `gen_random_uuid()`

### 12B. Drizzle ORM Integration
- Already in the project template but not used (currently raw SQL)
- Define proper Drizzle schemas in `shared/schema.ts`
- Type-safe queries, migrations, push
- Automatic TypeScript types from schema

### 12C. Database Backups
- Supabase provides daily automated backups (Pro plan)
- Add manual export endpoint: `GET /api/export` → full JSON dump (already exists)
- Add manual import endpoint: `POST /api/import` → restore from JSON (already exists)
- Point-in-time recovery (Supabase Pro plan)

**Effort: ~4-6 hours. Major refactor of sqlite-storage.ts → drizzle-storage.ts**

---

## Phase 13: Authentication & Multi-User

> **Goal:** Secure the app so only you can access your data. Support multiple users eventually.

### 13A. Supabase Auth
- **Email/password** signup + login
- **Google OAuth** (one-click sign in)
- **Apple OAuth** (if iOS app later)
- **Magic link** (passwordless email login)
- Session management via Supabase JWT
- Auth middleware on all Express routes: verify JWT → extract user_id → scope queries

### 13B. Row-Level Security (RLS)
- Every table gets a `user_id` column
- Supabase RLS policies: `SELECT/INSERT/UPDATE/DELETE WHERE user_id = auth.uid()`
- Even if API is compromised, data isolation is enforced at DB level
- Service role key for server-side operations (AI engine)

### 13C. Auth UI
- Login/signup page with email + Google
- Protected routes: redirect to login if not authenticated
- User profile dropdown (top-right): name, email, logout
- Session persistence (refresh tokens)
- "Forgot password" flow

### 13D. Multi-User Support
- Each user gets isolated data (via RLS)
- Shared profiles: optionally share a profile with another user (family sharing)
- Eventually: family/household plans

**Effort: ~3-4 hours for basic auth. +2 hours for Google OAuth. +2 hours for RLS policies.**

---

## Phase 14: Edge Functions & Serverless

> **Goal:** Move compute-heavy operations to edge functions for better performance and scalability.

### 14A. Supabase Edge Functions (Deno)
- **AI Digest generation** — runs on schedule, not on page load
  - Cron trigger: daily at 6 AM user's timezone
  - Fetches all user data → sends to Claude → stores result
  - Dashboard reads cached result (instant load)
- **Notification engine** — checks for due dates, expiring documents, habit streaks at risk
  - Runs every hour
  - Generates push notifications (web push + email)
- **Auto-categorization** — when a new expense is created, edge function classifies it
- **Receipt processing** — heavy vision AI processing runs async in edge function

### 14B. Webhooks
- **On expense created** → auto-categorize, check budget limits, alert if over
- **On task due date approaching** → send reminder notification
- **On habit streak at risk** → send encouraging notification
- **On document expiration approaching** → send renewal reminder
- **On goal milestone reached** → celebration notification

### 14C. Background Jobs
- **Weekly AI digest** — run Sunday night, ready for Monday morning
- **Monthly spending report** — auto-generate on 1st of month
- **Quarterly goal review** — AI analysis of all goals, suggest adjustments
- **Annual year-in-review** — comprehensive AI-generated year summary

**Effort: ~4-6 hours. Supabase Edge Functions are Deno-based, need to adapt Node.js code.**

---

## Phase 15: Third-Party Integrations

> **Goal:** Connect LifeOS to real financial, calendar, and health data sources.

### 15A. Plaid — Banking & Financial Data
- **What Plaid provides:**
  - Real-time bank account balances
  - Transaction history (auto-import as expenses)
  - Investment portfolio data
  - Recurring transaction detection (auto-create obligations)
  - Income verification
- **Integration plan:**
  1. Plaid Link SDK in frontend (bank connection widget)
  2. Supabase Edge Function as Plaid webhook receiver
  3. Transaction sync: Plaid transactions → LifeOS expenses (auto-categorized)
  4. Balance sync: daily balance snapshots → net worth tracker
  5. Recurring detection: Plaid identifies subscriptions → LifeOS obligations
- **Cost:** Plaid Production: ~$0.30/connection + $0.10/transaction call
  - Development/Sandbox: Free (100 test connections)
  - For personal use: ~$5-10/month depending on linked accounts
- **Complexity: HIGH** — Plaid requires a registered company/entity for production access
- **Alternative:** For prototype, use Plaid Sandbox with test credentials

### 15B. Google Calendar Sync
- **Already have:** `gcal` connector available in the system
- **Integration:**
  1. Wire `gcal` connector to import events
  2. Map Google Calendar events → LifeOS CalendarEvent schema
  3. Bi-directional: LifeOS events → Google Calendar (optional)
  4. Real-time sync via Google Calendar push notifications (webhook)
- **Cost:** Free (Google Calendar API)
- **Complexity: MEDIUM** — connector exists, need to map data

### 15C. Apple Health / Google Fit
- **What it provides:** Steps, heart rate, sleep, workouts, nutrition
- **Integration:**
  - Apple Health: requires native iOS app or Shortcuts automation
  - Google Fit: REST API available
  - Alternative: **Health Connect** (Android) or manual CSV import from health apps
- **Auto-import:** daily health metrics → LifeOS trackers
- **Complexity: HIGH** — requires native app or complex OAuth

### 15D. Email Integration (Gmail/Outlook)
- **What it provides:**
  - Auto-detect receipts → create expenses
  - Auto-detect flight confirmations → create events
  - Auto-detect bill reminders → create/update obligations
- **Integration:** OAuth + email parsing (or use a service like Nylas)
- **Complexity: HIGH** — email parsing is complex, privacy sensitive

### 15E. Notion / Google Docs Sync
- **What it provides:** Import notes, meeting notes, project docs as artifacts
- **Complexity: LOW** — API-based import/export

### Integration Priority Matrix

| Integration | Value | Complexity | Cost | Priority |
|-------------|-------|-----------|------|----------|
| Google Calendar | High | Medium | Free | 1 — Do first |
| Plaid (banking) | Very High | Very High | $5-10/mo | 2 — High value but complex |
| Email parsing | High | High | Free-$20/mo | 3 — After banking |
| Apple Health/Fit | Medium | High | Free | 4 — After core integrations |
| Notion sync | Low | Low | Free | 5 — Nice to have |

---

## Phase 16: Hosting, Domain & Deployment

> **Goal:** Professional hosting with custom domain, SSL, CI/CD.

### Option A: Vercel + Supabase (RECOMMENDED)
- **Frontend:** Vercel (free tier: 100GB bandwidth)
- **Backend:** Vercel Serverless Functions (or keep Express as a long-running server)
- **Database:** Supabase (free tier)
- **Custom domain:** Buy on Namecheap/Cloudflare (~$10-12/year for .com)
- **SSL:** Auto via Vercel
- **CI/CD:** GitHub push → auto deploy
- **Total cost:** ~$10-15/month (domain + Supabase Pro for backups)

### Option B: Railway + Supabase
- **Full-stack:** Railway runs Express + serves static files
- **Database:** Supabase
- **Custom domain:** via Railway ($5/month hobby plan)
- **Pros:** Simpler — one platform, persistent server (WebSockets, SSE work)
- **Total cost:** ~$10-15/month

### Option C: Fly.io + Supabase
- **Server:** Fly.io (Docker container, 3 free VMs)
- **Database:** Supabase
- **Edge:** Fly.io edge workers
- **Pros:** Global edge deployment, great for latency
- **Total cost:** ~$10-15/month

### Option D: Self-Host (VPS)
- **Server:** DigitalOcean Droplet ($6/mo) or Hetzner ($4/mo)
- **Database:** Self-hosted PostgreSQL or Supabase
- **Pros:** Full control, cheapest
- **Cons:** You manage everything — updates, security, backups
- **Total cost:** ~$6-10/month

### Recommended Stack
```
Vercel (frontend + API routes)
  ↕
Supabase (PostgreSQL + Auth + Edge Functions + Storage)
  ↕
Plaid (financial data)
Google Calendar (events)
Anthropic Claude (AI engine)
```

### Domain Setup
1. Buy domain (e.g., `lifeos.app`, `mylifeos.com`, `life-os.io`)
2. Point DNS to Vercel
3. SSL auto-provisioned
4. Set up email: `you@lifeos.app` via Cloudflare Email Routing (free)

---

## Phase 17: Mobile App (Future)

> **Goal:** Native mobile experience for daily logging on the go.

### Options
| Approach | Pros | Cons | Effort |
|----------|------|------|--------|
| **PWA (Progressive Web App)** | Zero app store, works now, add to home screen | Limited native APIs (health, NFC) | 1-2 days |
| **React Native (Expo)** | Share logic with web, native performance | Separate codebase, app store review | 2-4 weeks |
| **Capacitor** | Wrap existing web app in native shell | Limited native integration | 1 week |

**Recommendation:** Start with PWA (add manifest.json, service worker, offline support). Graduate to React Native only if you need Apple Health integration or push notifications.

---

## What This Is — Honest Assessment

### Prototype vs Production

**Today, LifeOS is a sophisticated prototype.** It has:
- ✅ Full CRUD across 12+ entity types
- ✅ AI chat with 29 tools that can manage everything
- ✅ Real-time dashboard with AI-generated insights
- ✅ Document upload with AI extraction
- ✅ Goals, spending analytics, entity linking
- ✅ Onboarding flow, error boundaries, notification system

**To become a production app that you use daily, it needs:**
- ❌ Persistent database (data survives redeployment)
- ❌ Authentication (only you can see your data)
- ❌ Custom domain (professional URL)
- ❌ Real financial data (Plaid or manual bank CSV import)
- ❌ Calendar sync (Google Calendar)
- ❌ Mobile experience (PWA at minimum)

### Can I Build All of This?

**Yes, with caveats:**

| Layer | Can I Build It? | Notes |
|-------|----------------|-------|
| PostgreSQL migration | ✅ Yes | Need Supabase project credentials |
| Supabase Auth | ✅ Yes | Need Supabase project URL + anon key |
| Google Calendar sync | ✅ Yes | gcal connector already available |
| Edge Functions | ✅ Yes | Via Supabase dashboard |
| Plaid integration | ⚠️ Partially | Sandbox: yes. Production: requires company entity + Plaid approval |
| Custom domain | ⚠️ Partially | Can configure, but you need to buy the domain |
| Vercel deployment | ⚠️ Partially | Need Vercel account + GitHub repo |
| Mobile app | ✅ PWA yes | React Native would be a separate project |
| Complete chat CRUD | ✅ Yes | Pure code — can do now |

---

## Implementation Order

### Batch 1: Immediate (Can Do Now)
1. **11A-D. Complete Chat CRUD** — fill in missing update/delete tools
2. **Google Calendar sync** — wire the existing gcal connector
3. **PWA manifest** — make it installable on phone home screen

### Batch 2: Infrastructure (Need Credentials)
4. **12A-C. Supabase PostgreSQL migration** — need Supabase project
5. **13A-C. Supabase Auth** — login/signup, Google OAuth
6. **16. Custom domain** — need domain purchase

### Batch 3: Integrations (Need Accounts)
7. **15A. Plaid integration** — need Plaid developer account
8. **14A-C. Edge Functions** — scheduled AI digests, notifications
9. **15D. Email parsing** — Gmail receipt auto-import

### Batch 4: Polish
10. **17. PWA + Mobile** — offline support, push notifications
11. **Keyboard shortcuts** — power user features
12. **Data export/import** — already partially built

---

## Cost Estimate (Monthly)

| Service | Free Tier | Paid Tier | Notes |
|---------|-----------|-----------|-------|
| Supabase | 500MB DB, 50K users | $25/mo (Pro) | Database + Auth + Edge Functions |
| Vercel | 100GB bandwidth | $20/mo (Pro) | Hosting + CI/CD |
| Anthropic Claude | — | ~$5-15/mo | AI chat + digests (pay per token) |
| Plaid | Sandbox free | $5-10/mo | Banking integration |
| Domain | — | $10-12/year | Custom domain |
| **Total** | **$0 (prototype)** | **~$55-80/month** | **Full production** |

Bare minimum production: Supabase free tier + Vercel free tier + domain = **~$6/month** (just Claude API + domain)

---

## Decision Points for You

1. **Do you want to keep this as a personal tool or make it multi-user?**
   - Personal: simpler auth, no RLS needed, cheaper
   - Multi-user: full auth system, RLS, more infrastructure

2. **Plaid: worth the complexity?**
   - YES if you want auto-imported bank transactions (game-changer for finance tracking)
   - NO if manual expense entry is fine (can always add later)
   - MIDDLE: CSV import from bank (export from bank website, import into LifeOS)

3. **Hosting preference?**
   - Vercel: easiest, best CI/CD, great free tier
   - Railway: simplest for Express apps
   - Self-host: cheapest, most control

4. **Mobile priority?**
   - PWA first (free, quick, works on any phone)
   - Native app later if you need Apple Health or rich push notifications

---

## Phase 4: Browser Automation Agent Mode

> The AI agent becomes a real-world operator — browsing websites, filling forms, retrieving data, and completing workflows using saved Portol data.

### Core Capability

Full browser automation inside agent mode. The AI can browse the web, navigate websites, fill out forms, upload documents, retrieve information, and complete real browser-based tasks using the user's saved data when authorized. The AI combines internal data from profiles, documents, trackers, calendar, finance, and health records with live web interactions to complete workflows end to end.

### What the Agent Can Do

| Action | Description |
|--------|-------------|
| **Open websites** | Navigate to any URL, search online |
| **Read page content** | Extract text, detect form fields, parse tables |
| **Fill out forms** | Auto-populate using saved profile, insurance, vehicle, medical data |
| **Upload documents** | Attach saved PDFs/images from the document vault to web forms |
| **Submit forms** | With explicit user approval before any submission |
| **Log into portals** | Securely authenticate to user-authorized services |
| **Download files** | Save receipts, PDFs, confirmations back into Portol |
| **Create reports** | Generate spreadsheets, summaries, or documents from gathered data |
| **Multi-site workflows** | Chain actions across multiple websites in a single task |

### Example Workflows

1. **Medical intake form** → Fill using saved profile + insurance data
2. **Vehicle registration form** → Populate from stored vehicle info + address
3. **Online applications** → Apply saved contact details + upload documents
4. **Portal retrieval** → Log into services, download statements/confirmations
5. **Price comparison** → Search, gather results, save as spreadsheet
6. **Document upload** → Attach saved PDFs to a website's upload form
7. **Research task** → Search online, gather results, save as document/chart

### Safety & Control Layer

| Control | Description |
|---------|-------------|
| **Permission prompts** | Explicit approval before high-impact actions |
| **Submission preview** | Editable preview before any form submit, payment, or send |
| **Step-by-step log** | Visible activity log for every browser action |
| **Field confirmation** | User confirms when AI confidence is low |
| **Secure credentials** | Encrypted credential storage with per-session authorization |
| **Download/upload history** | Full audit trail tied to each task |

### Artifacts Hub

All outputs from browser automation are automatically saved and linked:

| Artifact Type | Saved To |
|---------------|----------|
| Filled form data | Artifacts Hub + linked profile |
| Confirmation numbers | Artifacts Hub + notes |
| Screenshots | Artifacts Hub + document vault |
| Downloaded PDFs | Document vault + linked profile |
| Generated spreadsheets | Artifacts Hub |
| Generated reports | Artifacts Hub |
| Summaries | Artifacts Hub + linked profile |

### Agent Tasks UI

Each agent task has:
- **Status** (queued / running / awaiting approval / completed / failed)
- **Website(s) used**
- **Linked data sources** (which profiles, documents, trackers were used)
- **Outputs created** (artifacts, documents, reports)
- **Approval checkpoints** (user-confirmed steps)
- **Duration and cost**

Task types:
- Browse and research
- Fill out online form
- Upload document to website
- Compare products or services
- Pull data from a portal
- Create spreadsheet from findings
- Draft and save report
- Complete multi-site workflow

### Technical Architecture (Planned)

| Component | Approach |
|-----------|----------|
| Browser engine | Puppeteer or Playwright (headless Chromium) |
| Execution | Serverless function or dedicated worker |
| AI orchestration | Claude tool_use with browser-action tools |
| Credential storage | Encrypted vault (Supabase Vault or similar) |
| Session recording | Screenshot + DOM snapshot at each step |
| Artifact storage | Supabase Storage + linked to profiles/documents |
| Task queue | Supabase-backed queue with status tracking |

### Implementation Phases

1. **4a: Read-only browsing** — Agent can open URLs, read content, extract data, save findings
2. **4b: Form detection + auto-fill** — Detect form fields, map to saved data, preview before submit
3. **4c: Full interaction** — Submit forms, upload files, handle multi-page flows
4. **4d: Portal integration** — Secure credential management, login to services
5. **4e: Artifacts Hub UI** — Dedicated section for all agent-created outputs

### Priority: HIGH
This is a core differentiator. No other personal life management app can do this.

