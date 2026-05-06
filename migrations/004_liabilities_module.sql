-- Migration 004: Liabilities Module — Phase 1 Foundations
-- Introduces:
--   1. Profile type 'liability' (replaces 'loan' going forward; 'loan' remains
--      a valid profile_type alias so existing rows keep loading).
--   2. liability_asset_links — many-to-many between liabilities and assets,
--      with ownership_percentage (0..100) and an optional role.
--   3. liability_profile_links — many-to-many between liabilities and people/
--      pets/business profiles, with ownership_percentage and a role
--      (owner | co_signer | guarantor | responsible_party).
--   4. liability_payments — first-class payment rows (principal/interest/fees
--      split, payment source, optional document attachment, notes).
--   5. Soft migration: every existing profile of type='loan' is rewritten to
--      type='liability' with type_key inferred from existing fields.
--      Original loan rows are NOT deleted — type rename only, fields preserved.
--
-- IDEMPOTENT: safe to re-run. Uses IF NOT EXISTS / DO blocks where needed.
-- RLS: every new table mirrors the existing user_id = auth.uid() policy.

-- ============================================================================
-- 1. Update profile type CHECK to include 'liability'
-- ============================================================================
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%type%loan%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- (No re-add of CHECK constraint: profile.type is plain text and we want
-- forward-compatibility with new types. Validation happens in application
-- code via Zod.)

-- ============================================================================
-- 2. liability_asset_links — many-to-many (liability ↔ asset)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.liability_asset_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  liability_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  asset_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ownership_percentage numeric(6,3) DEFAULT 100 CHECK (ownership_percentage >= 0 AND ownership_percentage <= 100),
  allocation_amount numeric(18,2),  -- optional: hard $ allocation instead of %
  role text DEFAULT 'collateral',   -- collateral | improvement | shared
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (liability_profile_id, asset_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_lal_user ON public.liability_asset_links(user_id);
CREATE INDEX IF NOT EXISTS idx_lal_liability ON public.liability_asset_links(liability_profile_id);
CREATE INDEX IF NOT EXISTS idx_lal_asset ON public.liability_asset_links(asset_profile_id);

ALTER TABLE public.liability_asset_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own liability_asset_links" ON public.liability_asset_links;
CREATE POLICY "Users can view own liability_asset_links" ON public.liability_asset_links
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own liability_asset_links" ON public.liability_asset_links;
CREATE POLICY "Users can insert own liability_asset_links" ON public.liability_asset_links
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own liability_asset_links" ON public.liability_asset_links;
CREATE POLICY "Users can update own liability_asset_links" ON public.liability_asset_links
  FOR UPDATE USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own liability_asset_links" ON public.liability_asset_links;
CREATE POLICY "Users can delete own liability_asset_links" ON public.liability_asset_links
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 3. liability_profile_links — many-to-many (liability ↔ person/pet/business)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.liability_profile_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  liability_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  party_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ownership_percentage numeric(6,3) DEFAULT 100 CHECK (ownership_percentage >= 0 AND ownership_percentage <= 100),
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','co_signer','guarantor','responsible_party','authorized_user')),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (liability_profile_id, party_profile_id, role)
);

CREATE INDEX IF NOT EXISTS idx_lpl_user ON public.liability_profile_links(user_id);
CREATE INDEX IF NOT EXISTS idx_lpl_liability ON public.liability_profile_links(liability_profile_id);
CREATE INDEX IF NOT EXISTS idx_lpl_party ON public.liability_profile_links(party_profile_id);

ALTER TABLE public.liability_profile_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own liability_profile_links" ON public.liability_profile_links;
CREATE POLICY "Users can view own liability_profile_links" ON public.liability_profile_links
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own liability_profile_links" ON public.liability_profile_links;
CREATE POLICY "Users can insert own liability_profile_links" ON public.liability_profile_links
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own liability_profile_links" ON public.liability_profile_links;
CREATE POLICY "Users can update own liability_profile_links" ON public.liability_profile_links
  FOR UPDATE USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own liability_profile_links" ON public.liability_profile_links;
CREATE POLICY "Users can delete own liability_profile_links" ON public.liability_profile_links
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 4. liability_payments — first-class payment rows
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.liability_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  liability_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  payment_date date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount >= 0),
  principal_portion numeric(18,2) DEFAULT 0 CHECK (principal_portion >= 0),
  interest_portion numeric(18,2) DEFAULT 0 CHECK (interest_portion >= 0),
  fees numeric(18,2) DEFAULT 0 CHECK (fees >= 0),
  remaining_balance_after numeric(18,2),
  payment_type text NOT NULL DEFAULT 'standard' CHECK (payment_type IN ('standard','minimum','custom','extra_principal','interest_only','partial','payoff','reversal','deferred','skipped')),
  source_account text,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lp_user ON public.liability_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_lp_liability ON public.liability_payments(liability_profile_id);
CREATE INDEX IF NOT EXISTS idx_lp_date ON public.liability_payments(payment_date);

ALTER TABLE public.liability_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own liability_payments" ON public.liability_payments;
CREATE POLICY "Users can view own liability_payments" ON public.liability_payments
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own liability_payments" ON public.liability_payments;
CREATE POLICY "Users can insert own liability_payments" ON public.liability_payments
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own liability_payments" ON public.liability_payments;
CREATE POLICY "Users can update own liability_payments" ON public.liability_payments
  FOR UPDATE USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own liability_payments" ON public.liability_payments;
CREATE POLICY "Users can delete own liability_payments" ON public.liability_payments
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 5. Soft migration: type='loan' → type='liability' with inferred type_key
-- ============================================================================
-- We map the most common existing field shapes to a liability subtype.
-- Anything we can't map confidently goes to 'personal_loan' as the default
-- safe bucket. Field data is untouched; only `type` and `type_key` change.
--
-- IMPORTANT: This is reversible — we can always set type back to 'loan'.

UPDATE public.profiles
SET
  type = 'liability',
  type_key = COALESCE(
    NULLIF(type_key, ''),
    CASE
      WHEN lower(name) LIKE '%mortgage%' OR lower(coalesce(fields->>'lender','')) LIKE '%mortgage%' THEN 'mortgage'
      WHEN lower(name) LIKE '%auto%' OR lower(name) LIKE '%car loan%' OR lower(name) LIKE '%vehicle loan%' THEN 'auto_loan'
      WHEN lower(name) LIKE '%student%' THEN 'student_loan'
      WHEN lower(name) LIKE '%credit card%' OR lower(name) LIKE '%cc %' THEN 'credit_card'
      WHEN lower(name) LIKE '%medical%' THEN 'medical_debt'
      WHEN lower(name) LIKE '%business%' THEN 'business_loan'
      WHEN lower(name) LIKE '%tax%' THEN 'tax_debt'
      WHEN lower(name) LIKE '%line of credit%' OR lower(name) LIKE '%loc%' THEN 'line_of_credit'
      WHEN lower(name) LIKE '%bnpl%' OR lower(name) LIKE '%afterpay%' OR lower(name) LIKE '%klarna%' OR lower(name) LIKE '%affirm%' THEN 'bnpl'
      ELSE 'personal_loan'
    END
  ),
  updated_at = now()
WHERE type = 'loan' AND deleted_at IS NULL;
