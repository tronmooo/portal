-- Migration 20260810: Income as a first-class finance object
--
-- Income becomes the positive mirror of a liability. Before this, `incomes`
-- held a description, an amount and a fuzzy `frequency` string that nothing
-- expanded — so a paycheck never produced dates, never reached the calendar,
-- and a month's cash flow only ever counted the money going OUT.
--
-- The model here is the one recurring liabilities already use (see
-- shared/liability-schedule.ts → shared/income-schedule.ts):
--
--   * ONE row per income SERIES. Its pay dates are DERIVED from the recurrence,
--     never stored — no occurrence table to migrate, backfill or drift.
--   * Per-occurrence exceptions ("skip December", "move this one to the 18th",
--     "this month it was $2,600") live in `fields.occurrences`, keyed by the
--     canonical YYYY-MM-DD date.
--   * Money that ACTUALLY LANDED lives in `income_receipts` — the mirror of
--     `liability_payments`. An occurrence with no receipt is still projected
--     money; that split is what keeps an unpaid future paycheck out of the
--     user's actual balance.
--
-- IDEMPOTENT: safe to re-run.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. incomes — grow the row into a series
-- ────────────────────────────────────────────────────────────────────────────

-- Series anchor. Every occurrence is generated FROM this date, so it must stay
-- fixed even as pay dates come and go (`date` was being treated as "the" date).
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS start_date date;
-- Hard end of the series. Deleting "all future payments" sets this rather than
-- dropping the row, so already-received paychecks keep their history.
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS recurrence_end date;
-- What KIND of money-in this is (paycheck / rental / investment / refund …).
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS source_type text;
-- Series lifecycle: active | paused | ended. Individual pay dates carry their
-- own status inside `fields.occurrences`.
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'usd';
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS notes text;
-- Attribution beyond the people in linked_profiles: the employer/client/tenant
-- who pays it, the account it lands in, and the asset or investment producing
-- it. All profile references, all optional.
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS payer_profile_id uuid;
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS linked_account_id uuid;
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS linked_asset_id uuid;
-- Per-occurrence exceptions + series settings (paused, pausedUntil, count,
-- secondDay for twice-a-month). Shape documented in shared/income-schedule.ts.
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incomes_status_check'
  ) THEN
    ALTER TABLE incomes ADD CONSTRAINT incomes_status_check
      CHECK (status IN ('active', 'paused', 'ended'));
  END IF;
END $$;

-- Profile references are intentionally ON DELETE SET NULL: losing the employer
-- profile must not delete the income history that came from it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'profiles') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incomes_payer_profile_fk') THEN
      ALTER TABLE incomes ADD CONSTRAINT incomes_payer_profile_fk
        FOREIGN KEY (payer_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incomes_linked_account_fk') THEN
      ALTER TABLE incomes ADD CONSTRAINT incomes_linked_account_fk
        FOREIGN KEY (linked_account_id) REFERENCES profiles(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incomes_linked_asset_fk') THEN
      ALTER TABLE incomes ADD CONSTRAINT incomes_linked_asset_fk
        FOREIGN KEY (linked_asset_id) REFERENCES profiles(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- Backfill: every existing income keeps working. Its stored `date` becomes the
-- series anchor; rows that never had one anchor on their creation date so they
-- generate occurrences instead of silently producing none.
UPDATE incomes
   SET start_date = COALESCE(date, created_at::date)
 WHERE start_date IS NULL;

-- Legacy rows carried frequency strings the occurrence engine doesn't know
-- ('one-time', 'bi-weekly', 'annual', …). Canonicalize the common spellings so
-- the schedule generator sees the tokens it expects.
UPDATE incomes SET frequency = 'once'
 WHERE lower(coalesce(frequency, '')) IN ('one-time', 'onetime', 'one_time', 'single', 'none');
UPDATE incomes SET frequency = 'biweekly'
 WHERE lower(coalesce(frequency, '')) IN ('bi-weekly', 'fortnightly', 'every other week', 'every-2-weeks');
UPDATE incomes SET frequency = 'semimonthly'
 WHERE lower(coalesce(frequency, '')) IN ('semi-monthly', 'twice monthly', 'twice a month');
UPDATE incomes SET frequency = 'yearly'
 WHERE lower(coalesce(frequency, '')) IN ('annual', 'annually', 'every year');
UPDATE incomes SET frequency = 'monthly'
 WHERE frequency IS NULL OR btrim(frequency) = '';

-- Best-effort source_type from the category already on the row. Anything that
-- doesn't map stays NULL rather than being guessed into the wrong bucket.
UPDATE incomes SET source_type = CASE lower(coalesce(category, ''))
    WHEN 'salary'     THEN 'paycheck'
    WHEN 'paycheck'   THEN 'paycheck'
    WHEN 'wages'      THEN 'paycheck'
    WHEN 'freelance'  THEN 'freelance'
    WHEN 'contract'   THEN 'freelance'
    WHEN 'rent'       THEN 'rental'
    WHEN 'rental'     THEN 'rental'
    WHEN 'investment' THEN 'investment'
    WHEN 'dividend'   THEN 'investment'
    WHEN 'dividends'  THEN 'investment'
    WHEN 'interest'   THEN 'investment'
    WHEN 'pension'    THEN 'pension'
    WHEN 'bonus'      THEN 'bonus'
    WHEN 'refund'     THEN 'refund'
    WHEN 'gift'       THEN 'gift'
    ELSE NULL
  END
 WHERE source_type IS NULL;

-- The calendar and the month's cash flow both scan income by date.
CREATE INDEX IF NOT EXISTS idx_incomes_user_start_date
  ON incomes (user_id, start_date)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incomes_payer_profile
  ON incomes (payer_profile_id) WHERE payer_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incomes_linked_account
  ON incomes (linked_account_id) WHERE linked_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incomes_linked_asset
  ON incomes (linked_asset_id) WHERE linked_asset_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. income_receipts — money that ACTUALLY landed
-- ────────────────────────────────────────────────────────────────────────────
-- The mirror of `liability_payments`. One row per deposit that really happened.
-- `occurrence_date` links the receipt back to the canonical series date it
-- settles, so "the Aug 14 paycheck arrived on Aug 15" stays one occurrence
-- rather than becoming two.
CREATE TABLE IF NOT EXISTS income_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  income_id uuid NOT NULL REFERENCES incomes(id) ON DELETE CASCADE,

  -- Canonical (unshifted) series date this receipt settles. NULL for an ad-hoc
  -- deposit that isn't part of the schedule.
  occurrence_date date,
  -- The day the money actually arrived.
  received_date date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),

  deposit_account text,
  method text,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_income_receipts_user_income
  ON income_receipts (user_id, income_id);
CREATE INDEX IF NOT EXISTS idx_income_receipts_received_date
  ON income_receipts (user_id, received_date);

-- One receipt per scheduled occurrence: marking the same paycheck received
-- twice must not double the month's actual income.
CREATE UNIQUE INDEX IF NOT EXISTS uq_income_receipts_occurrence
  ON income_receipts (income_id, occurrence_date)
  WHERE occurrence_date IS NOT NULL;

ALTER TABLE income_receipts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='income_receipts' AND policyname='income_receipts_select_own') THEN
    CREATE POLICY income_receipts_select_own ON public.income_receipts
      FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='income_receipts' AND policyname='income_receipts_insert_own') THEN
    CREATE POLICY income_receipts_insert_own ON public.income_receipts
      FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='income_receipts' AND policyname='income_receipts_update_own') THEN
    CREATE POLICY income_receipts_update_own ON public.income_receipts
      FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='income_receipts' AND policyname='income_receipts_delete_own') THEN
    CREATE POLICY income_receipts_delete_own ON public.income_receipts
      FOR DELETE TO authenticated USING (user_id = auth.uid());
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Profile-delete cascade
-- ────────────────────────────────────────────────────────────────────────────
-- `incomes` already participates in delete_profile_cascade (migration 009):
-- sole-owner rows soft-delete, co-owned rows are unlinked. The new profile
-- pointers are ON DELETE SET NULL above, so deleting an employer detaches the
-- income rather than destroying the user's earnings history.
