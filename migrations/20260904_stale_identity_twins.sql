-- D269: the D265 repair promoted a registry alias (current_balance) into the
-- model key (balance) without sweeping the row's other spellings of the same
-- fact, as every write through the storage layer does (shared/profile-field-
-- identity). One production loan ended with balance: 25000 beside stale
-- currentBalance: 0 / remainingBalance: 0 twins, and the readers that prefer
-- currentBalance showed it paid off. Drop stale twins wherever the model key
-- is present and the twin disagrees.
UPDATE profiles SET fields = fields - 'currentBalance' - 'remainingBalance' - 'loanBalance' - 'outstandingBalance'
WHERE fields ? 'balance' AND fields->>'balance' IS NOT NULL AND fields->>'balance' <> ''
  AND ((fields ? 'currentBalance' AND fields->>'currentBalance' IS DISTINCT FROM fields->>'balance')
    OR (fields ? 'remainingBalance' AND fields->>'remainingBalance' IS DISTINCT FROM fields->>'balance')
    OR (fields ? 'loanBalance' AND fields->>'loanBalance' IS DISTINCT FROM fields->>'balance')
    OR (fields ? 'outstandingBalance' AND fields->>'outstandingBalance' IS DISTINCT FROM fields->>'balance'));
UPDATE profiles SET fields = fields - 'monthlyPayment'
WHERE fields ? 'monthlyAmount' AND fields->>'monthlyAmount' <> '' AND fields ? 'monthlyPayment' AND fields->>'monthlyPayment' IS DISTINCT FROM fields->>'monthlyAmount';
UPDATE profiles SET fields = fields - 'originalBalance'
WHERE fields ? 'originalAmount' AND fields->>'originalAmount' <> '' AND fields ? 'originalBalance' AND fields->>'originalBalance' IS DISTINCT FROM fields->>'originalAmount';
UPDATE profiles SET fields = fields - 'currentValue' - 'estimatedValue'
WHERE fields ? 'value' AND fields->>'value' <> '' AND ((fields ? 'currentValue' AND fields->>'currentValue' IS DISTINCT FROM fields->>'value') OR (fields ? 'estimatedValue' AND fields->>'estimatedValue' IS DISTINCT FROM fields->>'value'));
