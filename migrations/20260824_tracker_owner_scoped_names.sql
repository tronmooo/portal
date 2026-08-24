-- Tracker identity is (owner profile + name), not (account + name).
--
-- Trackers were unique on (user_id, name) via idx_trackers_name_user, so one
-- account could hold exactly ONE tracker of a given name. But a tracker belongs
-- to a profile: you can run, Sarah can run, Bob can run, and those are three
-- independent Running trackers. The old grain made the second one un-insertable,
-- so createTracker worked around it by suffixing the owner's name onto the
-- tracker ("Running - Sarah Miller"), and the read path stripped that suffix
-- back off for display. This migration fixes the key so neither hack is needed.
--
--   1. owner_profile_id — a GENERATED column off linked_profiles[0]. Trackers
--      are profile-exclusive (server/supabase-storage.ts linkProfileTo enforces
--      one owner), so element 0 IS the owner. Generated, not backfilled, so it
--      can never drift from the column the app already writes.
--   2. Un-suffix the legacy names now that same-name rows can coexist.
--   3. Re-cut the unique index on (user_id, owner, lower(name)). Unowned
--      trackers collapse to the nil UUID, keeping them unique per account as
--      before. lower() is new: it stops "Running"/"running" splitting in two.

ALTER TABLE public.trackers
  ADD COLUMN IF NOT EXISTS owner_profile_id uuid
  GENERATED ALWAYS AS ((linked_profiles->>0)::uuid) STORED;

-- Drop BEFORE the rename: un-suffixing "Calories - Bob" to "Calories" collides
-- with another profile's "Calories" under the old key, which is the whole point.
DROP INDEX IF EXISTS public.idx_trackers_name_user;

UPDATE public.trackers t
SET name = c.clean, updated_at = now()
FROM (
  SELECT t2.id,
         left(t2.name, length(t2.name) - length(p.name) - 3) AS clean
  FROM public.trackers t2
  JOIN public.profiles p ON p.id = (t2.linked_profiles->>0)::uuid
  WHERE t2.deleted_at IS NULL
    AND p.name <> ''
    AND length(t2.name) > length(p.name) + 3
    -- Exact suffix compare, never LIKE: a profile name may contain % or _.
    AND right(lower(t2.name), length(p.name) + 3) = ' - ' || lower(p.name)
) c
WHERE t.id = c.id
  AND btrim(c.clean) <> ''
  -- Skip a rename that would land on a tracker this same owner already has.
  -- Those are genuine duplicate pairs; leave both rows and their entries alone
  -- rather than merging user data inside a migration.
  AND NOT EXISTS (
    SELECT 1 FROM public.trackers o
    WHERE o.deleted_at IS NULL
      AND o.user_id = t.user_id
      AND o.id <> t.id
      AND o.owner_profile_id IS NOT DISTINCT FROM t.owner_profile_id
      AND lower(o.name) = lower(c.clean)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_trackers_name_owner
  ON public.trackers (
    user_id,
    coalesce(owner_profile_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  WHERE deleted_at IS NULL;
