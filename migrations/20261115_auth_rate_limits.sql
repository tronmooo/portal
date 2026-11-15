-- Shared counters for the auth rate limits (security audit 2026-11-15).
--
-- The limits in server/auth.ts (10 sign-ins a minute per IP, 5 sign-ups per
-- 5 minutes, 3 reset emails per 5 minutes, ...) were counted in a Map inside
-- each serverless instance. Production runs many instances, so a caller's
-- attempts were spread across counters that each stayed under the limit:
-- 12 wrong-password sign-ins in a row from one address were all let through.
--
-- One row per (endpoint, caller) here, bumped atomically, gives every
-- instance the same count. The key is a SHA-256 hash made by the server
-- (server/auth-rate-limit.ts): no IP address or email is stored.
--
-- ── Deploy safety ──────────────────────────────────────────────────────────
-- Additive: one new table and one new function, nothing existing is touched.
-- The server treats any failure of this call (function missing, timeout,
-- database down) as "not limited by the shared store" and falls back to the
-- in-memory counter it always had, so the order of migration and deploy does
-- not matter and a database problem can never lock anyone out of sign-in.
-- Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  key      text        PRIMARY KEY,
  count    integer     NOT NULL,
  reset_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_reset_at_idx
  ON public.auth_rate_limits (reset_at);

-- Service role only, the same two locks as response_cache (20260918): an
-- always-false policy and no grants. The service role bypasses both.
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all ON public.auth_rate_limits;
CREATE POLICY deny_all ON public.auth_rate_limits FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON public.auth_rate_limits FROM anon, authenticated;

-- Count one attempt for p_key and say whether it is over the limit.
-- Same rule as the in-memory counter: the first attempt opens a window of
-- p_window_ms, and the call returns true once more than p_max attempts have
-- landed inside it. One statement, so concurrent instances cannot both read
-- the same count.
CREATE OR REPLACE FUNCTION public.auth_rate_limit_hit(
  p_key       text,
  p_max       integer,
  p_window_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.auth_rate_limits AS r (key, count, reset_at)
  VALUES (p_key, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  ON CONFLICT (key) DO UPDATE
    SET count    = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
        reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
  RETURNING r.count INTO v_count;

  -- Housekeeping on roughly 1 call in 50: drop windows that ended long ago.
  IF random() < 0.02 THEN
    DELETE FROM public.auth_rate_limits WHERE reset_at < now() - interval '1 hour';
  END IF;

  RETURN v_count > p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_rate_limit_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_rate_limit_hit(text, integer, integer) TO service_role;
