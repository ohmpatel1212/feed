import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { handleBskyOAuthCallback } from "@/lib/bsky-oauth";
import { query } from "@/lib/pg";
import { jsonError } from "@/lib/api";

/**
 * POST /api/bsky/oauth/callback
 * Body: { params: string } — the full query string from the OAuth redirect
 *
 * Exchanges the authorization code for tokens and links the Bluesky DID
 * to the current anonymous session user.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();

  const { params } = await req.json();
  if (!params || typeof params !== "string") {
    return NextResponse.json({ error: "params required" }, { status: 400 });
  }

  try {
    const { did } = await handleBskyOAuthCallback(new URLSearchParams(params));

    // Resolve the handle from the DID via the PLC directory
    let handle: string | undefined;
    try {
      const res = await fetch(`https://plc.directory/${did}`);
      if (res.ok) {
        const doc = await res.json();
        const aka = doc?.alsoKnownAs?.[0];
        if (aka && aka.startsWith("at://")) {
          handle = aka.replace("at://", "");
        }
      }
    } catch { /* non-fatal */ }

    // Link Bluesky DID + handle to the current session user
    await query(
      `UPDATE users SET bluesky_did = $1, bluesky_handle = $2, updated_at = now() WHERE id = $3`,
      [did, handle ?? null, auth.userId]
    );

    return NextResponse.json({ ok: true, did, handle });
  } catch (e) {
    return jsonError(e, "bsky/oauth/callback");
  }
}
