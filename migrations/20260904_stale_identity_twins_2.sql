-- D269 (second form): rows with no `balance` whose pipeline spellings
-- disagree — an older extra-principal path updated currentBalance alone, so
-- remainingBalance/loanBalance kept the pre-payment figure and the money tab's
-- "Remaining" row disagreed with the loan page. currentBalance is the spelling
-- every payment writes; the disagreeing twins go.
UPDATE profiles SET fields = fields - 'remainingBalance' - 'loanBalance' - 'outstandingBalance'
WHERE NOT (fields ? 'balance') AND fields ? 'currentBalance' AND fields->>'currentBalance' <> ''
  AND ((fields ? 'remainingBalance' AND fields->>'remainingBalance' IS DISTINCT FROM fields->>'currentBalance')
    OR (fields ? 'loanBalance' AND fields->>'loanBalance' IS DISTINCT FROM fields->>'currentBalance')
    OR (fields ? 'outstandingBalance' AND fields->>'outstandingBalance' IS DISTINCT FROM fields->>'currentBalance'));
