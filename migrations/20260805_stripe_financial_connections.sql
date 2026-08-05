-- Migration 20260805: Stripe Financial Connections
--
-- Adds the normalized store for bank data imported through Stripe Financial
-- Connections. Nothing here replaces the existing manual finance model
-- (profiles of type asset/liability, expenses, incomes, budgets); connected
-- data lives alongside it and is reconciled through
-- `financial_accounts.matched_profile_id`.
--
-- MONEY CONVENTION (canonical — see shared/money.ts):
--   * Every monetary column below is a BIGINT in the currency's MINOR UNIT
--     (cents for USD). Never a float. Never a decimal string.
--   * SIGN: positive = money ENTERING the account, negative = money LEAVING it.
--     Stripe's Financial Connections transaction amounts already follow this
--     convention for cash accounts; ingestion normalizes credit accounts so the
--     same rule holds everywhere (see server/finance-sync.ts:normalizeAmount).
--   * Balances: `current_balance` is signed from the ACCOUNT HOLDER's point of
--     view — positive for cash the user owns, NEGATIVE for debt the user owes.
--     Stripe reports credit balances as a positive "used" figure; ingestion
--     flips the sign so a single SUM() over financial_accounts is net worth.
--
-- IDEMPOTENT: safe to re-run.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. stripe_account_holders — server-maintained user_id ↔ Stripe customer map
-- ────────────────────────────────────────────────────────────────────────────
-- The ONLY trusted link between a Portol user and a Stripe customer. Webhooks
-- and session callbacks resolve the owning user through this table rather than
-- trusting client-supplied ids or unverified webhook metadata.
CREATE TABLE IF NOT EXISTS stripe_account_holders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  livemode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. financial_connections — one row per Financial Connections authorization
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Stripe customer acting as the account holder for this session.
  stripe_account_holder_id text NOT NULL,
  -- The Financial Connections Session that produced this connection.
  stripe_session_id text,

  institution_name text,

  -- connecting | active | action_required | disconnected | failed
  connection_status text NOT NULL DEFAULT 'connecting'
    CHECK (connection_status IN ('connecting', 'active', 'action_required', 'disconnected', 'failed')),

  last_successful_sync_at timestamptz,
  last_attempted_sync_at timestamptz,
  -- success | partial | failed | null (never attempted)
  last_sync_status text CHECK (last_sync_status IN ('success', 'partial', 'failed')),
  -- Operator-facing error CODE only. Never a raw Stripe message, never a stack.
  last_sync_error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_connections_user_session_uniq
  ON financial_connections(user_id, stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_connections_user_idx
  ON financial_connections(user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. financial_accounts — one row per authorized external account
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  financial_connection_id uuid REFERENCES financial_connections(id) ON DELETE SET NULL,

  stripe_financial_connections_account_id text NOT NULL,

  institution_name text,
  -- Raw institution-provided name.
  account_name text,
  -- What Portol renders. User-editable; sync never overwrites it once set.
  account_display_name text,

  -- Stripe `category`: cash | credit | investment | other
  account_category text,
  -- Stripe `subcategory`: checking | savings | mortgage | line_of_credit | credit_card | other
  account_subcategory text,
  -- Portol's coarse bucket derived from the two above: depository | credit | loan | investment | other
  account_type text,

  last_four text,
  currency text NOT NULL DEFAULT 'usd',

  -- BIGINT minor units. Signed from the holder's perspective (see header).
  current_balance bigint,
  available_balance bigint,
  balance_as_of timestamptz,

  -- Stripe `status`: active | inactive | disconnected. `action_required` is
  -- Portol's own state for status_details.active.action = relink_required.
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'disconnected', 'action_required')),

  is_hidden boolean NOT NULL DEFAULT false,
  include_in_net_worth boolean NOT NULL DEFAULT true,

  -- Manual↔connected reconciliation. When set, the manual profile is the SAME
  -- real-world account: the connected balance is the live source and the
  -- manual record is excluded from net worth to prevent double counting.
  matched_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,

  -- Stripe permissions actually granted for this account (balances,
  -- transactions, ownership, payment_method). Drives "no permission" messaging.
  permissions text[] NOT NULL DEFAULT '{}',
  -- Refresh subscriptions Stripe is maintaining for us (currently: transactions).
  subscriptions text[] NOT NULL DEFAULT '{}',

  -- Latest transaction_refresh id, so incremental syncs can ask Stripe for
  -- "everything changed after this refresh" instead of re-walking history.
  last_transaction_refresh_id text,

  -- Why the account needs attention, when it does: access_expired |
  -- institution_requirement | unspecified.
  inactive_cause text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Duplicate protection (required): the same Stripe account can only exist once
-- per user, no matter how many times it is re-authorized.
CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_user_stripe_uniq
  ON financial_accounts(user_id, stripe_financial_connections_account_id);
CREATE INDEX IF NOT EXISTS financial_accounts_user_idx
  ON financial_accounts(user_id, status);
CREATE INDEX IF NOT EXISTS financial_accounts_connection_idx
  ON financial_accounts(financial_connection_id);
CREATE INDEX IF NOT EXISTS financial_accounts_matched_profile_idx
  ON financial_accounts(matched_profile_id) WHERE matched_profile_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. financial_transactions — imported bank transactions (source of truth)
-- ────────────────────────────────────────────────────────────────────────────
-- IMPORTANT: rows here mirror what the institution reported. User corrections
-- live in financial_transaction_overrides so a later sync can refresh this
-- table freely without destroying anything the user typed.
CREATE TABLE IF NOT EXISTS financial_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  financial_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,

  stripe_transaction_id text NOT NULL,

  transaction_date date NOT NULL,
  posted_at timestamptz,

  description text,
  merchant_name text,

  -- BIGINT minor units, signed: positive = into the account, negative = out.
  amount bigint NOT NULL,
  currency text NOT NULL DEFAULT 'usd',

  -- debit | credit — derived from the sign, stored for query convenience.
  transaction_type text CHECK (transaction_type IN ('debit', 'credit')),
  -- Stripe status: pending | posted | void
  status text NOT NULL DEFAULT 'posted',

  category text,
  subcategory text,

  -- Classification flags. These are the SYNC's best guess; the overrides table
  -- wins wherever the user disagreed.
  is_income boolean NOT NULL DEFAULT false,
  is_expense boolean NOT NULL DEFAULT false,
  is_transfer boolean NOT NULL DEFAULT false,
  is_refund boolean NOT NULL DEFAULT false,
  is_duplicate boolean NOT NULL DEFAULT false,
  excluded_from_totals boolean NOT NULL DEFAULT false,

  -- manual | stripe_financial_connections | document_extraction | ai_created | imported
  source text NOT NULL DEFAULT 'stripe_financial_connections',

  -- Non-sensitive Stripe echo (ids, refresh token, status transitions). Never
  -- credentials, never tokens that could be replayed against an institution.
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Duplicate protection (required).
CREATE UNIQUE INDEX IF NOT EXISTS financial_transactions_user_stripe_uniq
  ON financial_transactions(user_id, stripe_transaction_id);
CREATE INDEX IF NOT EXISTS financial_transactions_user_date_idx
  ON financial_transactions(user_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS financial_transactions_account_date_idx
  ON financial_transactions(financial_account_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS financial_transactions_merchant_idx
  ON financial_transactions(user_id, merchant_name);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. financial_transaction_overrides — user corrections, kept OUT of the
--    imported rows so re-sync never clobbers them
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_transaction_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  financial_transaction_id uuid NOT NULL REFERENCES financial_transactions(id) ON DELETE CASCADE,

  -- NULL means "no opinion" — fall back to the imported value.
  category text,
  subcategory text,
  merchant_name text,
  is_income boolean,
  is_expense boolean,
  is_transfer boolean,
  is_refund boolean,
  excluded_from_totals boolean,
  note text,

  -- Attachments to the rest of Portol. Each points at a profile row (assets,
  -- liabilities, subscriptions and people are all profiles) or a budget month.
  linked_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  linked_subscription_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  linked_liability_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  linked_asset_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  budget_category text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_transaction_overrides_txn_uniq
  ON financial_transaction_overrides(financial_transaction_id);
CREATE INDEX IF NOT EXISTS financial_transaction_overrides_user_idx
  ON financial_transaction_overrides(user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. financial_transfer_links — detected internal transfers
-- ────────────────────────────────────────────────────────────────────────────
-- Detection NEVER merges or deletes either side. It records a candidate pair
-- that the user can confirm or reject; only a confirmed (or auto-confirmed,
-- high-confidence) link removes the pair from spending/income totals.
CREATE TABLE IF NOT EXISTS financial_transfer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transfer_group_id uuid NOT NULL DEFAULT gen_random_uuid(),

  outflow_transaction_id uuid NOT NULL REFERENCES financial_transactions(id) ON DELETE CASCADE,
  inflow_transaction_id uuid NOT NULL REFERENCES financial_transactions(id) ON DELETE CASCADE,

  -- 0..1 — how sure the matcher is. Only >= 0.9 is auto-applied to totals.
  confidence numeric(4, 3) NOT NULL DEFAULT 0,
  -- detected | confirmed | rejected
  state text NOT NULL DEFAULT 'detected'
    CHECK (state IN ('detected', 'confirmed', 'rejected')),
  -- Which signals fired, for the "why is this a transfer?" explanation.
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_transfer_links_pair_uniq
  ON financial_transfer_links(outflow_transaction_id, inflow_transaction_id);
CREATE INDEX IF NOT EXISTS financial_transfer_links_user_idx
  ON financial_transfer_links(user_id, state);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. finance_sync_runs — synchronization history
-- ────────────────────────────────────────────────────────────────────────────
-- NEVER stores credentials, tokens, or raw institution payloads.
CREATE TABLE IF NOT EXISTS finance_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  financial_connection_id uuid REFERENCES financial_connections(id) ON DELETE CASCADE,

  -- initial | manual | scheduled | webhook | relink
  sync_type text NOT NULL
    CHECK (sync_type IN ('initial', 'manual', 'scheduled', 'webhook', 'relink')),

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  -- running | success | partial | failed
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failed')),

  accounts_processed integer NOT NULL DEFAULT 0,
  transactions_inserted integer NOT NULL DEFAULT 0,
  transactions_updated integer NOT NULL DEFAULT 0,

  error_code text,
  error_message text
);

CREATE INDEX IF NOT EXISTS finance_sync_runs_user_idx
  ON finance_sync_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS finance_sync_runs_connection_idx
  ON finance_sync_runs(financial_connection_id, started_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. finance_webhook_events — webhook idempotency ledger
-- ────────────────────────────────────────────────────────────────────────────
-- No user_id: written by the webhook handler with the service role BEFORE the
-- owning user is resolved. Not user data — it holds only Stripe event ids and
-- processing outcomes. RLS denies all client access (no policy = deny).
CREATE TABLE IF NOT EXISTS finance_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  -- received | processed | ignored | failed
  status text NOT NULL DEFAULT 'received',
  error_code text
);

CREATE INDEX IF NOT EXISTS finance_webhook_events_received_idx
  ON finance_webhook_events(received_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Row Level Security
-- ────────────────────────────────────────────────────────────────────────────
-- Every table denies by default and is opened ONLY to rows the caller owns.
-- The service role (used by the Express server after it has verified the
-- Supabase JWT itself) bypasses RLS; these policies are the second line of
-- defence for any direct-from-browser access.

ALTER TABLE stripe_account_holders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_connections             ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_accounts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_transaction_overrides   ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_transfer_links          ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_sync_runs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_webhook_events            ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  -- Tables with an explicit user_id column get the four standard policies.
  owned_tables text[] := ARRAY[
    'stripe_account_holders',
    'financial_connections',
    'financial_accounts',
    'financial_transactions',
    'financial_transaction_overrides',
    'financial_transfer_links',
    'finance_sync_runs'
  ];
BEGIN
  FOREACH t IN ARRAY owned_tables LOOP
    -- SELECT
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_select_own') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = auth.uid())',
        t||'_select_own', t);
    END IF;
    -- INSERT — WITH CHECK stops a client from stamping someone else's user_id.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_insert_own') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())',
        t||'_insert_own', t);
    END IF;
    -- UPDATE — USING gates which rows are visible to update, WITH CHECK stops
    -- a row being re-parented to another user on the way out.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_update_own') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
        t||'_update_own', t);
    END IF;
    -- DELETE
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||'_delete_own') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (user_id = auth.uid())',
        t||'_delete_own', t);
    END IF;
  END LOOP;
END $$;

-- finance_webhook_events deliberately has NO policy: RLS with zero policies
-- denies every authenticated request. Only the service role can touch it.

-- ────────────────────────────────────────────────────────────────────────────
-- 10. updated_at maintenance
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finance_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
  touched text[] := ARRAY[
    'stripe_account_holders',
    'financial_connections',
    'financial_accounts',
    'financial_transactions',
    'financial_transaction_overrides',
    'financial_transfer_links'
  ];
BEGIN
  FOREACH t IN ARRAY touched LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = t || '_touch_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at()',
        t || '_touch_updated_at', t);
    END IF;
  END LOOP;
END $$;
