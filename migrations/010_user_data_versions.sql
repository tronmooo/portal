-- Migration 010: per-user data version for cross-instance cache coherence
--
-- Problem (user report 2026-06-10): the API's in-memory response cache is
-- per-serverless-instance. The write middleware busts the cache only on the
-- instance that served the write; other warm instances keep serving stale
-- data until TTL expiry (up to 60s). Symptom: "deleted items still show up,
-- added items don't appear, I constantly have to refresh".
--
-- Fix: a monotonically increasing per-user version. Every write bumps it
-- (RPC below, called fire-and-forget from the write middleware). Every read
-- resolves the current version (memoized in-instance for 2s) and embeds it
-- in the cache key — so a write on ANY instance invalidates the cached
-- responses on ALL instances within ~2s, while cache hits stay cheap.

CREATE TABLE IF NOT EXISTS public.user_data_versions (
  user_id    uuid PRIMARY KEY,
  version    bigint      NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Service-role only: enable RLS with no policies (deny anon/authenticated).
ALTER TABLE public.user_data_versions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.bump_user_data_version(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.user_data_versions (user_id, version, updated_at)
  VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id)
  DO UPDATE SET version = public.user_data_versions.version + 1, updated_at = now()
  RETURNING version;
$$;

REVOKE ALL ON FUNCTION public.bump_user_data_version(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_user_data_version(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bump_user_data_version(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_user_data_version(uuid) TO service_role;
