// Retention prune: deletes posts ingested more than cfg.retentionDays ago,
// in batches, together with their post_engagement rows (authors are kept).
// Caps the HNSW index size — the supported feed windows are capped at the
// same retention (see PGVECTOR_MIGRATION_PLAN.md Decision #4).
//
// Anchored on ingested_at_us, NOT created_at: created_at is client-supplied
// and contains garbage at both extremes (years 0001 and 2999 observed), so a
// created_at prune would never reclaim future-dated junk. ingested_at_us is
// our own clock and has a btree index (0003_pgvector.sql).
//
// Runs inside the indexer worker — if the worker is down, the index just
// grows until it's back (acceptable; not breakage). The Jetstream parquet
// archive in GCS retains raw posts + embeddings beyond retention, so longer
// retention later can be re-backfilled.

import type { Config } from '../config.js'
import { withClient } from '../lib/pg.js'
import { sleep } from './shared.js'

const BATCH = 50_000
const BATCH_PAUSE_MS = 1_000

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, consumer: 'prune', ...fields }))
}

const pruneOnce = async (cfg: Config): Promise<number> => {
  const cutoffUs = (Date.now() - cfg.retentionDays * 86_400_000) * 1000
  let total = 0
  while (true) {
    const t0 = Date.now()
    const n = await withClient(async (c) => {
      const res = await c.query(
        `WITH del AS (
           SELECT uri FROM bsky.posts WHERE ingested_at_us < $1 LIMIT $2
         ), eng AS (
           DELETE FROM bsky.post_engagement pe USING del WHERE pe.uri = del.uri
         )
         DELETE FROM bsky.posts p USING del WHERE p.uri = del.uri`,
        [cutoffUs, BATCH],
      )
      return res.rowCount ?? 0
    })
    total += n
    if (n > 0) log('prune_batch', { n, total, ms: Date.now() - t0 })
    if (n < BATCH) break
    await sleep(BATCH_PAUSE_MS)
  }
  return total
}

export const startPrune = async (cfg: Config): Promise<void> => {
  while (true) {
    try {
      const t0 = Date.now()
      const deleted = await pruneOnce(cfg)
      log('prune_done', { deleted, retention_days: cfg.retentionDays, ms: Date.now() - t0 })
    } catch (err) {
      log('prune_failed', { error: String(err) })
    }
    await sleep(cfg.pruneIntervalMs)
  }
}
