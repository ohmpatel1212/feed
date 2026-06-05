import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getUserById } from "@/lib/pg";
import { createSession, likePost, unlikePost, resolvePostCid } from "@/lib/bsky-agent";
import { restoreBskySession } from "@/lib/bsky-oauth";

/**
 * POST /api/bsky/like
 * Body: { uri: string, action: "like" | "unlike", likeUri?: string }
 *
 * Tries OAuth session first, falls back to app password.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const body = await req.json();
  const { uri, action, likeUri } = body as {
    uri: string;
    action: "like" | "unlike";
    likeUri?: string;
  };

  if (!uri || !action) {
    return NextResponse.json(
      { error: "uri and action required" },
      { status: 400 }
    );
  }

  const user = await getUserById(auth.userId);
  if (!user?.bluesky_did) {
    return NextResponse.json(
      { error: "Bluesky account not connected." },
      { status: 403 }
    );
  }

  try {
    // Try OAuth session first
    let oauthSession;
    try {
      oauthSession = await restoreBskySession(user.bluesky_did);
    } catch {
      // No OAuth session — fall back to app password
    }

    if (oauthSession) {
      // Use OAuth session's authenticated fetch
      const pdsUrl = oauthSession.serverMetadata.issuer;

      if (action === "like") {
        const cid = await resolvePostCid(uri);
        const res = await oauthSession.fetchHandler(
          "/xrpc/com.atproto.repo.createRecord",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: user.bluesky_did,
              collection: "app.bsky.feed.like",
              record: {
                $type: "app.bsky.feed.like",
                subject: { uri, cid },
                createdAt: new Date().toISOString(),
              },
            }),
          }
        );
        if (!res.ok) throw new Error(`Like failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return NextResponse.json({ ok: true, likeUri: data.uri });
      } else if (action === "unlike" && likeUri) {
        const parts = likeUri.split("/");
        const rkey = parts[parts.length - 1];
        const res = await oauthSession.fetchHandler(
          "/xrpc/com.atproto.repo.deleteRecord",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: user.bluesky_did,
              collection: "app.bsky.feed.like",
              rkey,
            }),
          }
        );
        if (!res.ok) throw new Error(`Unlike failed: ${res.status} ${await res.text()}`);
        return NextResponse.json({ ok: true });
      }
    }

    // Fallback: app password
    if (!user.bluesky_handle || !user.bsky_app_password) {
      return NextResponse.json(
        { error: "Bluesky not connected. Sign in with Bluesky in settings." },
        { status: 403 }
      );
    }

    const session = await createSession(user.bluesky_handle, user.bsky_app_password);

    if (action === "like") {
      const cid = await resolvePostCid(uri);
      const resultUri = await likePost(session, uri, cid);
      return NextResponse.json({ ok: true, likeUri: resultUri });
    } else if (action === "unlike" && likeUri) {
      await unlikePost(session, likeUri);
      return NextResponse.json({ ok: true });
    } else {
      return NextResponse.json(
        { error: "For unlike, likeUri is required" },
        { status: 400 }
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[bsky/like] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
