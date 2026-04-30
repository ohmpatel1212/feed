import { NextResponse } from "next/server";
import { getPublishedFeeds } from "@/lib/pg";

export async function GET() {
  const hostname = process.env.FEEDGEN_HOSTNAME || "localhost";
  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID || "";

  const feeds = await getPublishedFeeds();

  return NextResponse.json({
    did: `did:web:${hostname}`,
    feeds: feeds.map((f) => ({
      uri: `at://${publisherDid}/app.bsky.feed.generator/${f.published_rkey}`,
    })),
  });
}
