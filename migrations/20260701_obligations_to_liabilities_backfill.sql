-- Retire Obligations → Type-Aware Liabilities (Phase 1: backfill, idempotent)
--
-- Every active obligation already links to a liability profile (linked_liability_id,
-- created by the earlier bills→liability sync). This migration folds the obligation's
-- recurrence + amount onto that liability profile and moves its payment history into
-- liability_payments. Phase 2 (separate migration) drops the obligation tables once
-- the counts reconcile.
--
-- Idempotent: re-running only fills gaps (COALESCE on type_key, jsonb_strip_nulls on
-- fields, NOT EXISTS marker on payment moves).

-- 1) Type + recurrence + amount onto the linked liability profile.
--    Mapping keeps every folded obligation in a RECURRING family (utility /
--    subscription / bill) so it is excluded from net-worth debt and never
--    fabricates an amortization schedule.
UPDATE profiles p
SET
  type_key = COALESCE(p.type_key,
    CASE
      WHEN o.kind = 'subscription' OR lower(o.category) = 'subscription' THEN 'subscription'
      WHEN lower(o.category) IN ('utilities', 'utility') THEN 'utility'
      ELSE 'bill'
    END),
  fields = COALESCE(p.fields, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'monthlyAmount', o.amount,
    'amount', o.amount,
    'autopay', o.autopay,
    'billingFrequency', o.frequency,
    'frequency', o.frequency,
    'dueDate', to_char(o.next_due_date, 'YYYY-MM-DD'),
    'nextDueDate', to_char(o.next_due_date, 'YYYY-MM-DD'),
    'source', 'obligation'
  )),
  updated_at = now()
FROM obligations o
WHERE o.linked_liability_id = p.id
  AND o.deleted_at IS NULL
  AND p.type = 'liability';

-- 2) Move obligation payment history into liability_payments (deduped by marker).
INSERT INTO liability_payments (
  user_id, liability_profile_id, payment_date, amount,
  principal_portion, interest_portion, payment_type, source_account, notes, created_at
)
SELECT
  op.user_id,
  o.linked_liability_id,
  COALESCE(
    (CASE WHEN op.date ~ '^\d{4}-\d{2}-\d{2}' THEN left(op.date, 10)::date END),
    op.created_at::date
  ),
  op.amount,
  op.amount,          -- recurring bills: full amount is principal, no interest
  0,
  'standard',
  op.method,
  'migrated:obligation_payment:' || op.id::text,
  op.created_at
FROM obligation_payments op
JOIN obligations o ON o.id = op.obligation_id
WHERE o.linked_liability_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM liability_payments lp
    WHERE lp.notes = 'migrated:obligation_payment:' || op.id::text
  );
