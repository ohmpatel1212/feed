-- Add Bluesky app-password column to users table for authenticated actions
-- (liking, reposting, etc.) via the AT Protocol.
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Idempotent: safe to re-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS bsky_app_password text;
