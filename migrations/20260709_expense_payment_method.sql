-- QA 2026-07-09 #3: "paid with Chase Sapphire" was silently dropped — the
-- expenses table had nowhere to store a payment method. Additive and
-- idempotent — safe to run against existing data.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS payment_method TEXT;
