import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import OpenAI from "openai";
import http from "http";
import type { SemanticConfig, PostCandidate } from "../src/lib/types";
import { DEFAULT_SEMANTIC_CONFIG } from "../src/lib/defaults";
import { extractMetadata } from "../src/lib/mechanical-filter";

// --- Config ---

const JETSTREAM_URL =
  "wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";
const WEB_URL = process.env.WEB_URL || "http://localhost:3000";
const WORKER_API_KEY = process.env.WORKER_API_KEY || "";
const MAX_PENDING = 2000;
const BATCH_SIZE = 200;
const BATCH_INTERVAL_MS = 3_000;
const PREFS_INTERVAL_MS = 30_000;

const openai = new OpenAI();

// --- Types ---

interface ActiveFeed {
  id: number;
  name: string;
  semantic: SemanticConfig;
  richDescription: string;
  prefEmbedding: number[] | null;
  configHash: string;
}

interface EmbeddingCandidate {
  post: PostCandidate;
  feedId: number;
  feedName: string;
  score: number;
  richDescription: string;
  judgeStrictness: "lenient" | "moderate" | "strict";
}

// --- State ---

let feeds = new Map<number, ActiveFeed>();
let pendingPosts: PostCandidate[] = [];

// --- Embedding helpers ---

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Rich description generation ---

async function generateRichDescription(
  name: string,
  semantic: SemanticConfig
): Promise<string> {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `You generate a detailed paragraph (150-200 words) describing the ideal content for a social media feed. This paragraph will be used as an embedding vector to match incoming posts, so be very specific about what content SHOULD match and implicitly what should NOT. Use concrete language, specific terminology, and example phrases that ideal posts would contain. Do not use generic language.`,
        },
        {
          role: "user",
          content: `Feed name: "${name}"
Topics: ${semantic.topics.join(", ") || "none"}
Keywords: ${semantic.keywords.join(", ") || "none"}
Excluded topics: ${semantic.exclude_topics.join(", ") || "none"}
Excluded keywords: ${semantic.exclude_keywords.join(", ") || "none"}
Vibes: ${semantic.vibes || "none"}

Generate a rich, specific paragraph describing the ideal posts for this feed.`,
        },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim() || "";
    console.log(
      `[rich] Generated description for "${name}" (${text.length} chars)`
    );
    return text;
  } catch (e: any) {
    console.error(`[rich] Failed for "${name}":`, e.message);
    const parts: string[] = [];
    if (semantic.topics.length > 0)
      parts.push(`Topics: ${semantic.topics.join(", ")}`);
    if (semantic.keywords.length > 0)
      parts.push(`Keywords: ${semantic.keywords.join(", ")}`);
    if (semantic.vibes) parts.push(semantic.vibes);
    return parts.join(". ") || "";
  }
}

// --- LLM judge ---

const STRICTNESS_PROMPTS: Record<string, string> = {
  lenient:
    "Be fairly generous — include posts that are at least tangentially related to the feed's topic.",
  moderate:
    "Be selective — only approve posts that are clearly, directly about the feed's topic. Reject vague or tangential posts.",
  strict:
    "Be extremely strict — only approve posts that are deeply, specifically about the feed's core topic. Reject anything that isn't a perfect match.",
};

async function llmJudgeBatch(
  candidates: EmbeddingCandidate[]
): Promise<EmbeddingCandidate[]> {
  if (candidates.length === 0) return [];

  // Group by feed
  const byFeed = new Map<number, EmbeddingCandidate[]>();
  for (const c of candidates) {
    const list = byFeed.get(c.feedId) || [];
    list.push(c);
    byFeed.set(c.feedId, list);
  }

  const approved: EmbeddingCandidate[] = [];

  for (const [feedId, feedCandidates] of byFeed) {
    const feed = feedCandidates[0];
    const strictnessPrompt =
      STRICTNESS_PROMPTS[feed.judgeStrictness] ||
      STRICTNESS_PROMPTS.moderate;

    const postList = feedCandidates
      .map((c, i) => `[${i}] "${c.post.text.slice(0, 200)}"`)
      .join("\n");

    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are a content filter for a curated social media feed.

Feed: "${feed.feedName}"
Description: ${feed.richDescription}

${strictnessPrompt}

Respond ONLY with a JSON array of the index numbers of posts that belong in this feed. Example: [0, 2, 5]`,
          },
          {
            role: "user",
            content: `Which posts belong in "${feed.feedName}"?\n\n${postList}`,
          },
        ],
      });

      const content = res.choices[0]?.message?.content?.trim() || "[]";
      const match = content.match(/\[[\d,\s]*\]/);
      if (match) {
        const approvedIndices: number[] = JSON.parse(match[0]);
        for (const idx of approvedIndices) {
          if (idx >= 0 && idx < feedCandidates.length) {
            approved.push(feedCandidates[idx]);
          }
        }
        console.log(
          `[judge] Feed ${feedId} "${feed.feedName}" (${feed.judgeStrictness}): ${approvedIndices.length}/${feedCandidates.length} approved`
        );
      } else {
        console.warn(
          `[judge] Feed ${feedId}: couldn't parse: ${content.slice(0, 100)}`
        );
      }
    } catch (e: any) {
      console.error(`[judge] Feed ${feedId} error:`, e.message);
      // On failure, let candidates through
      approved.push(...feedCandidates);
    }
  }

  return approved;
}

// --- API calls ---

function workerHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": WORKER_API_KEY,
  };
}

async function refreshFeeds() {
  try {
    const res = await fetch(`${WEB_URL}/api/worker/feeds`, {
      headers: workerHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const serverFeeds: {
      id: number;
      name: string;
      semantic_config: SemanticConfig;
    }[] = data.feeds || [];

    // Remove feeds that no longer exist
    const serverIds = new Set(serverFeeds.map((f) => f.id));
    for (const id of feeds.keys()) {
      if (!serverIds.has(id)) {
        feeds.delete(id);
        console.log(`[prefs] Removed feed ${id}`);
      }
    }

    // Add/update feeds
    for (const sf of serverFeeds) {
      const semantic = { ...DEFAULT_SEMANTIC_CONFIG, ...sf.semantic_config };
      const configHash = JSON.stringify({ semantic });

      const existing = feeds.get(sf.id);
      if (existing && existing.configHash === configHash) {
        continue;
      }

      // Generate rich description and embed it
      const richDescription = await generateRichDescription(sf.name, semantic);
      let prefEmbedding: number[] | null = null;
      if (richDescription) {
        const [vec] = await embed([richDescription]);
        prefEmbedding = vec;
      }

      feeds.set(sf.id, {
        id: sf.id,
        name: sf.name,
        semantic,
        richDescription,
        prefEmbedding,
        configHash,
      });
      console.log(`[prefs] Feed ${sf.id} "${sf.name}" updated`);
    }

    console.log(`[prefs] ${feeds.size} active feed(s)`);
  } catch (e: any) {
    console.error("[prefs] Failed to fetch feeds:", e.message);
  }
}

async function submitPosts(
  posts: {
    uri: string;
    cid: string;
    did: string;
    text: string;
    score: number;
    feed_id: number;
    embedding_score?: number;
    judge_approved?: boolean;
    has_media?: boolean;
    has_link?: boolean;
    has_quote?: boolean;
    is_reply?: boolean;
    lang?: string;
    hashtags?: string[];
    char_length?: number;
  }[]
): Promise<number> {
  try {
    const res = await fetch(`${WEB_URL}/api/worker/posts`, {
      method: "POST",
      headers: workerHeaders(),
      body: JSON.stringify({ posts }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.inserted as number;
  } catch (e: any) {
    console.error("[submit] Failed:", e.message);
    return 0;
  }
}

// --- Semantic keyword exclude (quick pre-check before embedding) ---

function semanticExclude(text: string, semantic: SemanticConfig): boolean {
  const lower = text.toLowerCase();
  for (const kw of semantic.exclude_keywords) {
    if (lower.includes(kw.toLowerCase())) return true;
  }
  for (const topic of semantic.exclude_topics) {
    if (lower.includes(topic.toLowerCase())) return true;
  }
  return false;
}

// --- Batch processing (two-stage pipeline) ---

async function processBatch() {
  if (pendingPosts.length === 0 || feeds.size === 0) return;

  const activeFeedList = [...feeds.values()].filter((f) => f.prefEmbedding);
  if (activeFeedList.length === 0) return;

  const batch = pendingPosts.splice(0, BATCH_SIZE);

  try {
    // ===== Embed all posts =====
    const texts = batch.map((p) => p.text.slice(0, 512));
    const vecs = await embed(texts);

    console.log(`[batch] ${batch.length} posts embedded × ${activeFeedList.length} feeds`);

    // Score every post against every feed
    const candidates: EmbeddingCandidate[] = [];

    for (let i = 0; i < batch.length; i++) {
      const post = batch[i];
      for (const feed of activeFeedList) {
        // Quick keyword exclusion (free check)
        if (semanticExclude(post.text, feed.semantic)) continue;

        const sim = cosine(feed.prefEmbedding!, vecs[i]);
        const scaled = Math.max(0, Math.min(1, (sim - 0.1) / 0.4));

        if (scaled >= feed.semantic.embedding_threshold) {
          candidates.push({
            post,
            feedId: feed.id,
            feedName: feed.name,
            score: scaled,
            richDescription: feed.richDescription,
            judgeStrictness: feed.semantic.judge_strictness,
          });
        }
      }
    }

    if (candidates.length === 0) {
      console.log(
        `[batch] ${batch.length} embedded → 0 above threshold`
      );
      return;
    }

    console.log(
      `[batch] ${batch.length} embedded → ${candidates.length} above threshold → judging`
    );

    // LLM judge pass (for feeds that have it enabled)
    const needsJudge = candidates.filter((c) => {
      const feed = feeds.get(c.feedId)!;
      return feed.semantic.judge_enabled;
    });
    const skipJudge = candidates.filter((c) => {
      const feed = feeds.get(c.feedId)!;
      return !feed.semantic.judge_enabled;
    });

    const judgeApproved =
      needsJudge.length > 0 ? await llmJudgeBatch(needsJudge) : [];
    const allApproved = [...judgeApproved, ...skipJudge];

    if (allApproved.length > 0) {
      const toInsert = allApproved.map((c) => ({
        uri: c.post.uri,
        cid: c.post.cid,
        did: c.post.did,
        text: c.post.text,
        score: c.score,
        feed_id: c.feedId,
        embedding_score: c.score,
        judge_approved: true,
        has_media: c.post.hasMedia,
        has_link: c.post.hasLink,
        has_quote: c.post.hasQuote,
        is_reply: c.post.isReply,
        lang: c.post.langs[0],
        hashtags: c.post.hashtags,
        char_length: c.post.charLength,
      }));
      const inserted = await submitPosts(toInsert);

      console.log(
        `[batch] Inserted ${inserted} posts (${judgeApproved.length} judge-approved, ${skipJudge.length} judge-skipped)`
      );
    } else {
      console.log(`[batch] Judge rejected all ${candidates.length} candidates`);
    }
  } catch (e: any) {
    console.error("[batch] Error:", e.message || e);
  }
}

// --- Firehose connection ---

function connect() {
  console.log("[firehose] Connecting to Jetstream...");
  const ws = new WebSocket(JETSTREAM_URL);

  ws.on("open", () => {
    console.log("[firehose] Connected");
  });

  let seen = 0;
  let extracted = 0;
  let queued = 0;

  ws.on("message", (data: Buffer) => {
    try {
      const event = JSON.parse(data.toString());

      // Use metadata extraction from mechanical-filter module
      const post = extractMetadata(event);
      if (!post) return;

      seen++;

      // Global minimum filter (before per-feed filtering)
      if (post.charLength < 10) return;
      if (!post.text) return;

      extracted++;

      if (pendingPosts.length >= MAX_PENDING) return;

      queued++;
      pendingPosts.push(post);
    } catch {
      // Skip malformed events
    }
  });

  setInterval(() => {
    if (seen > 0) {
      console.log(
        `[stats] ${seen} posts seen, ${extracted} extracted, ${queued} queued, ${pendingPosts.length} pending, ${feeds.size} feeds`
      );
      seen = 0;
      extracted = 0;
      queued = 0;
    }
  }, 10_000);

  ws.on("close", () => {
    console.log("[firehose] Disconnected, reconnecting in 5s...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("[firehose] Error:", err.message);
    ws.close();
  });
}

// --- Health check server ---

const PORT = parseInt(process.env.PORT || "8080");
http
  .createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  })
  .listen(PORT, () => {
    console.log(`[health] Listening on port ${PORT}`);
  });

// --- Main ---

console.log("[feed-curator] Starting firehose worker (embed-all pipeline)...");
console.log(`[config] WEB_URL=${WEB_URL}`);
console.log(`[config] MAX_PENDING=${MAX_PENDING}, BATCH_SIZE=${BATCH_SIZE}`);

refreshFeeds();
setInterval(refreshFeeds, PREFS_INTERVAL_MS);
setInterval(processBatch, BATCH_INTERVAL_MS);

connect();
