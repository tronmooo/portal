-- Journal: several entries per day, per person, each with a title.
--
-- Owner decision 2026-11-20: the journal is no longer one entry per day. A
-- person may write several entries in a day, and may write entries on behalf
-- of another profile (Bob's journal), so the (user_id, date) uniqueness rule
-- goes. idx_journal_date (non-unique, same columns) stays for the lookups.
--
-- `title` is a short AI-written headline for the entry; NULL for entries
-- written before this migration (the page falls back to the first line).
--
-- Additive and safe to re-run. Existing rows are untouched.
ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_unique_day;
DROP INDEX IF EXISTS public.journal_entries_unique_day;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS title text;
