-- D268 (legacy costs): six bundle rows carry "$NN.NN/mo" as their cost. Take
-- the leading money figure as the amount where the top level still has none.
UPDATE profiles p SET fields = p.fields || jsonb_build_object('amount', to_jsonb((regexp_match(p.fields->'subscriptions'->>'cost', '-?[0-9]+(?:\.[0-9]+)?'))[1]::numeric))
WHERE p.type = 'subscription' AND jsonb_typeof(p.fields->'subscriptions') = 'object'
  AND NOT (p.fields ? 'amount') AND NOT (p.fields ? 'monthlyAmount')
  AND (p.fields->'subscriptions'->>'cost') ~ '-?[0-9]+(\.[0-9]+)?';
