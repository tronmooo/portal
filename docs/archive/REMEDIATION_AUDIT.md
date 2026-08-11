# Portol Remediation Audit — Finding Status

> Audit date: March 30, 2026
> Audited against: Current production codebase (commit 4df3290)

## Legend
- ✅ FIXED — Fully addressed in current codebase
- ⚠️ PARTIAL — Partially addressed, some gaps remain
- ❌ OPEN — Not yet addressed, needs work
- 🔮 ROADMAP — Architectural change for future phase

---

## Section 1: Core System Failures — Status

### 1. Weak entity & ownership model
**Status: ✅ FIXED**
- Every table has `user_id` column. All 107+ queries include `.eq("user_id", this.userId)`
- Per-request scoped storage via `AsyncLocalStorage` — each HTTP request gets its own `SupabaseStorage` instance with the authenticated user's ID
- Auth middleware (`server/auth.ts`) extracts user from Supabase JWT, creates scoped storage, runs request within that context
- Separate tables exist for: profiles, trackers, tracker_entries, tasks, expenses, events, documents, obligations, obligation_payments, habits, habit_checkins, journal, goals, entity_links, memories
- Profile types are differentiated: self, person, pet, vehicle, subscription, loan, investment, asset, property, account, medical

**Remaining gap:** No unique constraint on profile names within a user (duplicate "Buddy" is possible). This is a DB-level constraint that should be added.

### 2. Missing linking layer / inconsistent relationships
**Status: ✅ FIXED**
- Junction tables exist: `profile_trackers`, `profile_expenses`, `profile_tasks`, `profile_events`, `profile_documents`, `profile_obligations`
- `entity_links` table for arbitrary relationships between any two entities
- `getProfileDetail()` queries junction tables + JSONB `linked_profiles` arrays (union of both for backward compatibility)
- `autoLinkToProfiles()` in ai-engine.ts automatically links created entities to the correct profile based on name matching
- `propagateEntityToAncestors()` propagates links up the parent chain (Honda → Me)

### 3. Inadequate multi-tenant isolation and query filtering
**Status: ✅ FIXED**
- Auth middleware rejects requests without valid JWT token (returns 401 AUTH_REQUIRED)
- `createScopedStorage(user.id)` creates per-request isolated storage
- All read queries scope by `user_id`
- `requestStorageContext` (AsyncLocalStorage) ensures concurrent requests from different users don't cross-contaminate

**Remaining gap:** Supabase RLS policies should be enabled as defense-in-depth. Currently relying on application-level filtering only.

### 4. Poor parser-to-action contracts
**Status: ✅ FIXED**
- 35 explicitly typed tool definitions with full parameter schemas
- Each tool has: name, description, input_schema with typed properties and required fields
- Tools include: create_task, create_expense, create_event, create_profile, create_tracker, log_tracker_entry, create_goal, update_goal, delete_goal, create_obligation, pay_obligation, journal_entry, save_memory, recall_memory, search, get_summary, link_entities, etc.
- Server-side validation via Zod schemas (19 validation points in routes.ts)
- AI tool calls include profile scoping via `autoLinkToProfiles()`
- Deduplication logic prevents duplicate tasks, expenses, and tracker entries

### 5. Missing data validation and schema enforcement
**Status: ⚠️ PARTIAL**
- Zod schemas validate inputs on API routes (insertGoalSchema, insertProfileSchema, etc.)
- Required field checks in routes (e.g., goal title required, target must be > 0)
- Dedup logic in AI engine prevents duplicate trackers, tasks, expenses
- Type checking on numeric fields

**Remaining gaps:**
- No DB-level unique constraint on profile names
- Some forms accept empty optional fields without warning
- No comprehensive input sanitization beyond basic XSS (sanitize function exists but limited)

### 6. Stale client state and poor state management
**Status: ✅ FIXED**
- TanStack Query (React Query v5) used throughout with `staleTime: 5000`
- 127 `queryClient.invalidateQueries()` calls across all pages
- Cache invalidation on every mutation (create, update, delete)
- Server-side cache busting on write operations (`bustCache()` in routes.ts)
- Per-user context cache in AI engine with invalidation after tool calls

### 7. Generic UI architecture instead of entity-specific components
**Status: ✅ FIXED (this session)**
- Dynamic tab generation per profile type via `ENTITY_TABS` config
- 10 profile types with distinct tab sets and context-aware labels
- Vehicle: Overview → Maintenance → Costs → Documents → History
- Person: Overview → Health → Finance → Documents → Goals & Tasks → Activity
- Pet: Overview → Health & Vet → Expenses → Documents → Reminders
- Subscription: Overview → Billing → Documents → History
- Tab content properly routed: Documents tab shows ONLY documents, Health tab shows health data + trackers
- Tracker cards are type-aware with dynamic KPIs, sparklines, and AI insights

### 8. Naïve recurrence and calendar modeling
**Status: ⚠️ PARTIAL**
- Events stored as individual records (no RRULE)
- Obligations have `frequency` field (monthly, weekly, etc.) with `nextDueDate` auto-calculation
- Calendar view renders events from the events table

**Remaining gap:** No RRULE-based recurrence engine. Editing recurring events affects only one instance. This is a significant architectural change — added to roadmap.

### 9. Ineffective filtering and search
**Status: ⚠️ PARTIAL**
- Profile filter works on dashboard (scoped to profileId query param)
- Tracker page filters by profile, category, section type
- Document type filter exists
- Obligation filtering by profile (fixed in this session)

**Remaining gaps:**
- Most filtering is client-side (adequate for current data volumes but not scalable)
- No full-text search index (PostgreSQL tsvector)
- No server-side pagination

### 10. Document retrieval and asset linking flaws
**Status: ✅ FIXED**
- Documents have UUID IDs + user_id scoping
- File storage in Supabase Storage with user-scoped paths
- `getDocument(id)` requires both ID match and user_id match
- Blob URL rendering for large files (prevents base64 crashes)
- Document extraction with profile linking
- Multi-document retrieval via chat ("open my registration, license, and insurance")

### 11. Inconsistent source-of-truth decisions
**Status: ✅ FIXED**
- Supabase PostgreSQL is the single source of truth
- All writes go through the Express API → Supabase
- TanStack Query cache is the client-side derived view with auto-invalidation
- No dual-write patterns
- External integrations (Google Calendar) sync through the same API

---

## Section 3: Repair Priorities — Current Status

| Priority | Item | Status |
|----------|------|--------|
| Critical | Strong entity & ownership model | ✅ Done |
| Critical | Proper linking layer | ✅ Done |
| Critical | Data validation & RLS | ⚠️ Partial (app-level done, DB-level RLS pending) |
| Foundational | Parser-to-action contracts | ✅ Done (35 typed tools) |
| Foundational | Rule-based recurrence | ❌ Open (roadmap) |
| Foundational | Normalized state management | ✅ Done (TanStack Query) |
| Foundational | Entity-aware UI | ✅ Done (this session) |
| UX/Polish | Filtering & search | ⚠️ Partial |
| UX/Polish | Document retrieval | ✅ Done |
| Performance | Source of truth & sync | ✅ Done |

---

## Remaining Action Items (Priority Order)

### P0 — Before Production Launch
1. **Enable Supabase RLS policies** — Defense-in-depth. Even if app-level filtering works, RLS prevents any bypass.
2. **Add unique constraint on profile names per user** — Prevent duplicate "Buddy" profiles at DB level.
3. **Input sanitization audit** — Review all user inputs for XSS, SQL injection, and malformed data.

### P1 — Near-term Improvements
4. **RRULE-based recurrence** — Replace individual event records with recurrence rules. Use rrule.js for generation.
5. **Server-side filtering & pagination** — Move heavy filtering to Supabase queries for scalability.
6. **Full-text search** — Add PostgreSQL tsvector indexes for name/description search.

### P2 — Future Enhancements
7. **Comprehensive error handling** — Unified error boundary + retry logic for all API calls.
8. **Offline support** — Service worker + local queue for offline mutations.
9. **Audit logging** — Track who changed what, when (for compliance).
10. **Rate limiting per user** — Already exists for chat, extend to all write endpoints.
