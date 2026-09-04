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
