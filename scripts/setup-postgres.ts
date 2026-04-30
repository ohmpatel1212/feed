import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const SCHEMA = `
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  photo_url TEXT,
  bluesky_handle TEXT,
  bluesky_did TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_firebase ON users(firebase_uid);

-- Feeds (user-scoped, stores full config as JSONB)
CREATE TABLE IF NOT EXISTS feeds (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled',
  description TEXT NOT NULL DEFAULT '',
  mechanical_filters JSONB NOT NULL DEFAULT '{}',
  semantic_config JSONB NOT NULL DEFAULT '{}',
  published_rkey TEXT,
  is_active BOOLEAN DEFAULT true,
  color TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_active ON feeds(is_active) WHERE is_active = true;

-- Posts (stored ONCE with embedding, shared across feeds)
CREATE TABLE IF NOT EXISTS posts (
  id BIGSERIAL PRIMARY KEY,
  uri TEXT UNIQUE NOT NULL,
  cid TEXT NOT NULL,
  author_did TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1536),
  has_media BOOLEAN DEFAULT false,
  has_link BOOLEAN DEFAULT false,
  has_quote BOOLEAN DEFAULT false,
  is_reply BOOLEAN DEFAULT false,
  lang TEXT,
  hashtags TEXT[] DEFAULT '{}',
  char_length INT,
  indexed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_uri ON posts(uri);
CREATE INDEX IF NOT EXISTS idx_posts_indexed ON posts(indexed_at DESC);

-- Feed-Post assignments (many-to-many)
CREATE TABLE IF NOT EXISTS feed_posts (
  feed_id INT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  embedding_score REAL,
  judge_approved BOOLEAN,
  final_score REAL NOT NULL DEFAULT 0,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (feed_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_posts_score ON feed_posts(feed_id, final_score DESC, assigned_at DESC);

-- Chat messages (per-feed)
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  feed_id INT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Author rate limit tracking
CREATE TABLE IF NOT EXISTS author_post_counts (
  author_did TEXT NOT NULL,
  hour_bucket TIMESTAMPTZ NOT NULL,
  count INT DEFAULT 1,
  PRIMARY KEY (author_did, hour_bucket)
);
`;

async function main() {
  console.log("Setting up PostgreSQL schema...");
  console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^@]+@/, ":***@")}`);

  try {
    await pool.query(SCHEMA);
    console.log("Schema created successfully.");

    // Check if we should create the ivfflat index (needs rows first for optimal lists)
    const postCount = await pool.query("SELECT COUNT(*) as count FROM posts");
    const count = parseInt(postCount.rows[0].count);
    if (count > 1000) {
      console.log(`Found ${count} posts, creating ivfflat index...`);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_posts_embedding ON posts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
      );
      console.log("Embedding index created.");
    } else {
      console.log(
        `Only ${count} posts — skipping ivfflat index (create manually after 1000+ posts).`
      );
    }

    // Verify tables
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log(
      "Tables:",
      tables.rows.map((r: { table_name: string }) => r.table_name).join(", ")
    );
  } catch (err: any) {
    console.error("Setup failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
