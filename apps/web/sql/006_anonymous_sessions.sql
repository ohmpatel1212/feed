-- Anonymous cookie-based sessions. Users no longer need Firebase auth.
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Idempotent: safe to re-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_id text UNIQUE;
ALTER TABLE users ALTER COLUMN firebase_uid DROP NOT NULL;

-- Index for fast session lookups
CREATE INDEX IF NOT EXISTS users_session_id_idx ON users(session_id) WHERE session_id IS NOT NULL;
