# Jane Doe QA Bug Fixes

## Bugs Found (verified)

### 🔴 CRITICAL
1. **Task leaked to Me**: "Schedule annual checkup for Jane Doe" appears in Me's tasks (linkedProfiles includes Me ID)
2. **Journal not linked to Jane**: journal entries don't have linkedProfiles set for Jane
3. **Duplicate habits**: Running both queries creates duplicate "Take vitamins" and "Stretch" habits instead of deduplicating
4. **Vitamins subscription missing**: $26/mo vitamins obligation wasn't created (possibly deduped against something else)

### 🟠 HIGH  
5. **Activity feed not profile-scoped**: Dashboard Recent Activity shows global logs, not filtered by selected profile
6. **AI Summary stale**: Uses cached data, shows old age after update
7. **Habits not in calendar view**: Daily/weekly habits don't appear as calendar events

### 🟡 MEDIUM
8. **Calendar labels generic**: "Dentist visit" should say "Jane Doe - Dentist visit"
9. **Journal blocks second entry**: System rejects journal if one already exists for today

## Files to Fix

### 1. `/home/user/workspace/lifeos/server/ai-engine.ts`
- `create_task`: Ensure forProfile linking is more aggressive - if the user says "for Jane Doe", the task must ONLY link to Jane, NOT also to Me/self
- `journal_entry`: Add forProfile support and linked_profiles setting
- `create_habit`: Add deduplication check - if habit with same name already exists for this profile, skip
- `create_obligation`: Check if the vitamins sub was blocked by dedup

### 2. `/home/user/workspace/lifeos/server/supabase-storage.ts`
- `rowToJournal()`: Add linkedProfiles: r.linked_profiles || []
- `updateJournalEntry()`: Include linked_profiles in update
- `createJournalEntry()`: Include linked_profiles in insert

### 3. `/home/user/workspace/lifeos/client/src/pages/dashboard.tsx`
- ActivitySection: Filter activity by selected profile IDs when filter is active
