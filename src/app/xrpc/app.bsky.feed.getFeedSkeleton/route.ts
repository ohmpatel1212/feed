import { NextRequest, NextResponse } from "next/server";
import { getFeedByRkey, getFeedPosts } from "@/lib/pg";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const limit = Math.min(Number(params.get("limit")) || 50, 100);
  const cursor = params.get("cursor") || undefined;
  const feedUri = params.get("feed") || "";

  // Extract rkey from AT URI: at://did:plc:xxx/app.bsky.feed.generator/{rkey}
  const rkey = feedUri.split("/").pop() || "";

  const feed = rkey ? await getFeedByRkey(rkey) : null;

  if (!feed) {
    return NextResponse.json({ feed: [], cursor: undefined });
  }

  const posts = await getFeedPosts(feed.id, limit, cursor);

  return NextResponse.json({
    feed: posts.map((p) => ({ post: p.uri })),
    cursor:
      posts.length > 0 ? posts[posts.length - 1].indexed_at : undefined,
  });
}
