-- A reminder task remembers the event it exists for.
--
-- QA req 6: "Sarah has a dentist appointment on September 8" / "remind me two
-- days before" produced two records with no relationship between them. Moving
-- the appointment to the 10th left the reminder on the 6th, and a turn that
-- moved the reminder while the appointment update failed left the data
-- describing a reminder for an appointment two days after it.
--
-- reminder_offset_minutes is how far BEFORE the event the reminder sits
-- (positive = before), so moving the event RECOMPUTES the reminder rather than
-- applying a guessed delta. Both columns are nullable: an ordinary task is not
-- a reminder for anything.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS reminder_for_event_id UUID,
  ADD COLUMN IF NOT EXISTS reminder_offset_minutes INTEGER;

-- Deleting the event drops the dependency, not the task: the user may still
-- want the to-do. ON DELETE SET NULL rather than CASCADE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_reminder_for_event_id_fkey'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_reminder_for_event_id_fkey
      FOREIGN KEY (reminder_for_event_id) REFERENCES events(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Covering index: update_event looks reminders up by their event on every move.
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_for_event
  ON tasks (reminder_for_event_id)
  WHERE reminder_for_event_id IS NOT NULL;
