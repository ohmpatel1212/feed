// Reconciler: every N seconds, pushes dirty engagement counts to Vertex as
// numeric_restricts. Uses the cached embedding_vec from bsky.posts so we never
// re-embed during a count flush.

import type { Config } from '../config.js'
import { uriToPointId } from '../lib/hash.js'
import {
  recordFlushFailed,
  recordReconcilerPushed,
  registerOldestDirtyAgeSeconds,
} from '../lib/otel-metrics.js'
import {
  fetchDirtyRows,
  markPushed,
  oldestDirtyAgeSeconds,
  type DirtyRow,
} from '../lib/repo/reconciler-repo.js'
import type { VertexStore, Point } from '../lib/vertex-store.js'
import { sleep } from './shared.js'

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, consumer: 'reconciler', ...fields }))
}

const unpackFloat32 = (buf: Buffer): number[] => {
  // node Buffer is a Uint8Array — slice into Float32Array.
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  return Array.from(arr)
}

const rowToPoint = async (r: DirtyRow): Promise<Point | null> => {
  if (!r.embedding_vec) return null
  return {
    id: await uriToPointId(r.uri),
    vector: unpackFloat32(r.embedding_vec),
    uri: r.uri,
    did: r.did,
    langs: r.langs,
    has_images: r.has_images,
    has_video: r.has_video,
    has_quote: r.has_quote,
    has_external_link: r.has_external_link,
    is_reply: r.is_reply,
    self_labels: r.self_labels,
    hashtags: r.hashtags,
    mention_dids: r.mention_dids,
    domains: r.domains,
    created_at_us: r.created_at_us,
    image_count: r.image_count,
    like_count: r.like_count,
    repost_count: r.repost_count,
    reply_count: r.reply_count,
    quote_count: r.quote_count,
  }
}

export const startVertexReconciler = async (cfg: Config, store: VertexStore, workerId: string): Promise<void> => {
  registerOldestDirtyAgeSeconds(() => {
    // Sampled at metric export time; oldestDirtyAgeSeconds is async, so we
    // keep the most recent observation in a closure-scoped variable updated
    // each tick.
    return lastOldestAgeSeconds
  })
  let lastOldestAgeSeconds: number | null = null

  while (true) {
    try {
      lastOldestAgeSeconds = await oldestDirtyAgeSeconds()
      const rows = await fetchDirtyRows(cfg.reconcilerBatchMax)
      if (rows.length === 0) {
        await sleep(cfg.reconcilerIntervalMs)
        continue
      }
      const t0 = Date.now()
      const points: Point[] = []
      for (const r of rows) {
        const p = await rowToPoint(r)
        if (p) points.push(p)
      }
      await store.upsert(points)
      await markPushed(rows.map((r) => r.uri))
      recordReconcilerPushed(points.length, { worker: workerId })
      log('flush', {
        n: points.length,
        oldest_dirty_s: lastOldestAgeSeconds,
        ms: Date.now() - t0,
      })
    } catch (err) {
      recordFlushFailed(1, { kind: 'reconciler', worker: workerId })
      log('flush_failed', { error: String(err) })
    }
    await sleep(cfg.reconcilerIntervalMs)
  }
}
