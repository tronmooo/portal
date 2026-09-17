-- The "fire due reminders" cron (retired 2026-08-09 along with the Reminder
-- entity) created a `Reminder: <title>` TASK every time a reminder fired:
-- undated, source 'reminder', tagged 'reminder'. A daily medication reminder
-- with a morning and an evening slot therefore left three new open tasks a
-- day behind it, and one account carried ~30 of them ("43 tasks due", most
-- of them these). Nothing creates them any more; a timed task IS the reminder
-- now. Retire the leftover markers the same way the app deletes a task (soft:
-- deleted_at), so an account that wants one back can restore it from Trash.
-- Only the machine-made markers go: a task a person typed as "Reminder: ..."
-- has source 'manual' and is untouched. Re-runnable.
UPDATE tasks
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND source = 'reminder'
  AND due_date IS NULL
  AND status <> 'done'
  AND title LIKE 'Reminder: %';
