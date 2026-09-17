-- QA 2026-09-17: a dose logged from the trackers page was stored with no
-- person (the UI door sent no profileId and logEntry defaulted it to null),
-- so every per-person reader dropped it and the dashboard said "Vitamin D:
-- 7 doses unlogged this week" beside the logged doses. logEntry now adopts a
-- sole-owner tracker's owner; this gives the rows already written the same
-- owner. Only trackers with exactly one linked profile are touched — an
-- entry on a shared tracker stays unattributed rather than guessed.
-- Re-runnable.
UPDATE tracker_entries e
SET profile_id = t.linked_profiles->>0
FROM trackers t
WHERE t.id = e.tracker_id
  AND e.profile_id IS NULL
  AND jsonb_typeof(t.linked_profiles) = 'array'
  AND jsonb_array_length(t.linked_profiles) = 1
  AND t.linked_profiles->>0 IS NOT NULL
  AND t.linked_profiles->>0 <> '';
