import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerKey } from "@/lib/auth";
import { getActiveFeeds } from "@/lib/pg";

export async function GET(req: NextRequest) {
  if (!verifyWorkerKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const feeds = await getActiveFeeds();

  return NextResponse.json({
    feeds: feeds.map((f) => ({
      id: f.id,
      user_id: f.user_id,
      name: f.name,
      mechanical_filters: f.mechanical_filters,
      semantic_config: f.semantic_config,
    })),
  });
}
