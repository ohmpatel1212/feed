/**
 * Backfill the `bsky.posts.embedding` halfvec column from the existing
 * `embedding_vec` bytea (packed float32, 768d). NO re-embedding — it just
 * reinterprets the bytes the indexer already cached.
 *
 * Prereq: the column exists (sql/0003_pgvector.sql):
 *   ALTER TABLE bsky.posts ADD COLUMN embedding halfvec(768);
 *
 * Usage (from apps/web):
 *   npx tsx scripts/backfill-halfvec.ts [batchSize] [loUri] [hiUri]
 *
 * loUri/hiUri bound the pkey walk to [loUri, hiUri) so several workers can
 * run in parallel on disjoint uri ranges. DIDs are base32, so sharding on
 * the first did character splits roughly evenly, e.g. 3 workers:
 *   ... 4000 ''               'at://did:plc:j'
 *   ... 4000 'at://did:plc:j' 'at://did:plc:r'
 *   ... 4000 'at://did:plc:r' ''
 *
 * Walks the table in primary-key (uri) order via keyset pagination, so each
 * batch is one index-range scan — no repeated seq scans, no reliance on
 * created_at (which is client-supplied and contains garbage at the extremes).
 *
 * Only rows ingested within RETENTION_DAYS are converted: anything older is
 * deleted by the indexer's first prune run anyway (prune.ts), so converting
 * it would be wasted writes + HNSW bloat. The cutoff is fixed at process
 * start so the workload doesn't shift under a long run.
 *
 * Idempotent + resumable: rows with embedding already set are skipped by the
 * WHERE clause. On restart the keyset cursor starts over, but already-filled
 * rows are filtered out by the index scan, so it fast-forwards. Safe to
 * Ctrl-C and restart. Runs concurrently with the live indexer (its upserts
 * write the same value).
 *
 * Build the HNSW index AFTER this completes (so it bulk-builds once):
 *   CREATE INDEX CONCURRENTLY idx_posts_embedding_hnsw
 *     ON bsky.posts USING hnsw (embedding halfvec_cosine_ops)
 *     WITH (m = 16, ef_construction = 128);
 */

import { bskyQuery } from "../src/lib/bsky-pg";

const DIM = 768;
const EXPECTED_BYTES = DIM * 4; // 3072
// Must match the indexer's cfg.retentionDays (RETENTION_DAYS env there).
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 14);
const CUTOFF_US = (Date.now() - RETENTION_DAYS * 86_400_000) * 1000;

const batchSize = Number(process.argv[2] ?? 2000);
const loUri = process.argv[3] ?? "";
const hiUri = process.argv[4] ?? ""; // "" = unbounded

if (!Number.isFinite(batchSize) || batchSize <= 0) {
  console.error(`Invalid batchSize: ${process.argv[2]}`);
  process.exit(1);
}

// Matches the indexer's packFloat32: node Buffer is a Uint8Array view; slice
// into a Float32Array using its byteOffset (the Buffer may share a pool).
function unpackFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function toHalfvecLiteral(buf: Buffer): string | null {
  if (buf.byteLength !== EXPECTED_BYTES) return null; // skip malformed rows
  const f = unpackFloat32(buf);
  // halfvec input parses standard float literals; float32→float16 happens
  // server-side on the cast. toPrecision(5) (float16 holds ~3.3 decimal
  // digits) instead of the default float64 repr (~19 chars) cuts the
  // statement payload ~60% — the UPDATE text is the backfill bottleneck.
  const parts = new Array<string>(f.length);
  for (let i = 0; i < f.length; i++) parts[i] = f[i].toPrecision(5);
  return "[" + parts.join(",") + "]";
}

interface Row {
  uri: string;
  embedding_vec: Buffer | null;
}

async function main() {
  const t0 = Date.now();
  let totalUpdated = 0;
  let totalSkipped = 0;
  let round = 0;
  let lastUri = loUri;
  let windowT0 = Date.now();
  let windowUpdated = 0;
  const shard = `[${loUri || "-∞"}, ${hiUri || "+∞"})`;

  console.log(`[backfill] shard ${shard}, batch=${batchSize}, retention=${RETENTION_DAYS}d`);

  while (true) {
    // Keyset pagination on the pkey: one index-range scan per batch.
    const { rows } = await bskyQuery<Row>(
      `SELECT uri, embedding_vec FROM bsky.posts
       WHERE uri > $1 AND ($4 = '' OR uri < $4)
         AND embedding IS NULL AND embedding_vec IS NOT NULL
         AND ingested_at_us >= $3
       ORDER BY uri
       LIMIT $2`,
      [lastUri, batchSize, CUTOFF_US, hiUri]
    );
    if (rows.length === 0) break;
    lastUri = rows[rows.length - 1].uri;

    const uris: string[] = [];
    const embs: string[] = [];
    for (const r of rows) {
      if (!r.embedding_vec) { totalSkipped++; continue; }
      const lit = toHalfvecLiteral(r.embedding_vec);
      if (lit === null) { totalSkipped++; continue; }
      uris.push(r.uri);
      embs.push(lit);
    }

    if (uris.length > 0) {
      // Batch UPDATE via unnest; text[] → halfvec cast per element.
      await bskyQuery(
        `UPDATE bsky.posts AS p
         SET embedding = v.emb::halfvec
         FROM unnest($1::text[], $2::text[]) AS v(uri, emb)
         WHERE p.uri = v.uri`,
        [uris, embs]
      );
      totalUpdated += uris.length;
      windowUpdated += uris.length;
    }

    round++;
    if (round % 25 === 0 || rows.length < batchSize) {
      const rate = windowUpdated / ((Date.now() - windowT0) / 1000);
      console.log(
        `[backfill] ${shard} updated=${totalUpdated} skipped=${totalSkipped} ` +
          `(${rate.toFixed(0)} rows/s marginal)`
      );
      windowT0 = Date.now();
      windowUpdated = 0;
    }
  }

  console.log(
    `[backfill] ${shard} DONE updated=${totalUpdated} skipped=${totalSkipped} ` +
      `in ${((Date.now() - t0) / 1000).toFixed(0)}s`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill] failed:", e);
  process.exit(1);
});
