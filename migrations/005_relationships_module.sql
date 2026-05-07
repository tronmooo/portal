-- Migration 005: Flexible Relationship Model
-- Adds:
--   1. asset_party_links — many-to-many between assets and people/businesses,
--      with ownership_percentage and role.
--   2. ownership_history — append-only log of every link/ownership change
--      across all 3 link tables. Used by the History tab and undo.
--
-- IDEMPOTENT: safe to re-run.

-- ============================================================================
-- 1. asset_party_links — many-to-many (asset ↔ person/pet/business)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.asset_party_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  party_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ownership_percentage numeric(6,3) DEFAULT 100 CHECK (ownership_percentage >= 0 AND ownership_percentage <= 100),
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','co_owner','beneficiary','trustee','custodian','authorized_user')),
  effective_from timestamptz,
  effective_to timestamptz,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (asset_profile_id, party_profile_id, role)
);

CREATE INDEX IF NOT EXISTS idx_apl_user ON public.asset_party_links(user_id);
CREATE INDEX IF NOT EXISTS idx_apl_asset ON public.asset_party_links(asset_profile_id);
CREATE INDEX IF NOT EXISTS idx_apl_party ON public.asset_party_links(party_profile_id);

ALTER TABLE public.asset_party_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own asset_party_links" ON public.asset_party_links;
CREATE POLICY "Users can view own asset_party_links" ON public.asset_party_links
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own asset_party_links" ON public.asset_party_links;
CREATE POLICY "Users can insert own asset_party_links" ON public.asset_party_links
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own asset_party_links" ON public.asset_party_links;
CREATE POLICY "Users can update own asset_party_links" ON public.asset_party_links
  FOR UPDATE USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own asset_party_links" ON public.asset_party_links;
CREATE POLICY "Users can delete own asset_party_links" ON public.asset_party_links
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 2. ownership_history — append-only audit log
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ownership_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  link_kind text NOT NULL CHECK (link_kind IN ('asset_party','liability_party','liability_asset')),
  link_id uuid,                         -- the row in the corresponding link table; nullable for deletes
  subject_id uuid,                      -- the asset or liability the link is "about"
  counterparty_id uuid,                 -- the party or asset on the other side of the link
  action text NOT NULL CHECK (action IN ('create','update','delete','move')),
  field_changed text,                   -- 'ownership_percentage', 'role', 'asset_profile_id' (move), null on create/delete
  old_value text,
  new_value text,
  changed_by text NOT NULL DEFAULT 'user',  -- 'user' | 'ai'
  note text,
  changed_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oh_user ON public.ownership_history(user_id);
CREATE INDEX IF NOT EXISTS idx_oh_subject ON public.ownership_history(subject_id);
CREATE INDEX IF NOT EXISTS idx_oh_counterparty ON public.ownership_history(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_oh_changed_at ON public.ownership_history(changed_at DESC);

ALTER TABLE public.ownership_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own ownership_history" ON public.ownership_history;
CREATE POLICY "Users can view own ownership_history" ON public.ownership_history
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own ownership_history" ON public.ownership_history;
CREATE POLICY "Users can insert own ownership_history" ON public.ownership_history
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own ownership_history" ON public.ownership_history;
CREATE POLICY "Users can update own ownership_history" ON public.ownership_history
  FOR UPDATE USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own ownership_history" ON public.ownership_history;
CREATE POLICY "Users can delete own ownership_history" ON public.ownership_history
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 3. Backfill asset_party_links from existing profiles.linked_profiles arrays
-- Each (asset, person) pair gets a 100% sole-owner row. Idempotent.
-- ============================================================================
DO $$
DECLARE
  asset_row RECORD;
  party_id uuid;
  party_type text;
BEGIN
  FOR asset_row IN
    SELECT id, user_id, linked_profiles
    FROM public.profiles
    WHERE type IN ('asset','vehicle','property')
      AND deleted_at IS NULL
      AND linked_profiles IS NOT NULL
      AND array_length(linked_profiles, 1) > 0
  LOOP
    FOREACH party_id IN ARRAY asset_row.linked_profiles LOOP
      SELECT type INTO party_type FROM public.profiles WHERE id = party_id AND deleted_at IS NULL;
      IF party_type IN ('person','self','pet','business') THEN
        INSERT INTO public.asset_party_links (user_id, asset_profile_id, party_profile_id, ownership_percentage, role)
        VALUES (asset_row.user_id, asset_row.id, party_id, 100, 'owner')
        ON CONFLICT (asset_profile_id, party_profile_id, role) DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END $$;
