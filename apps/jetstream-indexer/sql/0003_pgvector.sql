-- pgvector migration (Vertex Vector Search → pgvector on bsky-db).
-- See PGVECTOR_MIGRATION_PLAN.md.
--
-- The HNSW index is NOT created here: CREATE INDEX CONCURRENTLY cannot run
-- inside the migrator's transaction, and the bulk build should happen once,
-- after the halfvec backfill (apps/web/scripts/backfill-halfvec.ts):
--
--   CREATE INDEX CONCURRENTLY idx_posts_embedding_hnsw
--     ON bsky.posts USING hnsw (embedding halfvec_cosine_ops)
--     WITH (m = 16, ef_construction = 128);
--
-- Everything below is idempotent — it may also be applied manually ahead of
-- the indexer redeploy (the migrator re-applies it as a no-op).

CREATE EXTENSION IF NOT EXISTS vector;

-- halfvec (float16) halves storage + index size vs vector (float32); recall
-- loss on Gemini embeddings is <1%. Nullable: backfill + new writes populate.
ALTER TABLE bsky.posts ADD COLUMN IF NOT EXISTS embedding halfvec(768);

-- Supports the retention prune (prune.ts), which anchors on ingested_at_us
-- because client-supplied created_at contains garbage at both extremes.
CREATE INDEX IF NOT EXISTS posts_ingested_at_us_idx
  ON bsky.posts (ingested_at_us);
