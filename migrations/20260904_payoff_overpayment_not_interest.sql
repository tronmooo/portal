-- D271 follow-up: a payoff on a loan with no tracked balance booked the whole
-- payment as interest (principal 0). Those rows are all principal.
UPDATE liability_payments
SET principal_portion = amount - COALESCE(fees, 0), interest_portion = 0
WHERE payment_type = 'payoff' AND principal_portion = 0 AND interest_portion > 0
  AND ABS(interest_portion - (amount - COALESCE(fees, 0))) < 0.005;

-- D272: a payoff for less than the balance booked the whole balance as
-- principal (a $200 payoff on a $3,100 card recorded $3,100 paid). The cash
-- paid is the principal; the rest was written off, and the row says so.
UPDATE liability_payments
SET notes = CONCAT_WS(' — ', NULLIF(notes, ''), 'Settled: $' || TO_CHAR(principal_portion - (amount - COALESCE(fees, 0) - interest_portion), 'FM999999999990.00') || ' of the balance written off'),
    principal_portion = amount - COALESCE(fees, 0) - interest_portion
WHERE payment_type = 'payoff' AND principal_portion > amount - COALESCE(fees, 0) - interest_portion + 0.005;

-- D271: a payoff booked everything above the balance as interest. For payoff
-- rows whose interest exceeds one period's accrued interest on the balance
-- they cleared (principal × rate ÷ 12, or 0 when the loan records no rate),
-- the excess becomes an overpayment noted on the row and the interest is the
-- accrued figure.
WITH bad AS (
  SELECT lp.id, lp.interest_portion,
         LEAST(lp.interest_portion,
               ROUND(lp.principal_portion * COALESCE(NULLIF(p.fields->>'interestRate','')::numeric, 0) / CASE WHEN COALESCE(NULLIF(p.fields->>'interestRate','')::numeric, 0) > 1 THEN 100 ELSE 1 END / 12, 2)) AS accrued
  FROM liability_payments lp JOIN profiles p ON p.id = lp.liability_profile_id
  WHERE lp.payment_type = 'payoff' AND lp.interest_portion > 0
)
UPDATE liability_payments lp
SET interest_portion = bad.accrued,
    notes = CONCAT_WS(' — ', NULLIF(lp.notes, ''), 'Overpaid by $' || TO_CHAR(bad.interest_portion - bad.accrued, 'FM999999999990.00') || ' (owed back by the lender)')
FROM bad WHERE bad.id = lp.id AND bad.interest_portion > bad.accrued + 0.005;
