# Portol Production Readiness Audit
## March 31, 2026

### Audit Scope
Full codebase audit: server/routes.ts (2980 lines), server/supabase-storage.ts (2580 lines), server/ai-engine.ts (3446 lines), 14 frontend page components (22,777 lines total).

---

## CRITICAL ISSUES (Must fix before any user touches this)

### C-1: Profile field overwrite on inline edit ✅ FIXED
- **Location**: supabase-storage.ts line 562
- **Issue**: `updateProfile` used `{...existing, ...data}` spread which replaced the entire `fields` object when updating a single field. Editing "mileage" would delete make, model, year, VIN, etc.
- **Fix applied**: Deep merge fields separately before spreading.

### C-2: type_key was never returned from API ✅ FIXED
- **Location**: supabase-storage.ts rowToProfile()
- **Issue**: The `type_key` column existed in DB but was never mapped to the Profile object. All registry features (engines, dynamic forms, summary widgets) were invisible.
- **Fix applied**: Added type_key to rowToProfile mapping.

### C-3: Dashboard showed unverified AI insights as fact ✅ FIXED
- **Issue**: "Important Right Now" derived alerts from unverified extracted data. A misread dollar amount became "Expired: Vehicle Registration - expires 1085" showing "343,782 days ago."
- **Fix applied**: Replaced with "Needs Attention" driven only by verified structured data (tasks + bills).

### C-4: Auto-calendar creation from unverified extraction ✅ FIXED
- **Issue**: Document upload blindly created calendar events from extracted dates without confidence scoring or user confirmation.
- **Fix applied**: Disabled both auto-calendar blocks. Dates stay in extraction review UI.

### C-5: Habits have no profile linking
- **Location**: habits table, supabase-storage.ts
- **Status**: Partially fixed (linked_profiles column added, but existing habits have empty arrays)
- **Impact**: Habits show on all profile dashboards regardless of who they belong to
- **Remaining work**: Migration script to link existing habits to self profile

### C-6: Journal entries have no profile linking
- **Location**: journal_entries table
- **Issue**: Journal is personal/self-only but the backend filter was added recently. No linked_profiles column exists.
- **Impact**: Medium — journal correctly shows only for self, but the filtering is implicit.

---

## HIGH SEVERITY ISSUES

### H-1: Goals have no profile linking (partially fixed)
- linked_profiles column added but goals aren't filtered on the frontend's Goals section consistently.

### H-2: No input validation on many frontend forms
- Expense add form accepts negative amounts
- Tracker entry doesn't validate against field type
- Goal target can be 0 or negative
- Profile name accepts empty strings (server validates but client doesn't show error)

### H-3: Tracker entries from document extraction may be duplicated
- Uploading the same lab report twice creates duplicate tracker entries
- No deduplication check on tracker entry values + timestamps

### H-4: Calendar has phantom events from old auto-creation
- Old auto-created events (from before the fix) may still exist for other user accounts
- The cleanup only ran for user 6f63cf74

### H-5: DynamicProfileDetail components (engines, expandable cards) exist but are unused
- 5000+ lines of code (engines, DynamicProfileForm, ProfileTypeSelector, DynamicProfileDetail) are built but not wired in
- The legacy tab system was restored, DynamicProfileDetail was disconnected
- This code should either be integrated into the legacy tabs or removed

### H-6: profile_type_definitions table has 80 types but most are unused
- Only types matching existing profiles are used
- The ProfileTypeSelector for profile creation was built but may not be rendering due to the profiles.tsx changes

### H-7: SupabaseStorage userId can be 'anonymous'
- Line 1662: fallback singleton uses 'anonymous' userId
- This only happens if auth middleware fails silently, but could expose all users' data

---

## MEDIUM SEVERITY ISSUES

### M-1: Dashboard cache (10-second TTL) can show stale data after writes
- Profile detail has 10s cache. After inline edit, data refreshes via query invalidation, but other users or browser tabs may see stale data.

### M-2: Rate limiting uses IP + userId fallback
- If auth fails, rate limits fall back to IP address, which could be shared (corporate proxy, VPN)

### M-3: Chat message history uses module-level cache
- _chatCache persists across navigation but not across page refreshes
- No persistence to database for chat history

### M-4: No pagination on most list endpoints
- /api/trackers, /api/tasks, /api/expenses, etc. return ALL records
- At scale (1000+ records), this will cause performance issues

### M-5: Document file_data stored as base64 in JSONB
- No Supabase Storage bucket integration
- Large documents (10MB) stored as base64 = 13MB in database
- Performance degrades as document count grows

### M-6: No optimistic updates on mutations
- Every create/update/delete waits for server response before updating UI
- Makes the app feel slow

### M-7: Error messages from API not always shown to user
- Some mutations swallow errors silently
- User sees "something went wrong" instead of specific error

---

## LOW SEVERITY ISSUES

### L-1: Notification badge count doesn't persist dismissals
- Dismissing notifications is session-only (useState)
- Reloading brings them all back

### L-2: Search (⌘K) scope is unclear
- No placeholder text explaining what it searches
- Searches across all entity types with no indication of which

### L-3: Calendar view is monthly only
- No week or day view
- Small cells truncate event text heavily

### L-4: No undo for destructive actions
- Deleting a profile, tracker, or document is permanent
- No soft delete or undo period

### L-5: Mobile responsiveness issues
- Sidebar collapse doesn't work well on mobile
- Some forms overflow on small screens
- Calendar cells are cramped

---

## WHAT ACTUALLY WORKS WELL

1. **Authentication**: Per-request scoped storage via AsyncLocalStorage is solid. Every Supabase query is scoped to the authenticated user.
2. **RLS**: Row Level Security policies exist as a second layer of protection.
3. **Chat AI**: Tool routing is comprehensive with 15+ tools. Profile linking (autoLinkToProfiles) uses scoring-based matching.
4. **Document extraction**: Two-pass extraction for lab reports. Vision API correctly processes images.
5. **Profile detail page**: Rich tabs with real data (Health tab has charts, Finance tab has amortization).
6. **Data model**: Flexible JSONB fields on profiles allow any schema without migrations.

---

## PRODUCTION READINESS SCORE: 4/10

### Why not higher:
- The app builds and deploys cleanly
- Auth is solid
- But the user experience has trust failures: data displayed incorrectly, features that look complete but don't work, phantom data from old bugs
- The codebase has 5000+ lines of unused registry code
- No automated tests exist
- No error monitoring (Sentry, etc.)
- No performance monitoring
- No backup/recovery plan for user data

### What would make it 7/10:
1. Fix all C-level and H-level issues
2. Add input validation on every form
3. Add loading/error states consistently
4. Remove or integrate unused code (registry components)
5. Add basic E2E tests for critical flows
6. Clean up phantom data from old bugs across all users
7. Add error monitoring

### What would make it 9/10:
All of the above plus:
8. Migrate documents to Supabase Storage
9. Add pagination to all list endpoints
10. Add optimistic updates
11. Add undo for destructive actions
12. Mobile-first responsive redesign
13. Comprehensive E2E test suite
14. Performance profiling and optimization
15. User onboarding flow
