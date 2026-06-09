import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { repostPost } from "@/lib/bsky-write";
import { jsonError } from "@/lib/api";

/**
 * POST /api/bsky/repost
 * Body: { uri: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { uri } = (await req.json()) as { uri?: string };
  if (!uri) {
    return NextResponse.json({ error: "uri required" }, { status: 400 });
  }

  try {
    const result = await repostPost(auth.userId, uri);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return jsonError(e, "bsky/repost");
  }
}
