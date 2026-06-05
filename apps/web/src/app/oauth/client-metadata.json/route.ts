import { NextResponse } from "next/server";
import { getBskyOAuthClient } from "@/lib/bsky-oauth";

/**
 * GET /oauth/client-metadata.json
 *
 * Serves the OAuth client metadata document that Bluesky's authorization
 * server fetches to verify the client during the OAuth flow.
 */
export function GET() {
  const client = getBskyOAuthClient();
  return NextResponse.json(client.clientMetadata, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
