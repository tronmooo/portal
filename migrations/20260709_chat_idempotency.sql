-- QA 2026-07-09 #5: cross-instance idempotency for /api/chat.
--
-- The route's in-memory idempotency cache only protects retries that land on
-- the SAME serverless instance. On Vercel a client retry after a timeout
-- almost always hits a different warm instance, so the whole chat re-ran and
-- double-created every record (duplicate expenses/bills/subscriptions).
-- This table persists the same pending/done state machine in Postgres.
--
-- user_id is TEXT (not uuid) because the chat route falls back to req.ip /
-- 'anonymous' for unauthenticated callers. Rows are short-lived (the server
-- treats anything older than its IDEM_TTL as expired); the cleanup index keeps
-- the periodic purge cheap. Additive and idempotent.

CREATE TABLE IF NOT EXISTS chat_idempotency (
  user_id   TEXT NOT NULL,
  idem_key  TEXT NOT NULL,
  status    TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  result    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_chat_idempotency_created_at
  ON chat_idempotency (created_at);

-- RLS on with NO policies: only the server's service-role client (which
-- bypasses RLS) can touch this table; anon/authenticated PostgREST access is
-- fully blocked. Replay bodies can contain user data, so this must never be
-- readable client-side.
ALTER TABLE chat_idempotency ENABLE ROW LEVEL SECURITY;
