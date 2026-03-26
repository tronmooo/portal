-- LifeOS Data Cleanup Script
-- Target account: tron@aol.com (user_id = '6f63cf74-ad8b-42f4-a8de-850f42219c06')
-- WARNING: Review carefully before executing. This script modifies data.

-- Remove tracker entries with impossible values
-- Luna weight entries > 100 lbs (she's a cat/small pet)
DELETE FROM tracker_entries 
WHERE tracker_id IN (SELECT id FROM trackers WHERE name ILIKE '%luna%weight%' AND user_id = '6f63cf74-ad8b-42f4-a8de-850f42219c06')
AND (
  (entry_values->>'weight')::numeric > 100 
  OR (entry_values->>'weight')::numeric < 0
  OR (entry_values->>'weight')::numeric = 0
);

-- Remove duplicate trackers (keep the one with most entries)
-- This is informational — run manually after review
-- SELECT name, COUNT(*) FROM trackers WHERE user_id = '6f63cf74-ad8b-42f4-a8de-850f42219c06' GROUP BY name HAVING COUNT(*) > 1;
