import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const MIGRATION = `
-- Onboarding card bank (pre-seeded diverse posts for tap-to-react flow)
CREATE TABLE IF NOT EXISTS onboarding_cards (
  id SERIAL PRIMARY KEY,
  uri TEXT UNIQUE NOT NULL,
  text TEXT NOT NULL,
  author_handle TEXT,
  topic_cluster TEXT NOT NULL,
  vibe_tags TEXT[] DEFAULT '{}',
  format TEXT DEFAULT 'general',
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for similarity search
CREATE INDEX IF NOT EXISTS idx_onboarding_cards_embedding
  ON onboarding_cards USING ivfflat (embedding vector_cosine_ops) WITH (lists = 5);

-- Allow 'system' role in chat_messages for onboarding state persistence
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_role_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_role_check
  CHECK (role IN ('user', 'assistant', 'system'));
`;

async function main() {
  console.log("Running onboarding migration...");
  try {
    await pool.query(MIGRATION);
    console.log("Migration complete.");

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'onboarding_cards'`
    );
    console.log(
      tables.rows.length > 0
        ? "onboarding_cards table exists."
        : "ERROR: onboarding_cards table not created."
    );
  } catch (err: any) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
