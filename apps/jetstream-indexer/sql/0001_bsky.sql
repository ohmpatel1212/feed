-- bsky schema. Target database: bsky (in Cloud SQL instance feed-db).
-- Times stored as bigint microseconds (matches Jetstream time_us) plus a
-- timestamptz convenience column where useful.

CREATE SCHEMA IF NOT EXISTS bsky;

CREATE TABLE IF NOT EXISTS bsky.posts (
  uri               text PRIMARY KEY,
  did               text NOT NULL,
  rkey              text NOT NULL,
  text              text NOT NULL,
  created_at        timestamptz NOT NULL,
  created_at_us     bigint NOT NULL,
  ingested_at_us    bigint NOT NULL,
  langs             text[] NOT NULL DEFAULT '{}',

  reply_parent_uri  text,
  reply_parent_did  text,
  reply_root_uri    text,
  is_self_thread    boolean NOT NULL DEFAULT false,

  embed_type        text,
  image_alts        text[] NOT NULL DEFAULT '{}',
  image_count       int NOT NULL DEFAULT 0,
  video_alt         text,
  is_gif            boolean NOT NULL DEFAULT false,
  external_uri      text,
  external_title    text,
  external_desc     text,
  quote_uri         text,
  quote_did         text,

  hashtags          text[] NOT NULL DEFAULT '{}',
  mention_dids      text[] NOT NULL DEFAULT '{}',
  links             text[] NOT NULL DEFAULT '{}',
  domains           text[] NOT NULL DEFAULT '{}',
  self_labels       text[] NOT NULL DEFAULT '{}',
  raw_facets        jsonb,

  embedding_vec     bytea,
  schema_v          int NOT NULL DEFAULT 2,
  indexed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_did_idx
  ON bsky.posts (did);
CREATE INDEX IF NOT EXISTS posts_created_at_us_idx
  ON bsky.posts (created_at_us DESC);
CREATE INDEX IF NOT EXISTS posts_reply_parent_idx
  ON bsky.posts (reply_parent_uri)
  WHERE reply_parent_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_quote_uri_idx
  ON bsky.posts (quote_uri)
  WHERE quote_uri IS NOT NULL;

CREATE TABLE IF NOT EXISTS bsky.post_engagement (
  uri                       text PRIMARY KEY,
  like_count                int NOT NULL DEFAULT 0,
  repost_count              int NOT NULL DEFAULT 0,
  reply_count               int NOT NULL DEFAULT 0,
  quote_count               int NOT NULL DEFAULT 0,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  last_pushed_to_vertex_at  timestamptz
);

CREATE INDEX IF NOT EXISTS post_engagement_dirty_idx
  ON bsky.post_engagement (updated_at)
  WHERE last_pushed_to_vertex_at IS NULL OR updated_at > last_pushed_to_vertex_at;

CREATE TABLE IF NOT EXISTS bsky.authors (
  did           text PRIMARY KEY,
  handle        text,
  display_name  text,
  description   text,
  avatar_cid    text,
  banner_cid    text,
  profile_rev   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authors_handle_idx ON bsky.authors (handle);

CREATE TABLE IF NOT EXISTS bsky.handles_history (
  did          text NOT NULL,
  handle       text NOT NULL,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (did, observed_at)
);

CREATE TABLE IF NOT EXISTS bsky.consumer_state (
  consumer   text PRIMARY KEY,
  cursor_us  bigint NOT NULL,
  host       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bsky._migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
