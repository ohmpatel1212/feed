import { NextRequest, NextResponse } from "next/server";
import { handleBskyOAuthCallback, getOAuthStateUserId } from "@/lib/bsky-oauth";
import { query } from "@/lib/pg";

/**
 * GET /oauth/callback?state=...&iss=...&code=...
 *
 * Bluesky redirects here after the user authorizes. We look up which user
 * started this flow (stored in the OAuth state table, not in cookies),
 * exchange the code for tokens, link the DID, restore the session, and
 * redirect to the curator.
 */
export async function GET(req: NextRequest) {
  const base = process.env.NEXT_PUBLIC_URL || req.nextUrl.origin;

  try {
    const params = req.nextUrl.searchParams;
    const stateKey = params.get("state");

    if (!stateKey) {
      throw new Error("Missing state parameter");
    }

    // Look up the userId from the state table BEFORE the callback consumes it
    const userId = await getOAuthStateUserId(stateKey);
    console.log("[oauth/callback] state:", stateKey, "userId from state table:", userId);

    if (!userId) {
      throw new Error("OAuth session expired — please try connecting again.");
    }

    // Exchange the authorization code for tokens (this consumes the state)
    const { did } = await handleBskyOAuthCallback(
      new URLSearchParams(params.toString())
    );

    console.log("[oauth/callback] token exchange success, did:", did);

    // Resolve handle from DID
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

    console.log("[oauth/callback] resolved handle:", handle);

    // Link Bluesky DID + handle to the original user
    await query(
      `UPDATE users SET bluesky_did = $1, bluesky_handle = $2, name = COALESCE(NULLIF(name, 'Anonymous'), $2), updated_at = now() WHERE id = $3`,
      [did, handle ?? null, userId]
    );

    // Restore the original session cookie so the browser picks up the
    // correct user on the redirect — crucial when cookies were stripped
    // during the cross-site redirect (incognito, strict privacy settings).
    const originalUser = await query(
      `SELECT session_id FROM users WHERE id = $1`,
      [userId]
    );
    const originalSessionId = originalUser.rows[0]?.session_id;

    console.log("[oauth/callback] restoring session_id:", originalSessionId);

    const response = NextResponse.redirect(`${base}/curator?bsky_connected=1`);
    if (originalSessionId) {
      response.cookies.set("sid", originalSessionId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oauth/callback] error:", msg);
    return NextResponse.redirect(
      `${base}/curator?bsky_error=${encodeURIComponent(msg)}`
    );
  }
}
