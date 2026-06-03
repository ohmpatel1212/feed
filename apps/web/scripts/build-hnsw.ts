/**
 * One-shot HNSW index build on bsky.posts.embedding (halfvec, cosine).
 * Single server-side statement — no row payload crosses the wire. Pins one
 * connection so the session SETs apply to the CREATE INDEX, disables the
 * statement timeout (the build runs for many minutes), and uses CONCURRENTLY
 * so live indexer writes aren't blocked.
 *
 * Run after the halfvec backfill completes:
 *   npx tsx scripts/build-hnsw.ts
 */
import { withBskyClient } from "../src/lib/bsky-pg";

async function main() {
  const t0 = Date.now();
  await withBskyClient(async (c) => {
    await c.query("SET statement_timeout = 0");
    await c.query("SET maintenance_work_mem = '8GB'");
    await c.query("SET max_parallel_maintenance_workers = 4");
    console.log("[hnsw] building idx_posts_embedding_hnsw …");
    await c.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_embedding_hnsw
         ON bsky.posts USING hnsw (embedding halfvec_cosine_ops)
         WITH (m = 16, ef_construction = 128)`
    );
  });
  console.log(`[hnsw] DONE in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[hnsw] failed:", e.message ?? e);
  process.exit(1);
});
