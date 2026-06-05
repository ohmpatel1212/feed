import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { startBskyOAuth, setPendingOAuthUserId } from "@/lib/bsky-oauth";

/**
 * POST /api/bsky/oauth/authorize
 * Body: { handle: string }
 *
 * Starts the Bluesky OAuth flow. Stores the userId in the OAuth state
 * row so the callback can link the DID to the correct user — even when
 * cookies don't survive the cross-site redirect (e.g. incognito mode).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { handle } = await req.json();
  if (!handle || typeof handle !== "string") {
    return NextResponse.json({ error: "handle required" }, { status: 400 });
  }

  try {
    // Store userId so the state store can persist it alongside the PKCE state
    setPendingOAuthUserId(auth.userId);
    const url = await startBskyOAuth(handle.trim().replace(/^@/, ""));
    return NextResponse.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[bsky/oauth/authorize] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
