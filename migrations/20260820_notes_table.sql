-- Migration 20260820: NOTES GET THEIR OWN TABLE
--
-- User rule (2026-08-20): "I don't want notes to be stored as an artifact —
-- they do not belong in the same category."
--
-- Notes were stored as `artifacts` rows of type 'note' because artifacts were
-- already profile-linked, searchable and shareable. That made a note an
-- artifact everywhere it mattered: it counted on the Artifacts tab, it shared
-- the artifact CRUD surface, and the AI's action cards called it one. A note is
-- reference information, not something the user asked to have built, so it now
-- has its own table with its own CRUD.
--
-- The move preserves note IDs, so every existing link, undo ledger entry and
-- deep link keeps working.
--
-- IDEMPOTENT: safe to re-run. Re-running after the artifacts rows are gone
-- copies nothing and deletes nothing.

CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title text NOT NULL DEFAULT '',
  -- The note body. Plain text or markdown — a note is never HTML, code, a
  -- chart or a grid; those are artifacts.
  content text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Same ownership representation as every other owned entity (see
  -- shared/ownership.ts): a JSONB array of profile ids.
  linked_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  pinned boolean NOT NULL DEFAULT false,
  -- Which door wrote it: chat | manual | ai.
  source text NOT NULL DEFAULT 'manual',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Hot path: the notes list, newest first, scoped to the user.
CREATE INDEX IF NOT EXISTS notes_user_updated_idx
  ON notes(user_id, updated_at DESC);

-- Profile-scope pushdown: linked_profiles @> jsonb_build_array(<pid>).
-- Mirrors the GIN indexes 20260717 built for every other linked_profiles
-- column (jsonb_path_ops — smallest/fastest index specialised for @>).
CREATE INDEX IF NOT EXISTS notes_linked_profiles_gin_idx
  ON notes USING gin (linked_profiles jsonb_path_ops);

-- Keep updated_at fresh on any patch.
CREATE OR REPLACE FUNCTION notes_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_set_updated_at_trg ON notes;
CREATE TRIGGER notes_set_updated_at_trg
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_set_updated_at();

-- RLS: the user_id = auth.uid() pattern every other table uses.
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notes' AND policyname = 'notes_owner'
  ) THEN
    CREATE POLICY notes_owner ON notes
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- ── Backfill: move every artifact of type 'note' into notes ────────────────
--
-- IDs are preserved. The insert runs first and the delete second, both inside
-- this migration's transaction, so a note can never exist in neither table.
INSERT INTO notes (id, user_id, title, content, tags, linked_profiles, pinned, source, created_at, updated_at)
SELECT
  a.id,
  a.user_id,
  COALESCE(NULLIF(a.title, ''), 'Note'),
  COALESCE(a.content, ''),
  COALESCE(a.tags, '[]'::jsonb),
  COALESCE(a.linked_profiles, '[]'::jsonb),
  COALESCE(a.pinned, false),
  COALESCE(a.metadata->>'source', 'manual'),
  COALESCE(a.created_at, now()),
  COALESCE(a.updated_at, now())
FROM artifacts a
WHERE a.type = 'note'
ON CONFLICT (id) DO NOTHING;

-- The junction rows pointed at artifacts that are about to disappear; the FK
-- is ON DELETE CASCADE, but drop them explicitly so the intent is on the
-- record. (profile_artifacts may already have been dropped — hence the guard.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'profile_artifacts') THEN
    DELETE FROM profile_artifacts pa
    USING artifacts a
    WHERE pa.artifact_id = a.id AND a.type = 'note';
  END IF;
END $$;

DELETE FROM artifacts WHERE type = 'note';

-- A note can no longer be written as an artifact — the category is closed.
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check
  CHECK (type IN ('checklist', 'markdown', 'code', 'html', 'react', 'svg', 'mermaid', 'chart', 'doc', 'sheet'));
