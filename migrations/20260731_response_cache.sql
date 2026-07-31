-- Shared (cross-instance) response cache for the expensive dashboard/calendar
-- aggregations. The server's in-memory response cache is per serverless
-- instance; under Vercel's instance fan-out every instance recomputed the same
-- ~15-query bootstrap. This table lets any instance serve a bootstrap another
-- instance computed in the last TTL, in one indexed read.
--
-- Correctness rides on the existing version-stamped cache keys
-- (`<prefix><uid>@v<version>...`, migration 010): any write bumps the user's
-- data version, so stale rows simply stop being addressable. Expired rows are
-- deleted on the owner's next write (throttled) and swept by the daily cron.
--
-- Accessed exclusively through the service role; RLS is enabled with no
-- policies so anon/authenticated roles can never read another user's cache.

create table if not exists response_cache (
  key text primary key,
  user_id uuid not null,
  payload jsonb not null,
  expires_at timestamptz not null
);

create index if not exists idx_response_cache_user on response_cache(user_id);
create index if not exists idx_response_cache_expires on response_cache(expires_at);

alter table response_cache enable row level security;
