-- D268 (legacy shape): an older subscription form stored its facts under a
-- nested `subscriptions` group (cost, frequency, renewalDate, provider, plan,
-- nextBillingDate…). The bills projection reads the top level, so once these
-- rows counted as bills again they listed with no amount and no date. Lift the
-- group's keys to the model's top-level keys where the top level lacks them.
UPDATE profiles p SET fields =
  (p.fields
    || CASE WHEN NOT (p.fields ? 'amount') AND NOT (p.fields ? 'monthlyAmount') AND (p.fields->'subscriptions'->>'cost') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
         THEN jsonb_build_object('amount', to_jsonb(trim(p.fields->'subscriptions'->>'cost')::numeric)) ELSE '{}'::jsonb END
    || CASE WHEN NOT (p.fields ? 'frequency') AND p.fields->'subscriptions' ? 'frequency' THEN jsonb_build_object('frequency', p.fields->'subscriptions'->'frequency') ELSE '{}'::jsonb END
    || CASE WHEN NOT (p.fields ? 'renewalDate') AND NOT (p.fields ? 'dueDate') AND p.fields->'subscriptions' ? 'renewalDate' THEN jsonb_build_object('renewalDate', p.fields->'subscriptions'->'renewalDate') ELSE '{}'::jsonb END
    || CASE WHEN NOT (p.fields ? 'dueDate') AND NOT (p.fields ? 'renewalDate') AND p.fields->'subscriptions' ? 'nextBillingDate' THEN jsonb_build_object('dueDate', p.fields->'subscriptions'->'nextBillingDate', 'nextDueDate', p.fields->'subscriptions'->'nextBillingDate') ELSE '{}'::jsonb END
    || CASE WHEN NOT (p.fields ? 'provider') AND p.fields->'subscriptions' ? 'provider' THEN jsonb_build_object('provider', p.fields->'subscriptions'->'provider') ELSE '{}'::jsonb END
    || CASE WHEN NOT (p.fields ? 'plan') AND p.fields->'subscriptions' ? 'plan' THEN jsonb_build_object('plan', p.fields->'subscriptions'->'plan') ELSE '{}'::jsonb END)
WHERE p.type = 'subscription' AND jsonb_typeof(p.fields->'subscriptions') = 'object';
