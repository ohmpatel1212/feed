import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerKey } from "@/lib/auth";
import { insertPost, assignPostToFeed } from "@/lib/pg";

export async function POST(req: NextRequest) {
  if (!verifyWorkerKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { posts } = await req.json();

  if (!Array.isArray(posts)) {
    return NextResponse.json(
      { error: "posts array required" },
      { status: 400 }
    );
  }

  let inserted = 0;

  for (const p of posts) {
    if (!p.uri || !p.cid || !p.did || p.text == null || typeof p.feed_id !== "number") {
      continue;
    }

    const postId = await insertPost({
      uri: p.uri,
      cid: p.cid,
      authorDid: p.did,
      text: p.text,
      embedding: p.embedding,
      hasMedia: p.has_media,
      hasLink: p.has_link,
      hasQuote: p.has_quote,
      isReply: p.is_reply,
      lang: p.lang,
      hashtags: p.hashtags,
      charLength: p.char_length,
    });

    await assignPostToFeed({
      feedId: p.feed_id,
      postId,
      embeddingScore: p.embedding_score,
      judgeApproved: p.judge_approved,
      finalScore: p.score ?? 0,
    });

    inserted++;
  }

  return NextResponse.json({ inserted });
}
