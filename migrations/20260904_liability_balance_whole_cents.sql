-- D284: a payment's balance-after was written unrounded, so a few liabilities
-- carry sub-cent float noise (5314.889999999999). Round every balance
-- spelling a liability stores to cents; only rows that actually differ move.
UPDATE profiles
SET fields = fields
  || CASE WHEN fields ? 'currentBalance' AND nullif(fields->>'currentBalance','') IS NOT NULL
          THEN jsonb_build_object('currentBalance', round((fields->>'currentBalance')::numeric, 2)) ELSE '{}'::jsonb END
  || CASE WHEN fields ? 'remainingBalance' AND nullif(fields->>'remainingBalance','') IS NOT NULL
          THEN jsonb_build_object('remainingBalance', round((fields->>'remainingBalance')::numeric, 2)) ELSE '{}'::jsonb END
  || CASE WHEN fields ? 'loanBalance' AND nullif(fields->>'loanBalance','') IS NOT NULL
          THEN jsonb_build_object('loanBalance', round((fields->>'loanBalance')::numeric, 2)) ELSE '{}'::jsonb END
  || CASE WHEN fields ? 'balance' AND nullif(fields->>'balance','') IS NOT NULL
          THEN jsonb_build_object('balance', round((fields->>'balance')::numeric, 2)) ELSE '{}'::jsonb END
WHERE type IN ('liability','loan')
  AND (
    (nullif(fields->>'currentBalance','') IS NOT NULL AND (fields->>'currentBalance')::numeric * 100 <> round((fields->>'currentBalance')::numeric * 100))
    OR (nullif(fields->>'remainingBalance','') IS NOT NULL AND (fields->>'remainingBalance')::numeric * 100 <> round((fields->>'remainingBalance')::numeric * 100))
    OR (nullif(fields->>'loanBalance','') IS NOT NULL AND (fields->>'loanBalance')::numeric * 100 <> round((fields->>'loanBalance')::numeric * 100))
    OR (nullif(fields->>'balance','') IS NOT NULL AND (fields->>'balance')::numeric * 100 <> round((fields->>'balance')::numeric * 100))
  );
