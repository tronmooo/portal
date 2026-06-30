-- Migration 20260627: net_worth_snapshots.profile_id ON DELETE CASCADE
--
-- BUG: deleting a profile failed (whole cascade rolled back, DELETE /profiles
-- returned 500) whenever that profile had a net-worth snapshot. The FK was
-- ON DELETE SET NULL, so deleting the profile nulled profile_id on its snapshot
-- rows — colliding with the existing aggregate (NULL profile_id) snapshot for
-- the same (user_id, snapshot_date) via the net_worth_snapshots_unique index
-- (23505 unique_violation).
--
-- A profile's per-profile snapshots are historical and meaningless once the
-- profile is gone (the aggregate "everyone" row is a separate row), so they
-- should be deleted with the profile. Switch the FK to ON DELETE CASCADE.
--
-- IDEMPOTENT: safe to re-run.

ALTER TABLE net_worth_snapshots DROP CONSTRAINT IF EXISTS net_worth_snapshots_profile_id_fkey;
ALTER TABLE net_worth_snapshots
  ADD CONSTRAINT net_worth_snapshots_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
