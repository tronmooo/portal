-- A public share link resolves an artifact by metadata->>'shareToken' with no
-- ordering. Two rows carrying the same token would make the link serve
-- whichever row Postgres returned first. Tokens are 32 random bytes, so a
-- collision only ever comes from a write that copied a token; refuse it at
-- the database, whatever code path attempts it.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_share_token_uq
  ON public.artifacts ((metadata->>'shareToken'))
  WHERE metadata->>'shareToken' IS NOT NULL;
