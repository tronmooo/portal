# Test Strategy — Portol / LifeOS

## Overview

This document describes the complete test strategy for the Portol app: what is tested, how, and why.

---

## Test Architecture

```
tests/
├── unit/                    # Pure logic tests (no I/O, no network)
│   ├── schema.test.ts       # Zod schema validation (73 tests)
│   └── insights-engine.test.ts  # Analytics generation logic (24 tests)
│
├── integration/             # API endpoint tests (Express + InMemoryStorage)
│   ├── mock-storage.ts      # Full IStorage in-memory implementation
│   ├── setup.ts             # Test app factory, module mocks
│   ├── profiles.test.ts     # Profile CRUD API (16 tests)
│   ├── trackers.test.ts     # Tracker + entry API (12 tests)
│   ├── tasks.test.ts        # Task API (12 tests)
│   ├── expenses.test.ts     # Expense API (11 tests)
│   ├── events.test.ts       # Calendar events API (13 tests)
│   ├── obligations.test.ts  # Obligations/subscriptions API (14 tests)
│   ├── habits.test.ts       # Habits + checkins API (11 tests)
│   ├── documents.test.ts    # Documents API (8 tests)
│   └── filter-by-profile.test.ts  # Cross-entity profile filtering (9 tests)
│
├── e2e/                     # Full browser tests (Playwright)
│   ├── global-setup.ts      # Shared auth state
│   ├── auth.spec.ts         # Login, signup, protected routes
│   ├── profiles.spec.ts     # Profile creation + navigation
│   ├── trackers.spec.ts     # Tracker creation + entry logging
│   └── chat.spec.ts         # AI chat → entity creation → UI verification
│
├── smoke/                   # Post-deployment health checks
│   └── deployment.test.ts   # HTTP checks against live server
│
└── regression/              # Known bugs that have been fixed
    └── known-bugs.test.ts   # Prevents regressions (18 tests)
```

---

## What Should Be Tested Automatically

### ✅ Unit Tests (fast, no I/O — run on every commit)

| Area | Tests | Why |
|------|-------|-----|
| Zod schema validation | All 14 schemas | Data contracts are the source of truth; invalid data must be rejected at the boundary |
| Insights engine | Spending, habits, tasks, obligations, mood, events | Pure function with complex logic; easy to regress |
| EVENT_CATEGORY_COLORS | All 9 categories | UI relies on these — missing color = broken UI |
| Schema defaults | All default values | Ensures new records get correct initial state |

### ✅ Integration Tests (fast, ~2s total — run on every commit)

| Flow | Tests |
|------|-------|
| Profile CRUD | Create, read, update, delete + validation rejection |
| Nested profiles | parentProfileId linking + childProfiles in detail |
| Tracker CRUD + entries | Log entries, delete entries, duplicate name detection |
| Task CRUD | Status transitions (todo → in_progress → done) |
| Expense CRUD | Amount validation, category defaults |
| Calendar events | Recurrence, categories, timeline range query |
| Obligations | Create, pay, pause, cancel |
| Habits + checkins | Streak tracking, checkin with value/notes |
| Documents | Upload metadata, tags, profile linking |
| Profile filtering | Cross-entity data isolation per profile |
| Multi-profile linking | Entities appearing in multiple profile detail views |

### ✅ Regression Tests (run on every commit)

| Bug | Test |
|-----|------|
| C-1: Race condition / storage leak | Parallel requests get separate IDs and correct amounts |
| Negative/zero expense amounts | Rejected by both schema and API |
| Invalid profile types | Rejected at API boundary |
| Tracker entry for nonexistent tracker | Returns 404, not 200 |
| Habit checkin for nonexistent habit | Returns 404, not 500 |
| Obligation payment for nonexistent obligation | Returns 404 |
| PATCH nonexistent resource returns 200 | Returns 404 for profiles, tasks, expenses, events |
| Mood validation mismatch | Tracker vs journal mood enums |
| Memory upsert creates duplicates | Key uniqueness enforced |
| Entity link confidence out of range | 0–1 range validated |

### ✅ E2E Tests (Playwright — run on main branch merges)

| Flow | Coverage |
|------|----------|
| Auth | Login failures, short password, protected route redirect |
| Post-auth | All main nav sections accessible without redirect |
| Profile creation | Person + vehicle profile via UI |
| Profile detail navigation | Click through to profile detail page |
| Tracker creation | Name a tracker, create via dialog |
| Tracker entry logging | Log a value against a tracker |
| Chat → task | Type "create task X" → task appears in Tasks page (requires API key) |
| Chat → expense | Type "I spent $X on Y" → appears in Finance (requires API key) |
| Chat → event | Type "schedule meeting X" → appears in Calendar (requires API key) |
| Chat → profile | Type "create profile X" → appears in Profiles (requires API key) |

### ✅ Smoke Tests (run after every deployment)

| Check | Expected |
|-------|----------|
| Server reachable | HTTP status < 500 |
| `/api/auth/config` | 200 with valid JSON |
| All main API routes unauthenticated | Return 401, NOT 500 |
| Unknown API route | Returns 404, not 500 |
| Security headers present | At least one of: CSP, X-Frame-Options, X-Content-Type |

---

## What Still Needs Manual QA

These flows are too complex, dynamic, or dependent on external state to automate reliably:

| Area | Why Manual |
|------|-----------|
| **AI chat quality** | Whether Claude's responses are helpful, accurate, and well-formatted requires human judgment |
| **Document AI extraction** | Quality of extracted fields from real-world documents (driver's licenses, insurance cards, receipts) |
| **Document upload UI** | Drag-and-drop, camera capture, multi-file selection, progress indicators |
| **Onboarding flow (first-time user)** | Self-profile auto-creation, welcome state, first-time tooltips |
| **Responsive design / mobile layout** | Visual layout correctness on real devices |
| **Dark/light theme switching** | Color contrast, icon visibility, chart readability |
| **Calendar rendering** | Month/week/day view correctness, event overlap display |
| **Recharts data visualization** | Chart rendering accuracy, hover tooltips, date ranges |
| **CSV import** | Parsing bank CSV files from different financial institutions |
| **Supabase Storage file download** | Fetching and rendering stored documents in production |
| **Real-time performance** | Response times under real DB load |
| **Cross-browser compatibility** | Safari on iOS, Firefox quirks |
| **PWA / mobile web experience** | Add-to-home-screen, offline behavior |
| **AI insights quality** | Whether auto-generated insights are actually useful and accurate |
| **Toast notifications** | Timing, stacking, dismiss behavior |
| **Error boundary recovery** | React error boundary fallback screens |

---

## Bugs Currently Untestable Due to Architecture Issues

| Bug / Risk | Why Untestable | Architecture Gap |
|-----------|---------------|-----------------|
| **Insights engine skips cancelled obligations** | The `analyzeObligations()` function doesn't filter by `status` — cancelled obligations still trigger alerts. This is documented in `insights-engine.test.ts` as a known bug. | Missing status filter in pure function — easy fix: add `&& o.status === 'active'` |
| **Cross-user data leakage (C-2)** | Per-user Supabase row-level security can't be tested without a real PostgreSQL instance with RLS enabled. Integration tests use InMemoryStorage (single user). | Requires running Supabase locally or a dedicated test project |
| **JWT token expiry behavior** | Can't advance time in Supabase to test token refresh. | Requires time-mock integration with Supabase client |
| **Supabase Storage file serving** | `storagePath` documents require signed URLs from real Supabase Storage; can't mock without actual bucket access. | Requires Supabase test bucket |
| **AI engine tool call failures** | If Claude returns a malformed tool response, the error handling path is exercised. Can't reliably trigger this without mocking Anthropic responses at a deep level. | Needs Anthropic SDK mock layer |
| **Concurrent login race condition (C-1)** | The AsyncLocalStorage fix works in theory; testing true concurrency in Node.js single-thread event loop is not meaningful. Real race conditions require load testing. | Requires load test tooling (k6, Artillery) |
| **Chat confirmation/extraction flow** | The two-phase extraction (`POST /api/chat/confirm-extraction`) depends on a prior upload + extraction pass with real AI. | Full mock of AI extraction pipeline needed |
| **Database cascade deletes** | Profile deletion cascade behavior (clearing linkedProfiles references across all entity types) only works with Supabase triggers/RLS. InMemoryStorage doesn't replicate this. | Needs DB-level integration test environment |
| **Recurrence event expansion** | Events with `recurrence: "weekly"` should expand into multiple instances in calendar views. The current implementation stores them as single records; expansion logic needs a dedicated test. | Missing expansion logic in `getCalendarTimeline()` |

---

## CI Setup for Production Confidence

### Pipeline: `.github/workflows/ci.yml`

```
Every PR:
  typecheck    → tsc --noEmit (catches type errors before merge)
  unit-tests   → tests/unit (73 tests, ~0.4s)
  integration  → tests/integration (106 tests, ~2s)
  regression   → tests/regression (18 tests, ~0.7s)
  build        → production build validation

On merge to main:
  e2e          → Playwright against production build (requires TEST_EMAIL/TEST_PASSWORD secrets)

After deploy (via DEPLOY_URL variable):
  smoke        → 13 HTTP checks against live URL
```

### Required GitHub Secrets

| Secret | Used For |
|--------|---------|
| `VITE_SUPABASE_URL` | E2E + smoke (Supabase connection) |
| `VITE_SUPABASE_ANON_KEY` | E2E browser auth |
| `SUPABASE_SERVICE_ROLE_KEY` | E2E server auth validation |
| `DATABASE_URL` | E2E server startup |
| `ANTHROPIC_API_KEY` | E2E chat action tests |
| `TEST_EMAIL` | E2E auth (pre-existing test user) |
| `TEST_PASSWORD` | E2E auth |

### Required GitHub Variables

| Variable | Used For |
|----------|---------|
| `DEPLOY_URL` | Smoke tests post-deployment (e.g. `https://your-app.vercel.app`) |

### Running Tests Locally

```bash
# All unit + integration + regression (fast, no server needed)
npm test

# Watch mode during development
npm run test:watch

# With coverage report
npm run test:coverage

# Specific suites
npm run test:unit
npm run test:integration
npm run test:regression

# Smoke tests (requires running server)
BASE_URL=http://localhost:5000 npm run test:smoke

# E2E tests (requires running server + test credentials)
TEST_EMAIL=test@example.com TEST_PASSWORD=TestPass123! npm run test:e2e

# E2E with UI
npm run test:e2e:ui
```

### Coverage Thresholds (enforced in CI)

| Metric | Threshold |
|--------|-----------|
| Lines | 50% |
| Functions | 50% |
| Branches | 40% |
| Statements | 50% |

Target: **70% line coverage** once AI engine integration tests are added.

---

## Priority Improvements (Next Steps)

1. **Add `status === 'active'` filter in `analyzeObligations()`** — fixes the known bug caught by tests
2. **Mock Anthropic SDK** for integration testing the AI engine tools (24 tools, currently untested at integration level)
3. **Add Supabase local dev** (`supabase start`) for true DB integration tests with RLS
4. **Add `data-testid` attributes** to React components to make E2E selectors more stable
5. **Add load tests** with k6 to verify concurrency safety of the AsyncLocalStorage fix
6. **Add visual regression tests** (Playwright screenshots) for chart/calendar components
7. **Add API contract tests** to ensure frontend and backend schema agree
8. **Expand E2E to cover** journal, habits, goals, and custom domains
