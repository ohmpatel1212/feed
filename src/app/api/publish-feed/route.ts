import { NextRequest, NextResponse } from "next/server";
import { BskyAgent } from "@atproto/api";
import { requireAuth, isAuthError } from "@/lib/auth";
import { getFeedForUser, updateFeed } from "@/lib/pg";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { handle, appPassword, feedName, feedDescription, feedId } =
    await req.json();

  if (!handle || !appPassword) {
    return NextResponse.json(
      { error: "handle and appPassword are required" },
      { status: 400 }
    );
  }

  const hostname = process.env.FEEDGEN_HOSTNAME;
  if (!hostname) {
    return NextResponse.json(
      { error: "FEEDGEN_HOSTNAME not configured on the server" },
      { status: 500 }
    );
  }

  // Verify feed ownership
  if (feedId) {
    const feed = await getFeedForUser(feedId, auth.userId);
    if (!feed) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 });
    }
  }

  try {
    const agent = new BskyAgent({ service: "https://bsky.social" });
    await agent.login({ identifier: handle, password: appPassword });

    const did = agent.session!.did;

    const rkey =
      (feedName || "curated")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || "curated";

    await agent.api.com.atproto.repo.putRecord({
      repo: did,
      collection: "app.bsky.feed.generator",
      rkey,
      record: {
        did: `did:web:${hostname}`,
        displayName: (feedName || "My Curated Feed").slice(0, 24),
        description:
          feedDescription || "AI-curated feed based on my preferences",
        createdAt: new Date().toISOString(),
      },
    });

    if (feedId) {
      await updateFeed(feedId, { published_rkey: rkey });
    }

    const feedUri = `at://${did}/app.bsky.feed.generator/${rkey}`;

    return NextResponse.json({
      ok: true,
      feedUri,
      message: `Feed published! Search "${feedName || "My Curated Feed"}" in Bluesky to find it.`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Authentication failed";
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}
