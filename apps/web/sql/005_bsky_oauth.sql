-- Bluesky OAuth state + session storage for AT Protocol OAuth 2.0 (DPoP).
-- Apply against the feed-db Postgres instance (database: feed_curator).
--
-- Idempotent: safe to re-run.

-- Ephemeral state during the authorize → callback round-trip.
CREATE TABLE IF NOT EXISTS bsky_oauth_state (
  key         text PRIMARY KEY,
  data        jsonb NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS bsky_oauth_state_expires_idx
  ON bsky_oauth_state(expires_at);

-- Long-lived session tokens keyed by DID.
CREATE TABLE IF NOT EXISTS bsky_oauth_session (
  did         text PRIMARY KEY,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
