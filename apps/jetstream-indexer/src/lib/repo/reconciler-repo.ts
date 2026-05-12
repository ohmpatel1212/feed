// Reads dirty post_engagement rows + their cached embedding vectors for the
// Vertex reconciler. Marks them pushed on success.

import { query } from '../pg.js'

export type DirtyRow = {
  uri: string
  did: string
  created_at_us: number
  like_count: number
  repost_count: number
  reply_count: number
  quote_count: number
  langs: string[]
  has_images: boolean
  has_video: boolean
  has_quote: boolean
  has_external_link: boolean
  is_reply: boolean
  self_labels: string[]
  hashtags: string[]
  mention_dids: string[]
  domains: string[]
  image_count: number
  embedding_vec: Buffer | null
}

export const fetchDirtyRows = async (limit: number): Promise<DirtyRow[]> => {
  const res = await query<{
    uri: string
    did: string
    created_at_us: string
    like_count: number
    repost_count: number
    reply_count: number
    quote_count: number
    langs: string[]
    has_images: boolean
    has_video: boolean
    has_quote: boolean
    has_external_link: boolean
    is_reply: boolean
    self_labels: string[]
    hashtags: string[]
    mention_dids: string[]
    domains: string[]
    image_count: number
    embedding_vec: Buffer | null
  }>(
    `SELECT
       pe.uri, p.did, p.created_at_us,
       pe.like_count, pe.repost_count, pe.reply_count, pe.quote_count,
       p.langs, p.has_images, p.has_video, p.has_quote, p.has_external_link,
       (p.reply_parent_uri IS NOT NULL) AS is_reply,
       p.self_labels, p.hashtags, p.mention_dids, p.domains, p.image_count,
       p.embedding_vec
     FROM bsky.post_engagement pe
     JOIN bsky.posts p USING (uri)
     WHERE p.embedding_vec IS NOT NULL
       AND (pe.last_pushed_to_vertex_at IS NULL OR pe.updated_at > pe.last_pushed_to_vertex_at)
     ORDER BY pe.updated_at ASC
     LIMIT $1`,
    [limit],
  )
  return res.rows.map((r) => ({
    uri: r.uri,
    did: r.did,
    created_at_us: Number(r.created_at_us),
    like_count: r.like_count,
    repost_count: r.repost_count,
    reply_count: r.reply_count,
    quote_count: r.quote_count,
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
    image_count: r.image_count,
    embedding_vec: r.embedding_vec,
  }))
}

export const markPushed = async (uris: string[]): Promise<void> => {
  if (uris.length === 0) return
  await query(
    `UPDATE bsky.post_engagement SET last_pushed_to_vertex_at = now()
       WHERE uri = ANY($1::text[])`,
    [uris],
  )
}

export const oldestDirtyAgeSeconds = async (): Promise<number | null> => {
  const res = await query<{ age_s: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(updated_at)))::int AS age_s
       FROM bsky.post_engagement
      WHERE last_pushed_to_vertex_at IS NULL OR updated_at > last_pushed_to_vertex_at`,
  )
  return res.rows[0]?.age_s ?? null
}
