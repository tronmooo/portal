-- Migration 20260615: Universal capture layer (PR Z)
--
-- Adds the `captures` table that backs the Universal Data Understanding
-- layer. Every chat message (and eventually every uploaded document, voice
-- note, sensor reading, etc.) becomes a Capture. Captures are the
-- system-of-record envelope: type + owner + title + raw_input +
-- structured_data + metadata + relationships + source + confidence.
-- Downstream typed rows (expenses, tracker entries, tasks, ...) are
-- "projections" attached to the capture they came from.
--
-- IDEMPOTENT: safe to re-run.

CREATE TABLE IF NOT EXISTS captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,

  -- Best guess at the entity type. Free-form text so the classifier can
  -- introduce new types without a schema change. Common values:
  -- expense, income, obligation, tracker_entry, tracker_create, task,
  -- event, reminder, habit, profile_fact, profile_create, asset,
  -- liability, document, medical_record, note, unknown.
  type text NOT NULL DEFAULT 'unknown',

  -- Short human-readable label.
  title text NOT NULL DEFAULT '',

  -- The raw input as received — NEVER mutated after insert. This is the
  -- "nothing is lost" guarantee.
  raw_input text NOT NULL,

  -- Best-effort extraction into named fields. May contain anything.
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Free-form extras (units, hints, source-specific blobs).
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Other entity ids this capture relates to. Each element:
  -- { "kind": "asset" | "vehicle" | "person" | ..., "id": "<uuid>", "label"?: "..." }
  relationships jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Where it came from: chat, document, api, voice, ...
  source text NOT NULL DEFAULT 'chat',

  -- Classifier confidence in [0, 1].
  confidence numeric(4,3) NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),

  -- pending | projected | dismissed | failed
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'projected', 'dismissed', 'failed')),

  -- Typed rows produced from this capture. Each element:
  -- { "kind": "expense" | "tracker_entry" | ..., "id": "<row id>", "at": "<iso>" }
  projections jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Optional follow-up question the AI wants to ask the user.
  clarifying_question text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Hot path: inbox view, ordered by recency, scoped to user.
CREATE INDEX IF NOT EXISTS captures_user_created_idx
  ON captures(user_id, created_at DESC);

-- Filter by status (pending inbox triage).
CREATE INDEX IF NOT EXISTS captures_user_status_idx
  ON captures(user_id, status, created_at DESC);

-- Filter by owner profile (per-person inbox view).
CREATE INDEX IF NOT EXISTS captures_user_owner_idx
  ON captures(user_id, owner_profile_id, created_at DESC)
  WHERE owner_profile_id IS NOT NULL;

-- Keep updated_at fresh on any patch.
CREATE OR REPLACE FUNCTION captures_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS captures_set_updated_at_trg ON captures;
CREATE TRIGGER captures_set_updated_at_trg
  BEFORE UPDATE ON captures
  FOR EACH ROW EXECUTE FUNCTION captures_set_updated_at();

-- RLS: mirror the user_id = auth.uid() pattern used by other tables.
ALTER TABLE captures ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'captures' AND policyname = 'captures_owner'
  ) THEN
    CREATE POLICY captures_owner ON captures
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
