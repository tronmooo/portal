-- Habit identity is (owner profile + name), not (account + name).
--
-- Habits were unique on (user_id, name) via idx_habits_name_user, so one
-- account could hold exactly ONE habit of a given name: "Floss" for you meant
-- no "Floss" for your child, and POST /api/habits answered 500 for the second
-- family member. Same grain fix as 20260824_tracker_owner_scoped_names.sql:
--
--   1. owner_profile_id — a GENERATED column off linked_profiles[0]. Habits
--      are written owner-first (createHabit links self when nothing is given;
--      the ownership writer keeps element 0 the owner), so element 0 IS the
--      owner. Generated, never backfilled, so it cannot drift.
--   2. Re-cut the unique index on (user_id, owner, lower(name)). Unowned
--      habits collapse to the nil UUID, staying unique per account as before.
--      lower() stops "Floss"/"floss" splitting in two.
--
-- Verified before cutting the new index: no live habit shares
-- (user, owner, lower(name)) with another, so the CREATE cannot fail.

ALTER TABLE public.habits
  ADD COLUMN IF NOT EXISTS owner_profile_id uuid
  GENERATED ALWAYS AS ((linked_profiles->>0)::uuid) STORED;

DROP INDEX IF EXISTS public.idx_habits_name_user;

CREATE UNIQUE INDEX IF NOT EXISTS idx_habits_name_owner
  ON public.habits (
    user_id,
    coalesce(owner_profile_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  WHERE deleted_at IS NULL;
