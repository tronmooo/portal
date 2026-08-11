# Audit Fixes Summary — April 4, 2026

## CRITICAL

### C1: Income methods added to IStorage interface
**File:** `server/storage.ts`
- Added `Income` and `InsertIncome` to imports from `@shared/schema`
- Added 4 Income methods to `IStorage` interface: `getIncomes`, `createIncome`, `updateIncome`, `deleteIncome`
- Also added `restoreTask`, `restoreHabit`, `deleteHabitCheckin`, `migrateDocumentsToStorage` to the interface (were previously accessed via `storage as any` with typeof checks)
- Added corresponding stubs to `MemStorage` class (in-memory Map for Income, returns `false`/empty for restore/migrate stubs)

### C2: ANTHROPIC_API_KEY validation
**File:** `server/ai-engine.ts`
- `getClient()` now checks if `process.env.ANTHROPIC_API_KEY` exists before creating the Anthropic client
- Throws a clear error message if the key is missing

## HIGH

### H1: Entity link POST uses safeParse()
**File:** `server/routes.ts`
- Changed `insertEntityLinkSchema.parse(req.body)` to `.safeParse(req.body)`
- Added early return with 400 status on validation failure
- Updated downstream reference from `parsed` to `parsed.data`

### H2: Removed (storage as any) casts
**File:** `server/routes.ts`
- Replaced 4 income route casts: `(storage as any).getIncomes()` → `storage.getIncomes()`, etc.
- Replaced 4 restore/utility casts: `restoreTask`, `restoreHabit`, `deleteHabitCheckin`, `migrateDocumentsToStorage`
- Removed the `typeof (storage as any).method === 'function'` guard patterns since methods are now on the interface
- Remaining `(storage as any)` usages (audit log accessing `.supabase` and `.userId`) are SupabaseStorage-specific and intentionally left as-is per M4

### H3: JSON.parse() error handling
**File:** `server/routes.ts`
- Wrapped `JSON.parse(jsonStr)` for AI profile data (line ~942) in try/catch with `{}` default
- Wrapped `JSON.parse(jsonStr)` for AI digest data (line ~2613) in try/catch with `{}` default
- Wrapped `JSON.parse(stdout)` for calendar export result (line ~3075) in try/catch with `{}` default
- Verified lines 2218, 2332, 2917 were already in try/catch blocks

**File:** `server/ai-engine.ts`
- Verified lines 128, 602, 641, 3298 are all inside try/catch blocks — no changes needed

## MEDIUM

### M3: Other (storage as any) patterns
- All `(storage as any)` patterns have been resolved except the audit log route which accesses SupabaseStorage-specific `.supabase` and `.userId` properties (per M4, this is acceptable)

### Skipped (as instructed)
- M1: Supabase Storage bucket migration — known limitation
- M2: Google Calendar integration — feature gap
- M4: Audit log direct storage access — acceptable for in-memory log
- M5: API_BASE resolution — build config issue

## Verification
- `npx tsc --noEmit` passes with **zero errors**
