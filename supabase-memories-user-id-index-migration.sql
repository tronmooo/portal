-- ============================================================
-- Migration — add user_id index to public.memories
-- Run against Supabase SQL Editor
-- ============================================================
--
-- Rationale: memories are always queried by user_id (RLS + app filter in
-- getMemories/recallMemory). pg_stat_user_tables showed public.memories at
-- 96.6% sequential scans (19,695 seq scans vs 696 index scans, 780k tuples
-- read) — every recall scanned the whole table. This partial index turns each
-- read into an index lookup and stays small by excluding soft-deleted rows.
--
-- Convention note: existing migrations in this repo run un-wrapped in the
-- Supabase SQL Editor (no transactional migration runner), so CONCURRENTLY is
-- not used here to stay consistent — the table is small enough that the brief
-- index-build lock is acceptable.

CREATE INDEX IF NOT EXISTS idx_memories_user_id
  ON public.memories (user_id)
  WHERE deleted_at IS NULL;
