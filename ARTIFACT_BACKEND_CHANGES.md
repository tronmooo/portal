# Backend Artifact System Changes

## Files Modified

### 1. `/server/ai-engine.ts` — System Prompt (line ~2270)
- Modified `buildSystemPrompt(context, selfProfileId?)` to accept optional `selfProfileId` parameter
- Appended full artifact system prompt section at end of system prompt string (after date rules, before closing backtick)
- Covers: when to create artifacts, format spec, registered types, data rules

### 2. `/server/ai-engine.ts` — Artifact Parser (line ~5501)
- Added `ARTIFACT_REGEX` constant and `parseArtifactFromResponse()` function before `processMessage`
- Extracts `<portol_artifact>` blocks, validates required fields (id, type, title, data), enforces profile isolation
- Returns `{ chatText, artifact }` — chatText has the artifact block stripped out

### 3. `/server/ai-engine.ts` — Response Integration (line ~6076)
- Added `selfProfileId` derivation from profiles array (line 5769)
- Pass `selfProfileId` to `buildSystemPrompt()` 
- Added `artifact?: any` to `processMessage` return type
- Before returning, calls `parseArtifactFromResponse()` on textReply
- If artifact found, persists to `chat_artifacts` table via Supabase upsert
- Includes `artifact` in return object

### 4. `/server/routes.ts` — API Routes (line ~3725)
- `GET /api/chat-artifacts` — Lists all artifacts for current user, optional `?profileId=` filter
- `DELETE /api/chat-artifacts/:id` — Deletes an artifact by ID (scoped to user_id)
- Both use `(storage as any).supabase` and `(storage as any).userId` pattern consistent with existing routes
