// Wipes bsky.* tables and rewinds all consumer cursors to N days ago.
// On next worker start the four consumers replay from there (subject to
// Jetstream's retention — see INDEXER_EXPANSION_PLAN.html section 8).
//
// Vertex Vector Search points are NOT explicitly removed by this script:
//   - There's no scan-all-and-delete primitive cheap enough for a demo.
//   - Live upserts overwrite by datapoint ID (UUID v5 of URI) — so each post
//     that gets re-indexed naturally replaces its old point.
//   - Old orphans (posts not in the replay window) are filtered out by the
//     Postgres hydration JOIN on the read side — they're invisible to users.
//
// Run with:
//   cd apps/jetstream-indexer
//   npx tsx scripts/wipe-and-rewind.ts [days]
//
// `days` defaults to 4. Set to 0 to start from "now - 60s" (essentially live).

import { runMigrations } from '../src/lib/migrator.js'
import { closePool, withClient } from '../src/lib/pg.js'

const main = async () => {
  const days = parseInt(process.argv[2] ?? '4', 10)
  if (!Number.isFinite(days) || days < 0) {
    console.error('usage: tsx scripts/wipe-and-rewind.ts [days>=0]')
    process.exit(1)
  }

  await runMigrations()

  const rewindUs =
    days === 0
      ? Date.now() * 1000 - 60_000_000
      : Date.now() * 1000 - days * 24 * 60 * 60 * 1_000_000

  const host = process.env.JETSTREAM_HOST ?? 'jetstream2.us-west.bsky.network'

  await withClient(async (c) => {
    console.log('[wipe] TRUNCATE bsky.posts CASCADE (clears post_engagement)')
    await c.query('TRUNCATE TABLE bsky.posts CASCADE')
    console.log('[wipe] TRUNCATE bsky.authors')
    await c.query('TRUNCATE TABLE bsky.authors')
    console.log('[wipe] TRUNCATE bsky.handles_history')
    await c.query('TRUNCATE TABLE bsky.handles_history')
    console.log(`[wipe] rewind cursors to ${new Date(rewindUs / 1000).toISOString()} (${days}d ago)`)
    for (const consumer of ['post', 'engagement', 'profile']) {
      await c.query(
        `INSERT INTO bsky.consumer_state (consumer, cursor_us, host)
         VALUES ($1, $2, $3)
         ON CONFLICT (consumer) DO UPDATE SET
           cursor_us = EXCLUDED.cursor_us, host = EXCLUDED.host, updated_at = now()`,
        [consumer, rewindUs, host],
      )
    }
  })

  console.log('[wipe] done. Restart the worker to begin replay.')
  await closePool()
}

main().catch((err) => {
  console.error('[wipe] failed:', err)
  process.exit(1)
})
