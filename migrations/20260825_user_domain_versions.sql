-- Migration: per-DOMAIN cache versions
--
-- Migration 010 gave each user ONE version counter, bumped on every write, and
-- embedded it in every cached response key. That made writes correct by making
-- them total: recording a payment changed the cache key of the dashboard, the
-- expense list, the tracker list, the calendar and the document list all at
-- once, on every serverless instance and in the shared response_cache table.
-- Nothing was stale — everything was simply unaddressable, so the next read of
-- anything at all recomputed from scratch. A ~15-query dashboard rebuild after
-- every single write is where "it takes several seconds to show up" came from.
--
-- This adds a per-domain version map alongside the counter. A prefix's cache
-- key is stamped only with the domains its payload reads (shared/cache-domains.ts),
-- so a liability write stops evicting the habit list.
--
-- ── Deploy safety ──────────────────────────────────────────────────────────
-- Additive, and the old function is left exactly as it was. During a rolling
-- deploy an old instance keeps calling bump_user_data_version(uuid), which
-- bumps `version` — the epoch — and every key on every instance still contains
-- the epoch. So an old instance's write invalidates EVERYTHING, which is the
-- pre-migration behavior: slower, never wrong. That is the correct direction
-- for a mixed fleet.

ALTER TABLE public.user_data_versions
  ADD COLUMN IF NOT EXISTS domains jsonb NOT NULL DEFAULT '{}'::jsonb;

-- New name, deliberately: redefining bump_user_data_version would change
-- behavior underneath instances still running the old code.
CREATE OR REPLACE FUNCTION public.bump_user_domain_versions(
  p_user_id uuid,
  p_domains text[]
)
RETURNS jsonb                 -- { "epoch": 42, "liabilities": 9, ... }
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.user_data_versions (user_id, version, domains, updated_at)
  VALUES (
    p_user_id,
    1,
    COALESCE((SELECT jsonb_object_agg(d, 1) FROM unnest(p_domains) AS d), '{}'::jsonb),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET
      -- The EPOCH is in every cache key, so moving it invalidates everything.
      -- That is precisely what we do NOT want for a classified write — it is
      -- the old behavior this migration exists to end. It moves only when the
      -- caller names no domain at all, which means "I could not classify this
      -- write", and for the legacy one-argument function an old instance calls
      -- during a rolling deploy. Both must invalidate all; a normal write must
      -- not.
      version = public.user_data_versions.version
                + CASE WHEN COALESCE(array_length(p_domains, 1), 0) = 0 THEN 1 ELSE 0 END,
      domains = COALESCE(
        (
          SELECT jsonb_object_agg(k, v)
          FROM (
            SELECT k, MAX(v) AS v
            FROM (
              SELECT key AS k, (value #>> '{}')::bigint AS v
                FROM jsonb_each(public.user_data_versions.domains)
              UNION ALL
              SELECT d AS k,
                     COALESCE((public.user_data_versions.domains ->> d)::bigint, 0) + 1 AS v
                FROM unnest(p_domains) AS d
            ) merged
            GROUP BY k
          ) agg
        ),
        '{}'::jsonb
      ),
      updated_at = now()
  RETURNING jsonb_build_object('epoch', version) || domains;
$$;

REVOKE ALL ON FUNCTION public.bump_user_domain_versions(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_user_domain_versions(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.bump_user_domain_versions(uuid, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_user_domain_versions(uuid, text[]) TO service_role;
