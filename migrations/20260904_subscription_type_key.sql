-- D268 data repair: a subscription-typed profile saved by an older door (the
-- connected-finance "detected subscription" flow) carries no subtype, and the
-- bills list, the bell and the daily cron classify by subtype. The code now
-- treats a keyless subscription as a subscription; this makes the rows say so.
UPDATE profiles SET type_key = 'subscription'
WHERE type = 'subscription' AND (type_key IS NULL OR type_key = '');
