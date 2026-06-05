import { getSecret } from "./secrets";

const HIVE_API_URL = "https://api.thehive.ai/api/v2/task/sync";

export interface HiveImageResult {
  ai_generated: boolean;
  score: number;
}

export interface HivePostResult {
  ai_generated: boolean;
  scores: number[];
  error?: boolean;
}

async function getHiveApiKey(): Promise<string | null> {
  try {
    return await getSecret("hive-api-key");
  } catch {
    console.warn("[hive] No Hive API key configured — AI labeling disabled");
    return null;
  }
}

/**
 * Check a single image URL against Hive's AI-generated content detection.
 * Uses the `ai_generated_image_classification` model.
 */
export async function checkImageAiGenerated(
  imageUrl: string,
  apiKey: string
): Promise<HiveImageResult> {
  const res = await fetch(HIVE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: imageUrl }),
  });

  if (!res.ok) {
    console.warn(`[hive] API returned ${res.status} for ${imageUrl}`);
    return { ai_generated: false, score: 0 };
  }

  const json = await res.json();

  // Hive response: status[].response.output[].classes[]
  // Look for the "ai_generated" class across all outputs.
  try {
    const outputs =
      json?.status?.[0]?.response?.output ?? [];
    for (const output of outputs) {
      for (const cls of output.classes ?? []) {
        if (cls.class === "ai_generated") {
          const score = typeof cls.score === "number" ? cls.score : 0;
          return { ai_generated: score >= 0.5, score };
        }
      }
    }
  } catch (e) {
    console.warn("[hive] Failed to parse response:", e);
  }

  return { ai_generated: false, score: 0 };
}

/**
 * Check all images in a post for AI-generated content. Returns true if
 * *any* image scores above the threshold.
 *
 * Fail-soft: returns `{ ai_generated: false, error: true }` when the API
 * key is missing or all calls fail.
 */
export async function checkPostMedia(
  imageUrls: string[]
): Promise<HivePostResult> {
  if (imageUrls.length === 0) {
    return { ai_generated: false, scores: [] };
  }

  const apiKey = await getHiveApiKey();
  if (!apiKey) {
    return { ai_generated: false, scores: [], error: true };
  }

  const results = await Promise.all(
    imageUrls.map((url) =>
      checkImageAiGenerated(url, apiKey).catch((e) => {
        console.warn("[hive] checkImage failed:", e);
        return { ai_generated: false, score: 0 } as HiveImageResult;
      })
    )
  );

  const scores = results.map((r) => r.score);
  const ai_generated = results.some((r) => r.ai_generated);

  return { ai_generated, scores };
}
