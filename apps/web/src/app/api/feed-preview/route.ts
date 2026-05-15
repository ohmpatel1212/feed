/**
 * GET /api/feed-preview?feedId=N[&rerank=1]
 *
 * Two response shapes:
 *
 * 1. Default (rerank not requested, or feed has no rerank_prompt): plain JSON
 *    `{ total_stored, mechanical_filters, semantic_config, posts: FeedPreviewPost[] }`
 *    with up to 50 posts in vector-similarity order. Same shape the curator
 *    used before the reranker existed.
 *
 * 2. rerank=1 and feed.rerank_prompt is non-null: NDJSON stream, two lines:
 *
 *    {"phase":"vector","posts":FeedPreviewPost[50],"vectorOrder":string[50],"mechanical_filters":...,"semantic_config":...}
 *    {"phase":"rerank","rerankedOrder":string[<=50],"additionalPosts":FeedPreviewPost[],"ms_rerank":int}
 *
 *    Phase 1 flushes immediately (within ~vector-search latency). Phase 2
 *    arrives after the Sonnet reranker returns. `additionalPosts` carries
 *    any post the reranker pulled out of the 51-200 vector tail; the client
 *    merges them into its post map so the render-union pattern can reorder
 *    without refetching.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  getFeedForUser,
  getFeedPreviewPosts,
  buildSearchQuery,
  mechanicalToSearchFilter,
  vectorHitToFeedPost,
  type FeedPreviewPost,
} from "@/lib/pg";
import { searchPosts } from "@/lib/vector-search";
import { rerank } from "@/lib/rerank";

const VECTOR_K = 200;
const DISPLAY_K = 50;
const RERANK_K = 50;

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const tAuth = performance.now();

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));
  const rerankRequested = req.nextUrl.searchParams.get("rerank") === "1";

  if (!feedId) {
    return NextResponse.json({ total_stored: 0, posts: [] });
  }

  const feed = await getFeedForUser(feedId, auth.userId);
  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });
  }
  const tFeed = performance.now();

  // Fall back to the simple JSON path when rerank wasn't requested OR the
  // chat agent hasn't drafted a rerank_prompt yet for this feed. The curator
  // toggle should already disable itself when feed.rerank_prompt is null, so
  // this branch is the back-compat path.
  if (!rerankRequested || !feed.rerank_prompt) {
    const posts = await getFeedPreviewPosts(feedId, DISPLAY_K);
    const tPosts = performance.now();
    console.log(
      `[timing] GET /api/feed-preview auth=${(tAuth - t0).toFixed(0)}ms ` +
        `feed-lookup=${(tFeed - tAuth).toFixed(0)}ms ` +
        `posts=${(tPosts - tFeed).toFixed(0)}ms ` +
        `total=${(tPosts - t0).toFixed(0)}ms feedId=${feedId}`
    );
    return NextResponse.json({
      total_stored: posts.length,
      mechanical_filters: feed.mechanical_filters,
      semantic_config: feed.semantic_config,
      posts,
    });
  }

  // Rerank path — stream NDJSON. We deliberately do the vector recall up to
  // VECTOR_K here (not via getFeedPreviewPosts) so we keep the full 200-hit
  // candidate set in memory for the reranker call after phase 1 flushes.
  const queryText = buildSearchQuery(feed);
  const filter = mechanicalToSearchFilter(feed.mechanical_filters);

  const tVec0 = performance.now();
  let hits: Awaited<ReturnType<typeof searchPosts>> = [];
  try {
    hits = queryText
      ? await searchPosts({ query: queryText, k: VECTOR_K, filter })
      : [];
  } catch (e) {
    console.warn(
      "[feed-preview] vector search failed:",
      e instanceof Error ? e.message : String(e)
    );
  }
  const msVector = Math.round(performance.now() - tVec0);

  const allPosts = hits.map(vectorHitToFeedPost);
  const vectorOrder = allPosts.slice(0, DISPLAY_K).map((p) => p.uri);

  const encoder = new TextEncoder();
  const rerankPrompt = feed.rerank_prompt;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Phase 1 — flush immediately so the curator can paint the vector
      // ordering before Sonnet returns.
      controller.enqueue(
        encoder.encode(
          JSON.stringify({
            phase: "vector",
            posts: allPosts.slice(0, DISPLAY_K),
            vectorOrder,
            mechanical_filters: feed.mechanical_filters,
            semantic_config: feed.semantic_config,
            ms_vector: msVector,
          }) + "\n"
        )
      );

      // Phase 2 — rerank against the full 200-hit candidate set.
      let rerankedOrder: string[] = [];
      let additionalPosts: FeedPreviewPost[] = [];
      let msRerank: number | null = null;
      let rerankError: string | null = null;
      try {
        const r = await rerank({
          query: queryText,
          candidates: hits,
          topK: RERANK_K,
          systemPrompt: rerankPrompt,
        });
        rerankedOrder = r.kept
          .map((k) => allPosts[k.i]?.uri)
          .filter((u): u is string => !!u);
        msRerank = r.ms_rerank;

        const vectorTopSet = new Set(vectorOrder);
        additionalPosts = rerankedOrder
          .filter((u) => !vectorTopSet.has(u))
          .map((u) => allPosts.find((p) => p.uri === u))
          .filter((p): p is FeedPreviewPost => !!p);
      } catch (e) {
        rerankError = e instanceof Error ? e.message : String(e);
      }

      const msTotal = Math.round(performance.now() - t0);
      const payload: Record<string, unknown> = {
        phase: "rerank",
        rerankedOrder,
        additionalPosts,
        ms_rerank: msRerank,
        ms_total: msTotal,
      };
      if (rerankError) payload.error = rerankError;
      controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));
      controller.close();

      console.log(
        `[timing] GET /api/feed-preview (rerank) auth=${(tAuth - t0).toFixed(0)}ms ` +
          `feed-lookup=${(tFeed - tAuth).toFixed(0)}ms ` +
          `vector=${msVector}ms hits=${hits.length} ` +
          `rerank=${msRerank ?? "—"}ms kept=${rerankedOrder.length} ` +
          `additional=${additionalPosts.length} total=${msTotal}ms feedId=${feedId}`
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
