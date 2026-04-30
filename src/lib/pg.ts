import { Pool, type PoolClient, type QueryResult } from "pg";
import type {
  FeedConfig,
  MechanicalFilters,
  SemanticConfig,
  PostCandidate,
} from "./types";
import { withFeedConfigDefaults } from "./defaults";

// --- Connection Pool ---

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on("error", (err) => {
      console.error("[pg] Unexpected pool error:", err.message);
    });
  }
  return _pool;
}

export async function query(
  text: string,
  params?: unknown[]
): Promise<QueryResult> {
  return getPool().query(text, params);
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// --- User ---

export interface DbUser {
  id: string; // UUID
  firebase_uid: string;
  name: string;
  email: string;
  photo_url: string | null;
  bluesky_handle: string | null;
  bluesky_did: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertUser(params: {
  firebaseUid: string;
  name: string;
  email: string;
  photoUrl?: string;
  blueskyHandle?: string;
  blueskyDid?: string;
}): Promise<DbUser> {
  const res = await query(
    `INSERT INTO users (firebase_uid, name, email, photo_url, bluesky_handle, bluesky_did)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (firebase_uid) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
       bluesky_handle = COALESCE(EXCLUDED.bluesky_handle, users.bluesky_handle),
       bluesky_did = COALESCE(EXCLUDED.bluesky_did, users.bluesky_did),
       updated_at = now()
     RETURNING *`,
    [
      params.firebaseUid,
      params.name,
      params.email,
      params.photoUrl ?? null,
      params.blueskyHandle ?? null,
      params.blueskyDid ?? null,
    ]
  );
  return res.rows[0];
}

export async function getUserByFirebaseUid(
  firebaseUid: string
): Promise<DbUser | null> {
  const res = await query("SELECT * FROM users WHERE firebase_uid = $1", [
    firebaseUid,
  ]);
  return res.rows[0] ?? null;
}

// --- Feeds ---

export interface DbFeed {
  id: number;
  user_id: string;
  name: string;
  description: string;
  mechanical_filters: MechanicalFilters;
  semantic_config: SemanticConfig;
  published_rkey: string | null;
  is_active: boolean;
  color: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DbFeedRow {
  id: number;
  user_id: string;
  name: string;
  description: string;
  mechanical_filters: MechanicalFilters | string;
  semantic_config: SemanticConfig | string;
  published_rkey: string | null;
  is_active: boolean;
  color: string | null;
  created_at: Date;
  updated_at: Date;
}

function parseJsonCol<T>(val: T | string): T {
  return typeof val === "string" ? JSON.parse(val) : val;
}

function rowToFeed(row: DbFeedRow): DbFeed {
  const config = withFeedConfigDefaults({
    mechanical: parseJsonCol(row.mechanical_filters),
    semantic: parseJsonCol(row.semantic_config),
  });
  return {
    ...row,
    mechanical_filters: config.mechanical,
    semantic_config: config.semantic,
  };
}

export async function createFeed(
  userId: string,
  name: string = "Untitled"
): Promise<DbFeed> {
  const res = await query(
    `INSERT INTO feeds (user_id, name) VALUES ($1, $2) RETURNING *`,
    [userId, name]
  );
  return rowToFeed(res.rows[0]);
}

export async function getFeed(id: number): Promise<DbFeed | null> {
  const res = await query("SELECT * FROM feeds WHERE id = $1", [id]);
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function getFeedForUser(
  id: number,
  userId: string
): Promise<DbFeed | null> {
  const res = await query(
    "SELECT * FROM feeds WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function listFeedsForUser(userId: string): Promise<DbFeed[]> {
  const res = await query(
    "SELECT * FROM feeds WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId]
  );
  return res.rows.map(rowToFeed);
}

export async function getFeedByRkey(rkey: string): Promise<DbFeed | null> {
  const res = await query(
    "SELECT * FROM feeds WHERE published_rkey = $1",
    [rkey]
  );
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function getPublishedFeeds(): Promise<DbFeed[]> {
  const res = await query(
    "SELECT * FROM feeds WHERE published_rkey IS NOT NULL ORDER BY updated_at DESC"
  );
  return res.rows.map(rowToFeed);
}

export async function getActiveFeeds(): Promise<DbFeed[]> {
  const res = await query(
    "SELECT * FROM feeds WHERE is_active = true ORDER BY id"
  );
  return res.rows.map(rowToFeed);
}

export async function updateFeed(
  id: number,
  updates: {
    name?: string;
    description?: string;
    mechanical_filters?: MechanicalFilters;
    semantic_config?: SemanticConfig;
    published_rkey?: string;
    is_active?: boolean;
    color?: string;
  }
): Promise<DbFeed | null> {
  const feed = await getFeed(id);
  if (!feed) return null;

  const res = await query(
    `UPDATE feeds SET
       name = $1, description = $2,
       mechanical_filters = $3, semantic_config = $4,
       published_rkey = $5, is_active = $6, color = $7,
       updated_at = now()
     WHERE id = $8 RETURNING *`,
    [
      updates.name ?? feed.name,
      updates.description ?? feed.description,
      JSON.stringify(updates.mechanical_filters ?? feed.mechanical_filters),
      JSON.stringify(updates.semantic_config ?? feed.semantic_config),
      updates.published_rkey ?? feed.published_rkey,
      updates.is_active ?? feed.is_active,
      updates.color ?? feed.color,
      id,
    ]
  );
  return res.rows[0] ? rowToFeed(res.rows[0]) : null;
}

export async function deleteFeed(id: number): Promise<void> {
  await query("DELETE FROM chat_messages WHERE feed_id = $1", [id]);
  await query("DELETE FROM feed_posts WHERE feed_id = $1", [id]);
  await query("DELETE FROM feeds WHERE id = $1", [id]);
}

// --- Posts ---

export async function insertPost(params: {
  uri: string;
  cid: string;
  authorDid: string;
  text: string;
  embedding?: number[];
  hasMedia?: boolean;
  hasLink?: boolean;
  hasQuote?: boolean;
  isReply?: boolean;
  lang?: string;
  hashtags?: string[];
  charLength?: number;
}): Promise<number> {
  const embeddingStr = params.embedding
    ? `[${params.embedding.join(",")}]`
    : null;
  const res = await query(
    `INSERT INTO posts (uri, cid, author_did, text, embedding, has_media, has_link, has_quote, is_reply, lang, hashtags, char_length)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (uri) DO UPDATE SET
       embedding = COALESCE(EXCLUDED.embedding, posts.embedding),
       indexed_at = now()
     RETURNING id`,
    [
      params.uri,
      params.cid,
      params.authorDid,
      params.text,
      embeddingStr,
      params.hasMedia ?? false,
      params.hasLink ?? false,
      params.hasQuote ?? false,
      params.isReply ?? false,
      params.lang ?? null,
      params.hashtags ?? [],
      params.charLength ?? params.text.length,
    ]
  );
  return res.rows[0].id;
}

export async function assignPostToFeed(params: {
  feedId: number;
  postId: number;
  embeddingScore?: number;
  judgeApproved?: boolean;
  finalScore: number;
}): Promise<void> {
  await query(
    `INSERT INTO feed_posts (feed_id, post_id, embedding_score, judge_approved, final_score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (feed_id, post_id) DO UPDATE SET
       embedding_score = EXCLUDED.embedding_score,
       judge_approved = EXCLUDED.judge_approved,
       final_score = EXCLUDED.final_score`,
    [
      params.feedId,
      params.postId,
      params.embeddingScore ?? null,
      params.judgeApproved ?? null,
      params.finalScore,
    ]
  );
}

export async function getFeedPosts(
  feedId: number,
  limit: number = 50,
  cursor?: string
): Promise<{ uri: string; indexed_at: string }[]> {
  if (cursor) {
    const res = await query(
      `SELECT p.uri, p.indexed_at::text as indexed_at
       FROM feed_posts fp
       JOIN posts p ON p.id = fp.post_id
       WHERE fp.feed_id = $1 AND p.indexed_at < $2
       ORDER BY fp.final_score DESC, p.indexed_at DESC
       LIMIT $3`,
      [feedId, cursor, limit]
    );
    return res.rows;
  }
  const res = await query(
    `SELECT p.uri, p.indexed_at::text as indexed_at
     FROM feed_posts fp
     JOIN posts p ON p.id = fp.post_id
     WHERE fp.feed_id = $1
     ORDER BY fp.final_score DESC, p.indexed_at DESC
     LIMIT $2`,
    [feedId, limit]
  );
  return res.rows;
}

export async function getFeedPreviewPosts(
  feedId: number,
  limit: number = 20
): Promise<
  {
    uri: string;
    text: string;
    author_did: string;
    score: number;
    indexed_at: string;
  }[]
> {
  const res = await query(
    `SELECT p.uri, p.text, p.author_did, fp.final_score as score, p.indexed_at::text as indexed_at
     FROM feed_posts fp
     JOIN posts p ON p.id = fp.post_id
     WHERE fp.feed_id = $1
     ORDER BY fp.final_score DESC, p.indexed_at DESC
     LIMIT $2`,
    [feedId, limit]
  );
  return res.rows;
}

export async function pruneOldPosts(keepDays: number = 7): Promise<void> {
  await query(
    `DELETE FROM posts WHERE indexed_at < now() - interval '1 day' * $1
     AND id NOT IN (SELECT post_id FROM feed_posts)`,
    [keepDays]
  );
}

// --- Chat Messages ---

export async function getChatMessages(
  feedId: number
): Promise<{ role: string; content: string }[]> {
  const res = await query(
    "SELECT role, content FROM chat_messages WHERE feed_id = $1 ORDER BY id ASC",
    [feedId]
  );
  return res.rows;
}

export async function addChatMessage(
  feedId: number,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  await query(
    "INSERT INTO chat_messages (feed_id, role, content) VALUES ($1, $2, $3)",
    [feedId, role, content]
  );
}

export async function clearChat(feedId: number): Promise<void> {
  await query("DELETE FROM chat_messages WHERE feed_id = $1", [feedId]);
}

// --- Onboarding Card Bank ---

export interface OnboardingCard {
  id: number;
  uri: string;
  text: string;
  author_handle: string;
  topic_cluster: string;
  vibe_tags: string[];
  format: string;
}

export async function findCardsByEmbedding(
  embedding: number[],
  limit: number = 12,
  excludeUris: string[] = []
): Promise<OnboardingCard[]> {
  const embStr = `[${embedding.join(",")}]`;
  const res = excludeUris.length > 0
    ? await query(
        `SELECT id, uri, text, author_handle, topic_cluster, vibe_tags, format
         FROM onboarding_cards
         WHERE uri != ALL($2)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [embStr, excludeUris, limit]
      )
    : await query(
        `SELECT id, uri, text, author_handle, topic_cluster, vibe_tags, format
         FROM onboarding_cards
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [embStr, limit]
      );
  return res.rows;
}

export async function findCardsActiveLearning(
  attractEmbedding: number[],
  repelEmbedding: number[] | null,
  limit: number = 8,
  excludeUris: string[] = []
): Promise<OnboardingCard[]> {
  const attractStr = `[${attractEmbedding.join(",")}]`;

  if (!repelEmbedding) {
    return findCardsByEmbedding(attractEmbedding, limit, excludeUris);
  }

  const repelStr = `[${repelEmbedding.join(",")}]`;
  const res = await query(
    `SELECT id, uri, text, author_handle, topic_cluster, vibe_tags, format,
            (1 - (embedding <=> $1::vector)) - 0.5 * (1 - (embedding <=> $2::vector)) AS score
     FROM onboarding_cards
     WHERE uri != ALL($3)
     ORDER BY score DESC
     LIMIT $4`,
    [attractStr, repelStr, excludeUris, limit]
  );
  return res.rows;
}

export async function getCardEmbeddings(
  uris: string[]
): Promise<{ uri: string; embedding: number[] }[]> {
  if (uris.length === 0) return [];
  const res = await query(
    `SELECT uri, embedding::text FROM onboarding_cards WHERE uri = ANY($1)`,
    [uris]
  );
  return res.rows.map((r: { uri: string; embedding: string }) => ({
    uri: r.uri,
    embedding: JSON.parse(r.embedding),
  }));
}

export async function getCardCount(): Promise<number> {
  const res = await query("SELECT COUNT(*) as count FROM onboarding_cards");
  return parseInt(res.rows[0].count);
}

// --- Onboarding State Persistence ---

export async function saveOnboardingState(
  feedId: number,
  state: Record<string, unknown>
): Promise<void> {
  // Delete existing system message for this feed, then insert new one
  await query(
    "DELETE FROM chat_messages WHERE feed_id = $1 AND role = 'system'",
    [feedId]
  );
  await query(
    "INSERT INTO chat_messages (feed_id, role, content) VALUES ($1, 'system', $2)",
    [feedId, JSON.stringify(state)]
  );
}

export async function loadOnboardingState(
  feedId: number
): Promise<Record<string, unknown> | null> {
  const res = await query(
    "SELECT content FROM chat_messages WHERE feed_id = $1 AND role = 'system' ORDER BY id DESC LIMIT 1",
    [feedId]
  );
  if (res.rows.length === 0) return null;
  try {
    return JSON.parse(res.rows[0].content);
  } catch {
    return null;
  }
}
