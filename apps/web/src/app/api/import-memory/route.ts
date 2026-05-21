import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthError } from "@/lib/auth";
import { createFeed, updateFeed } from "@/lib/pg";
import { ensureEnvFromSecret } from "@/lib/secrets";

let _client: Anthropic | null = null;
async function client(): Promise<Anthropic> {
  if (_client) return _client;
  await ensureEnvFromSecret("anthropic-api-key");
  _client = new Anthropic();
  return _client;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { memoryText, source } = await req.json();

  if (!memoryText || typeof memoryText !== "string") {
    return NextResponse.json(
      { error: "memoryText required" },
      { status: 400 }
    );
  }

  const response = await (await client()).messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You analyze AI assistant memory exports (from ChatGPT or Claude) and extract the user's interests, profession, hobbies, and preferences to create a Bluesky feed.

From the memory text, output EXACTLY two lines:
FEED_NAME:<2-4 word name capturing their main interests>
SUBQUERIES_JSON:["...", "...", ...]

Rules for SUBQUERIES_JSON:
- 1 to 4 entries, never more. Most users need 2-3.
- Each entry is a short topical query (5-15 words) describing the kind of content the user would enjoy.
- Each entry is a SINGLE distinct intent. Don't repeat the same idea in different words.
- Shape: a topical query, slightly richer than a keyword list. Specific, not generic.
  - GOOD: "personal essays on AI's effect on creative work"
  - GOOD: "long-form posts about transformer interpretability research"
  - GOOD: "indie game developer postmortems and design discussions"
  - BAD: "AI" (too sparse)
  - BAD: "I want thoughtful AI takes" (embeds the frame, not the content)
- If the memory mentions a job or field, include a subquery for that domain.
- Be generous — extract everything that suggests an interest, but merge overlapping ones into a single subquery.`,
    messages: [
      {
        role: "user",
        content: `Here's a memory export from ${source || "an AI assistant"}:\n\n${memoryText.slice(0, 8000)}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const nameMatch = text.match(/FEED_NAME:(.+)/);
  const subMatch = text.match(/SUBQUERIES_JSON:\s*(\[[\s\S]*?\])/);

  if (!subMatch) {
    return NextResponse.json(
      { error: "Could not extract preferences from memory" },
      { status: 422 }
    );
  }

  try {
    const parsed = JSON.parse(subMatch[1]) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const subqueries = parsed
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 4);
    if (subqueries.length === 0) throw new Error("no usable subqueries");

    const name = nameMatch ? nameMatch[1].trim() : "From AI Memory";

    const feed = await createFeed(auth.userId, name);
    const updated = await updateFeed(feed.id, { name, subqueries });

    return NextResponse.json({ feed: updated ?? feed });
  } catch {
    return NextResponse.json(
      { error: "Failed to parse extracted config" },
      { status: 422 }
    );
  }
}
