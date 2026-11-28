-- The AI Mode library (owner request 2026-11-27: "a library of
-- community-created modes. Users could publish their own configurations,
-- discover popular modes, install templates and customize them further").
--
-- A row is a mode's SETUP only — exportModeTemplate (shared/ai-modes.ts):
-- name, icon, color, personality, instructions, tabs, reminders, check-ins.
-- Never a conversation, a memory, a record or the journal switch. The author
-- is kept so they can unpublish it, and is never returned to anyone.
--
-- ── Deploy safety ──────────────────────────────────────────────────────────
-- Additive: two new tables and two functions; nothing existing is touched.
-- The server answers "the library isn't available yet" while they are
-- missing (it never pretends the library is empty). Re-running is a no-op.

CREATE TABLE IF NOT EXISTS public.ai_mode_library (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid        NOT NULL,
  name        text        NOT NULL,
  tagline     text        NOT NULL DEFAULT '',
  icon        text        NOT NULL DEFAULT 'sparkles',
  color       text        NOT NULL DEFAULT 'violet',
  template    jsonb       NOT NULL,
  installs    integer     NOT NULL DEFAULT 0,
  reports     integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_mode_library_popular_idx ON public.ai_mode_library (reports, installs DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_mode_library_author_idx ON public.ai_mode_library (author_id);

-- One report per person per entry; three hide it.
CREATE TABLE IF NOT EXISTS public.ai_mode_library_reports (
  library_id  uuid        NOT NULL REFERENCES public.ai_mode_library (id) ON DELETE CASCADE,
  reporter_id uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, reporter_id)
);

-- Service role only (the server reads and writes on the person's behalf).
ALTER TABLE public.ai_mode_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all ON public.ai_mode_library;
CREATE POLICY deny_all ON public.ai_mode_library FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON public.ai_mode_library FROM anon, authenticated;
ALTER TABLE public.ai_mode_library_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all ON public.ai_mode_library_reports;
CREATE POLICY deny_all ON public.ai_mode_library_reports FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON public.ai_mode_library_reports FROM anon, authenticated;

-- Count an install in one statement.
CREATE OR REPLACE FUNCTION public.ai_mode_library_installed(p_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.ai_mode_library SET installs = installs + 1 WHERE id = p_id;
$$;

-- Record one person's report and recount; answers the new count.
CREATE OR REPLACE FUNCTION public.ai_mode_library_report(p_id uuid, p_reporter uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.ai_mode_library_reports (library_id, reporter_id) VALUES (p_id, p_reporter) ON CONFLICT DO NOTHING;
  SELECT count(*) INTO n FROM public.ai_mode_library_reports WHERE library_id = p_id;
  UPDATE public.ai_mode_library SET reports = n WHERE id = p_id;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.ai_mode_library_installed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_mode_library_report(uuid, uuid) FROM PUBLIC, anon, authenticated;
