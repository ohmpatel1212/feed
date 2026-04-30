import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { requireAuth, isAuthError } from "@/lib/auth";
import {
  getFeedForUser,
  updateFeed,
  addChatMessage,
  getChatMessages,
  saveOnboardingState,
  loadOnboardingState,
  findCardsByEmbedding,
  findCardsActiveLearning,
  getCardEmbeddings,
  query as pgQuery,
} from "@/lib/pg";
import type { SemanticConfig } from "@/lib/types";

const anthropic = new Anthropic();
const openai = new OpenAI();

// --- Embedding helper ---

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts.map((t) => t.slice(0, 512)),
  });
  return res.data.map((d) => d.embedding);
}

function averageEmbeddings(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) avg[i] += v[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= vectors.length;
  return avg;
}

// --- System Prompts ---

const STAGE1_SYSTEM = `You are a taste architect helping someone build a personalized Bluesky feed. You lead aggressively — you do most of the talking. The user only taps options, never types.

STYLE:
- Be presumptuous. Make educated guesses. "You seem like someone who..." is good.
- 1 sentence of observation/personality, then 4-5 options. No filler. No "Great choice!"
- Options should narrow from broad to specific. Think tree navigation — each round cuts the possibility space in half.
- Be specific. Not "Technology" but "You're watching the AI labs race" or "You care about the craft of building software."
- Be slightly opinionated and fun. This should feel like talking to a friend who gets it, not filling out a form.

OUTPUT FORMAT (every response MUST end with this JSON block):
Your conversational text here — 1-2 sentences max.

STAGE1_JSON:{"options":["option1","option2","option3","option4","option5"],"domain_narrowed":false,"domain_path":["broad","narrower"]}

When you've identified a specific enough domain (typically after 3-5 rounds), set domain_narrowed:true and also include:
"preliminary_topics":["topic1","topic2","topic3"],"preliminary_keywords":["kw1","kw2","kw3","kw4","kw5"]

The preliminary_topics should be 2-4 broad topic labels. The preliminary_keywords should be 5-10 specific terms, jargon, project names, or community slang that people in this space actually use.

IMPORTANT:
- Always output exactly the STAGE1_JSON block at the end. No markdown code fences around it.
- The domain_path should accumulate — add to it each round, don't replace.
- 4-5 options per round. The last option should always be something unexpected or cross-cutting ("Actually, none of these — I'm more into..." or a surprising adjacent space).`;

const STAGE2_COMMENTARY_SYSTEM = `You analyze someone's content preferences based on what they selected vs skipped. Be specific, slightly opinionated, pattern-noticing.

In 1-2 sentences, describe the pattern you see. Examples of good tone:
- "You keep tapping the technical deep-dives but skipping the opinion pieces — you want substance over heat."
- "Interesting — you're drawn to the personal essays but not the listicles. You want voice, not format."
- "You skipped every post that opened with a hot take. You might just not be a discourse-feed person."

Do NOT be generic. Do NOT say "you seem to like interesting content." Be concrete about what pattern you see.`;

const STAGE3_SYSTEM = `You synthesize a user's taste profile based on their feed curation session. You will be given:
1. The domain they navigated to (their path through broad → specific options)
2. The posts they selected vs skipped in 2-3 rounds of card selection

Your job is to:
1. Generate 3 concise, specific taste statements that describe their preferences
2. Generate a feed name (2-4 words, punchy, memorable)
3. Generate a full SemanticConfig

OUTPUT FORMAT (all three blocks required):
TASTE_STATEMENTS:[{"text":"statement1"},{"text":"statement2"},{"text":"statement3"}]
FEED_NAME:Short Punchy Name
SEMANTIC_CONFIG_JSON:{"topics":["topic1","topic2"],"keywords":["specific1","specific2","specific3","specific4","specific5","specific6","specific7","specific8","specific9","specific10","specific11","specific12","specific13","specific14","specific15"],"exclude_topics":["excluded1"],"exclude_keywords":["excluded1","excluded2"],"vibes":"detailed description of tone, energy, what makes it click","embedding_threshold":0.5,"judge_enabled":true,"judge_strictness":"moderate"}

RULES:
- Taste statements should be specific and surprising, not generic. Not "You like technology" but "You want the lab notes, not the press releases."
- For keywords: generate 15-25 SPECIFIC keywords. Not just "AI" — think "transformer architecture", "GPT-4", "diffusion models", "RLHF", "open source LLMs". Include jargon, project names, community slang.
- For vibes: be detailed about tone. "Technical but accessible, favors original research over commentary, appreciates dry humor, prefers threads over hot takes."
- For exclude_topics and exclude_keywords: infer from what they consistently skipped.
- Set judge_strictness based on how picky their selections were: if they tapped most cards → "lenient", selective → "moderate", very few → "strict".`;

// --- Stage Handlers ---

async function handleStage1(
  feedId: number,
  selectedOption: string | undefined,
  conversationHistory: { role: "user" | "assistant"; content: string }[]
) {
  // Build messages for Claude
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  if (conversationHistory.length === 0 && !selectedOption) {
    // First round — kickoff
    messages.push({
      role: "user",
      content: "Hey, I want to build a new feed. Help me figure out what I want.",
    });
  } else {
    // Reconstruct from history
    messages.push(...conversationHistory);
    if (selectedOption) {
      messages.push({ role: "user", content: selectedOption });
    }
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    system: STAGE1_SYSTEM,
    messages,
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // Parse STAGE1_JSON (with or without prefix)
  const jsonMatch = text.match(/(?:STAGE1_JSON:)?(\{[\s\S]*"options"[\s\S]*\})/);
  let parsed: {
    options: string[];
    domain_narrowed: boolean;
    domain_path: string[];
    preliminary_topics?: string[];
    preliminary_keywords?: string[];
  } = { options: [], domain_narrowed: false, domain_path: [] };

  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[1]);
    } catch {
      // Fallback: try to extract just the first complete JSON object
      const braceStart = jsonMatch[1].indexOf("{");
      let depth = 0, end = -1;
      for (let i = braceStart; i < jsonMatch[1].length; i++) {
        if (jsonMatch[1][i] === "{") depth++;
        if (jsonMatch[1][i] === "}") depth--;
        if (depth === 0) { end = i + 1; break; }
      }
      if (end > 0) {
        try { parsed = JSON.parse(jsonMatch[1].slice(braceStart, end)); } catch { /* use defaults */ }
      }
    }
  }

  // Clean display text (remove JSON block with or without prefix)
  const displayText = text
    .replace(/STAGE1_JSON:\{[\s\S]*\}/, "")
    .replace(/\{[\s\S]*"options"[\s\S]*\}/, "")
    .trim();

  return {
    botText: displayText,
    options: parsed.options,
    domainIdentified: parsed.domain_narrowed,
    domainPath: parsed.domain_path,
    preliminaryTopics: parsed.preliminary_topics,
    preliminaryKeywords: parsed.preliminary_keywords,
    rawAssistantText: text,
  };
}

async function handleStage2Cards(
  round: number,
  domainEmbedding: number[],
  selectedUris: string[],
  skippedUris: string[]
) {
  const allExcluded = [...selectedUris, ...skippedUris];

  if (round === 1) {
    // First round: pure similarity to domain
    return findCardsByEmbedding(domainEmbedding, 6, allExcluded);
  }

  // Rounds 2+: active learning
  let attractEmb = domainEmbedding;
  let repelEmb: number[] | null = null;

  if (selectedUris.length > 0) {
    const selectedEmbeddings = await getCardEmbeddings(selectedUris);
    if (selectedEmbeddings.length > 0) {
      attractEmb = averageEmbeddings(selectedEmbeddings.map((e) => e.embedding));
    }
  }

  if (skippedUris.length > 0) {
    const skippedEmbeddings = await getCardEmbeddings(skippedUris);
    if (skippedEmbeddings.length > 0) {
      repelEmb = averageEmbeddings(skippedEmbeddings.map((e) => e.embedding));
    }
  }

  const limit = round === 2 ? 5 : 4;
  return findCardsActiveLearning(attractEmb, repelEmb, limit, allExcluded);
}

async function handleStage2Commentary(
  selectedTexts: string[],
  skippedTexts: string[]
) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 150,
    system: STAGE2_COMMENTARY_SYSTEM,
    messages: [
      {
        role: "user",
        content: `SELECTED (posts they tapped):\n${selectedTexts.map((t, i) => `${i + 1}. "${t.slice(0, 200)}"`).join("\n")}\n\nSKIPPED (posts they passed on):\n${skippedTexts.map((t, i) => `${i + 1}. "${t.slice(0, 200)}"`).join("\n")}`,
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text.trim() : "";
}

async function handleStage3Synthesis(
  domainPath: string[],
  allSelectedTexts: string[],
  allSkippedTexts: string[]
) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: STAGE3_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Domain path: ${domainPath.join(" > ")}

POSTS THEY SELECTED (these represent what they want):
${allSelectedTexts.map((t, i) => `${i + 1}. "${t.slice(0, 250)}"`).join("\n")}

POSTS THEY SKIPPED (these represent what they don't want):
${allSkippedTexts.map((t, i) => `${i + 1}. "${t.slice(0, 250)}"`).join("\n")}

Synthesize their taste profile.`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // Parse outputs
  let tasteStatements: { text: string }[] = [];
  let feedName = "My Feed";
  let semanticConfig: SemanticConfig | null = null;

  const tasteMatch = text.match(/TASTE_STATEMENTS:\[[\s\S]*?\]/);
  if (tasteMatch) {
    try {
      tasteStatements = JSON.parse(tasteMatch[0].replace("TASTE_STATEMENTS:", ""));
    } catch { /* use empty */ }
  }

  const nameMatch = text.match(/FEED_NAME:(.+)/);
  if (nameMatch) {
    feedName = nameMatch[1].trim();
  }

  const configMatch = text.match(/SEMANTIC_CONFIG_JSON:(\{[\s\S]*\})/);
  if (configMatch) {
    try {
      semanticConfig = JSON.parse(configMatch[1]);
    } catch { /* null */ }
  }

  return { tasteStatements, feedName, semanticConfig };
}

async function handleStage3FollowUp(
  domainPath: string[],
  offStatement: string,
  allSelectedTexts: string[],
  allSkippedTexts: string[]
) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: `You're a taste architect. The user said one of your taste assessments was "off." Ask a single targeted follow-up question with 3-4 options to clarify. Be specific, not generic. Output format:

Your question here.

FOLLOWUP_JSON:{"options":["option1","option2","option3"]}`,
    messages: [
      {
        role: "user",
        content: `Domain: ${domainPath.join(" > ")}
The statement they disagreed with: "${offStatement}"
Posts they liked: ${allSelectedTexts.slice(0, 5).map((t) => `"${t.slice(0, 100)}"`).join(", ")}
Posts they skipped: ${allSkippedTexts.slice(0, 5).map((t) => `"${t.slice(0, 100)}"`).join(", ")}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const displayText = text.replace(/FOLLOWUP_JSON:\{[\s\S]*\}/, "").trim();

  let options: string[] = [];
  const jsonMatch = text.match(/FOLLOWUP_JSON:(\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      options = parsed.options || [];
    } catch { /* empty */ }
  }

  return { question: displayText, options };
}

// --- Main POST handler ---

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  try {
    const body = await req.json();
    const { feedId, stage, round, selectedOption, selectedUris, skippedUris, reactions, followUpAnswer, favoriteCreators } = body;

    if (!feedId) {
      return NextResponse.json({ error: "feedId required" }, { status: 400 });
    }

    const feed = await getFeedForUser(feedId, auth.userId);
    if (!feed) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 });
    }

    // Load persisted state
    const savedState = (await loadOnboardingState(feedId)) || {};

    if (stage === "s1_prompting") {
      // Reconstruct conversation history from chat_messages
      const history = await getChatMessages(feedId);
      const conversationHistory = history
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      // If user selected an option, store it
      if (selectedOption) {
        await addChatMessage(feedId, "user", selectedOption);
        conversationHistory.push({ role: "user", content: selectedOption });
      }

      const result = await handleStage1(feedId, selectedOption, conversationHistory);

      // Store assistant response
      await addChatMessage(feedId, "assistant", result.rawAssistantText);

      // If domain is identified, compute domain embedding
      let domainEmbedding: number[] | null = null;
      if (result.domainIdentified && result.preliminaryTopics && result.preliminaryKeywords) {
        const domainText = [
          ...result.preliminaryTopics,
          ...result.preliminaryKeywords,
        ].join(", ");
        const [vec] = await embed([domainText]);
        domainEmbedding = vec;
      }

      // Save state
      const newState = {
        ...savedState,
        stage: result.domainIdentified ? "s2_cards" : "s1_prompting",
        domainPath: result.domainPath,
        preliminaryTopics: result.preliminaryTopics || savedState.preliminaryTopics,
        preliminaryKeywords: result.preliminaryKeywords || savedState.preliminaryKeywords,
        domainEmbedding: domainEmbedding || savedState.domainEmbedding,
        s2Round: 0,
        allSelectedUris: [],
        allSkippedUris: [],
        allSelectedTexts: [],
        allSkippedTexts: [],
      };
      await saveOnboardingState(feedId, newState);

      return NextResponse.json({
        botText: result.botText,
        options: result.options,
        domainIdentified: result.domainIdentified,
        domainPath: result.domainPath,
      });
    }

    if (stage === "s2_cards") {
      const domainEmbedding = savedState.domainEmbedding as number[];
      if (!domainEmbedding) {
        return NextResponse.json({ error: "No domain embedding — complete stage 1 first" }, { status: 400 });
      }

      const currentRound = (round as number) || 1;
      const prevSelectedUris = (savedState.allSelectedUris as string[]) || [];
      const prevSkippedUris = (savedState.allSkippedUris as string[]) || [];

      // If this is a new round request (not submitting selections), fetch cards
      if (!selectedUris) {
        const cards = await handleStage2Cards(
          currentRound,
          domainEmbedding,
          prevSelectedUris,
          prevSkippedUris
        );
        return NextResponse.json({ cards, round: currentRound });
      }

      // User submitted selections for this round
      const newSelectedUris = (selectedUris as string[]) || [];
      const newSkippedUris = (skippedUris as string[]) || [];

      // Get card texts from the onboarding_cards table
      const allCardUris = [...newSelectedUris, ...newSkippedUris];
      const textRes = allCardUris.length > 0
        ? await pgQuery(
            "SELECT uri, text FROM onboarding_cards WHERE uri = ANY($1)",
            [allCardUris]
          )
        : { rows: [] };
      const textMap = new Map(textRes.rows.map((r: { uri: string; text: string }) => [r.uri, r.text]));

      const selectedTexts = newSelectedUris.map((u) => textMap.get(u) || "").filter(Boolean);
      const skippedTexts = newSkippedUris.map((u) => textMap.get(u) || "").filter(Boolean);

      // Accumulate
      const allSelectedUris = [...prevSelectedUris, ...newSelectedUris];
      const allSkippedUris = [...prevSkippedUris, ...newSkippedUris];
      const allSelectedTexts = [
        ...((savedState.allSelectedTexts as string[]) || []),
        ...selectedTexts,
      ];
      const allSkippedTexts = [
        ...((savedState.allSkippedTexts as string[]) || []),
        ...skippedTexts,
      ];

      // Generate bot commentary
      const commentary = selectedTexts.length > 0
        ? await handleStage2Commentary(selectedTexts, skippedTexts)
        : "";

      // Determine if we should do another round
      const maxRounds = 3;
      const nextRound = currentRound + 1;
      const isDone = currentRound >= maxRounds;

      // Save state
      await saveOnboardingState(feedId, {
        ...savedState,
        stage: isDone ? "s3_resolution" : "s2_cards",
        s2Round: currentRound,
        allSelectedUris,
        allSkippedUris,
        allSelectedTexts,
        allSkippedTexts,
      });

      if (isDone) {
        return NextResponse.json({
          commentary,
          roundComplete: true,
          stageComplete: true,
          nextStage: "s3_resolution",
        });
      }

      // Fetch next round's cards
      const nextCards = await handleStage2Cards(
        nextRound,
        domainEmbedding,
        allSelectedUris,
        allSkippedUris
      );

      return NextResponse.json({
        commentary,
        cards: nextCards,
        round: nextRound,
        roundComplete: true,
        stageComplete: false,
      });
    }

    if (stage === "s3_resolution") {
      const domainPath = (savedState.domainPath as string[]) || [];
      const allSelectedTexts = (savedState.allSelectedTexts as string[]) || [];
      const allSkippedTexts = (savedState.allSkippedTexts as string[]) || [];

      // Initial synthesis request
      if (!reactions && !followUpAnswer) {
        const result = await handleStage3Synthesis(
          domainPath,
          allSelectedTexts,
          allSkippedTexts
        );

        await saveOnboardingState(feedId, {
          ...savedState,
          tasteStatements: result.tasteStatements,
          feedName: result.feedName,
          semanticConfig: result.semanticConfig,
        });

        return NextResponse.json({
          tasteStatements: result.tasteStatements,
          feedName: result.feedName,
        });
      }

      // User reacted to taste statements
      if (reactions) {
        const typedReactions = reactions as { text: string; reaction: "up" | "kinda" | "off" }[];
        const offStatements = typedReactions.filter((r) => r.reaction === "off");

        if (offStatements.length > 0) {
          // Generate follow-up for the first "off" statement
          const followUp = await handleStage3FollowUp(
            domainPath,
            offStatements[0].text,
            allSelectedTexts,
            allSkippedTexts
          );

          await saveOnboardingState(feedId, {
            ...savedState,
            offStatement: offStatements[0].text,
            awaitingFollowUp: true,
          });

          return NextResponse.json({
            followUpQuestion: followUp.question,
            followUpOptions: followUp.options,
          });
        }

        // All good — finalize
        const config = savedState.semanticConfig as SemanticConfig;
        const name = savedState.feedName as string;

        if (config) {
          const description = [
            ...(config.topics || []),
            ...(config.keywords || []).slice(0, 5),
            config.vibes,
          ]
            .filter(Boolean)
            .join(", ");
          await updateFeed(feedId, {
            name,
            description,
            semantic_config: config,
          });
        }

        return NextResponse.json({
          done: true,
          feedName: name,
          semanticConfig: config,
        });
      }

      // Follow-up answer — re-synthesize with correction
      if (followUpAnswer) {
        const offStatement = savedState.offStatement as string;
        const correctionContext = `The user disagreed with "${offStatement}" and clarified: "${followUpAnswer}"`;

        // Re-synthesize with correction
        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
          system: STAGE3_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Domain path: ${domainPath.join(" > ")}

POSTS THEY SELECTED:
${allSelectedTexts.map((t, i) => `${i + 1}. "${t.slice(0, 250)}"`).join("\n")}

POSTS THEY SKIPPED:
${allSkippedTexts.map((t, i) => `${i + 1}. "${t.slice(0, 250)}"`).join("\n")}

CORRECTION: ${correctionContext}

Synthesize their taste profile, incorporating the correction.`,
            },
          ],
        });

        const text = response.content[0].type === "text" ? response.content[0].text : "";

        let semanticConfig: SemanticConfig | null = null;
        let feedName = (savedState.feedName as string) || "My Feed";

        const configMatch = text.match(/SEMANTIC_CONFIG_JSON:(\{[\s\S]*\})/);
        if (configMatch) {
          try { semanticConfig = JSON.parse(configMatch[1]); } catch { /* null */ }
        }

        const nameMatch = text.match(/FEED_NAME:(.+)/);
        if (nameMatch) feedName = nameMatch[1].trim();

        if (semanticConfig) {
          const description = [
            ...(semanticConfig.topics || []),
            ...(semanticConfig.keywords || []).slice(0, 5),
            semanticConfig.vibes,
          ]
            .filter(Boolean)
            .join(", ");
          await updateFeed(feedId, {
            name: feedName,
            description,
            semantic_config: semanticConfig,
          });
        }

        await saveOnboardingState(feedId, {
          ...savedState,
          semanticConfig,
          feedName,
          awaitingFollowUp: false,
        });

        return NextResponse.json({
          done: true,
          feedName,
          semanticConfig,
        });
      }
    }

    // Load state endpoint (for refresh recovery)
    if (stage === "load") {
      return NextResponse.json({ state: savedState });
    }

    return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    console.error("Onboarding API error:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET handler for loading persisted state
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const feedId = Number(req.nextUrl.searchParams.get("feedId"));
  if (!feedId) {
    return NextResponse.json({ error: "feedId required" }, { status: 400 });
  }

  const feed = await getFeedForUser(feedId, auth.userId);
  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 });
  }

  const state = await loadOnboardingState(feedId);
  return NextResponse.json({ state: state || {} });
}
