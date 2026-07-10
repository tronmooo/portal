-- Habit scheduling: when during the day a habit should occur.
--
-- Adds an editable time-of-day slot (and an optional precise time) to habits so
-- the Habits screen groups them by Morning/Afternoon/Evening/Night from the
-- user's actual schedule instead of inferring the slot from the last check-in
-- timestamp. Additive and idempotent — safe to run against existing data.

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS time_of_day TEXT
    CHECK (time_of_day IS NULL OR time_of_day IN ('morning','afternoon','evening','bedtime','anytime'));

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS scheduled_time TEXT; -- 'HH:MM' 24h, paired with time_of_day = 'custom'
