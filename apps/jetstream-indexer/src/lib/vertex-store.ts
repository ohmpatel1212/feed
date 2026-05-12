// Vertex Vector Search write-side wrapper.
// Datapoints carry the vector + filter restricts ONLY — no text or other
// payload. Full post body lives in Postgres (bsky.posts).

import { v1 } from '@google-cloud/aiplatform'
import type { Config } from '../config.js'

const { IndexServiceClient, MatchServiceClient } = v1

export type Point = {
  id: string
  vector: number[]
  // uri is a single-valued restrict so the read side can map findNeighbors
  // results back to bsky.posts without a separate point_id → uri table.
  uri: string
  // Restricts: string-valued filters. allowList items must be non-empty.
  did: string
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
  // Numeric restricts.
  created_at_us: number
  image_count: number
  like_count: number
  repost_count: number
  reply_count: number
  quote_count: number
}

const indexResource = (cfg: Config): string =>
  `projects/${cfg.gcpProject}/locations/${cfg.gcpLocation}/indexes/${cfg.vertexIndexId}`

const endpointResource = (cfg: Config): string =>
  `projects/${cfg.gcpProject}/locations/${cfg.gcpLocation}/indexEndpoints/${cfg.vertexIndexEndpointId}`

const boolToken = (b: boolean): string => (b ? 'true' : 'false')

const chunked = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const parseMissingIds = (msg: string): Set<string> => {
  const head = msg.split(' entity does not exist')[0] ?? ''
  return new Set(head.split(',').map((s) => s.trim()).filter(Boolean))
}

const buildDatapoint = (p: Point) => {
  const restricts: Array<{ namespace: string; allowList: string[] }> = [
    { namespace: 'uri', allowList: [p.uri] },
    { namespace: 'did', allowList: [p.did] },
    { namespace: 'has_images', allowList: [boolToken(p.has_images)] },
    { namespace: 'has_video', allowList: [boolToken(p.has_video)] },
    { namespace: 'has_quote', allowList: [boolToken(p.has_quote)] },
    { namespace: 'has_external_link', allowList: [boolToken(p.has_external_link)] },
    { namespace: 'is_reply', allowList: [boolToken(p.is_reply)] },
  ]
  if (p.langs.length) restricts.push({ namespace: 'langs', allowList: p.langs })
  if (p.self_labels.length) restricts.push({ namespace: 'self_labels', allowList: p.self_labels })
  if (p.hashtags.length) restricts.push({ namespace: 'hashtags', allowList: p.hashtags })
  if (p.mention_dids.length) restricts.push({ namespace: 'mention_dids', allowList: p.mention_dids })
  if (p.domains.length) restricts.push({ namespace: 'domains', allowList: p.domains })

  const numericRestricts = [
    { namespace: 'schema_v', valueInt: '2' },
    { namespace: 'created_at_us', valueInt: String(p.created_at_us) },
    { namespace: 'image_count', valueInt: String(p.image_count) },
    { namespace: 'like_count', valueInt: String(p.like_count) },
    { namespace: 'repost_count', valueInt: String(p.repost_count) },
    { namespace: 'reply_count', valueInt: String(p.reply_count) },
    { namespace: 'quote_count', valueInt: String(p.quote_count) },
  ]

  return {
    datapointId: p.id,
    featureVector: p.vector,
    restricts,
    numericRestricts,
  }
}

export class VertexStore {
  private cfg: Config
  private indexClient: InstanceType<typeof IndexServiceClient>
  private matchClient: InstanceType<typeof MatchServiceClient>

  constructor(cfg: Config) {
    if (!cfg.vertexIndexId) throw new Error('VERTEX_INDEX_ID is not set')
    if (!cfg.vertexIndexEndpointId) throw new Error('VERTEX_INDEX_ENDPOINT_ID is not set')
    if (!cfg.vertexIndexEndpointHost) throw new Error('VERTEX_INDEX_ENDPOINT_HOST is not set')
    if (!cfg.vertexDeployedIndexId) throw new Error('VERTEX_DEPLOYED_INDEX_ID is not set')

    this.cfg = cfg
    this.indexClient = new IndexServiceClient({
      apiEndpoint: `${cfg.gcpLocation}-aiplatform.googleapis.com`,
    })
    this.matchClient = new MatchServiceClient({
      apiEndpoint: cfg.vertexIndexEndpointHost,
    })
  }

  async ensureCollection(): Promise<void> {
    await this.indexClient.getIndex({ name: indexResource(this.cfg) })
  }

  async hasMany(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const out = new Set<string>()
    for (const batch of chunked(ids, 100)) {
      try {
        const [resp] = await this.matchClient.readIndexDatapoints({
          indexEndpoint: endpointResource(this.cfg),
          deployedIndexId: this.cfg.vertexDeployedIndexId,
          ids: batch,
        })
        for (const dp of resp.datapoints ?? []) {
          if (dp.datapointId) out.add(dp.datapointId)
        }
      } catch (err: any) {
        if (err?.code !== 5) throw err
        const missing = parseMissingIds(err.details ?? err.message ?? '')
        for (const id of batch) if (!missing.has(id)) out.add(id)
      }
    }
    return out
  }

  async upsert(points: Point[]): Promise<void> {
    if (points.length === 0) return
    for (const batch of chunked(points, 100)) {
      await this.indexClient.upsertDatapoints({
        index: indexResource(this.cfg),
        datapoints: batch.map(buildDatapoint),
      })
    }
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    for (const batch of chunked(ids, 100)) {
      await this.indexClient.removeDatapoints({
        index: indexResource(this.cfg),
        datapointIds: batch,
      })
    }
  }
}
