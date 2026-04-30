import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool } from "pg";
import OpenAI from "openai";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI();

// Topic clusters with example handles and formats
const CLUSTERS: { cluster: string; format: string; prompt: string }[] = [
  { cluster: "ai-research", format: "technical", prompt: "Write 6 realistic Bluesky posts from AI researchers discussing transformer architectures, LLM reasoning, RLHF, open-source model releases, benchmark results, or training techniques. Mix tones: some excited about breakthroughs, some skeptical, some sharing paper links." },
  { cluster: "ai-product", format: "general", prompt: "Write 6 realistic Bluesky posts from people discussing AI products, startups, ChatGPT usage, AI tools for productivity, or the AI industry. Mix perspectives: founders, skeptics, enthusiastic users." },
  { cluster: "ai-art", format: "visual", prompt: "Write 6 realistic Bluesky posts from digital artists discussing AI-generated art, Midjourney, Stable Diffusion, creative coding, or generative art processes." },
  { cluster: "web-dev", format: "technical", prompt: "Write 6 realistic Bluesky posts from web developers discussing React, TypeScript, Next.js, web performance, CSS tricks, or frontend architecture. Include some hot takes and some helpful tips." },
  { cluster: "indie-dev", format: "general", prompt: "Write 6 realistic Bluesky posts from indie hackers and bootstrapped founders sharing launch updates, revenue milestones, lessons learned, or side project progress." },
  { cluster: "science", format: "technical", prompt: "Write 6 realistic Bluesky posts from scientists sharing research findings, discussing papers in neuroscience, physics, biology, or commenting on scientific methodology." },
  { cluster: "climate", format: "essay", prompt: "Write 6 realistic Bluesky posts about climate science, renewable energy data, sustainability policy, or environmental research. Mix data-driven posts with opinion pieces." },
  { cluster: "philosophy", format: "essay", prompt: "Write 6 realistic Bluesky posts from people discussing philosophy of mind, ethics of technology, existentialism, epistemology, or modern philosophical questions. Thoughtful, not academic jargon." },
  { cluster: "books-lit", format: "essay", prompt: "Write 6 realistic Bluesky posts from readers and book lovers recommending novels, reviewing literary fiction, sharing reading lists, or discussing authors and writing craft." },
  { cluster: "visual-art", format: "visual", prompt: "Write 6 realistic Bluesky posts from photographers, illustrators, and artists sharing their work process, discussing exhibitions, or commenting on visual culture and design." },
  { cluster: "music", format: "general", prompt: "Write 6 realistic Bluesky posts from music enthusiasts discussing album reviews, music production, jazz, electronic music, or the music industry." },
  { cluster: "cooking", format: "general", prompt: "Write 6 realistic Bluesky posts from home cooks and food enthusiasts sharing recipes, cooking techniques, fermentation projects, or food culture observations." },
  { cluster: "fitness-health", format: "general", prompt: "Write 6 realistic Bluesky posts about strength training, nutrition science, running, mental health, or wellness — from both evidence-based and personal experience perspectives." },
  { cluster: "politics-policy", format: "essay", prompt: "Write 6 realistic Bluesky posts offering policy analysis, commenting on governance, democracy, or political developments. Thoughtful analysis, not partisan rage." },
  { cluster: "gaming", format: "general", prompt: "Write 6 realistic Bluesky posts from gamers and game developers discussing game design, indie games, retro gaming, or gaming culture." },
  { cluster: "nature", format: "visual", prompt: "Write 6 realistic Bluesky posts from nature enthusiasts sharing birdwatching observations, hiking experiences, marine biology facts, or wildlife photography moments." },
  { cluster: "finance", format: "general", prompt: "Write 6 realistic Bluesky posts about investing, personal finance, economics analysis, or market commentary. Mix beginner-friendly and sophisticated takes." },
  { cluster: "humor", format: "shitpost", prompt: "Write 6 realistic Bluesky shitposts — absurd humor, meme references, surreal observations, self-deprecating jokes, or internet culture commentary. Keep them short and punchy." },
];

const SYSTEM_PROMPT = `You generate realistic social media posts for a Bluesky-like platform. Each post should:
- Be 40-280 characters (short social posts, not essays)
- Feel authentic — like a real person wrote it, not a brand
- Have distinct voice and personality
- NOT include hashtags or @mentions
- NOT be generic or corporate sounding

Output EXACTLY as a JSON array of objects with "text" and "handle" fields.
Example: [{"text":"just spent 3 hours debugging a CSS grid issue only to realize I had a typo in 'grid-template-columns'. I am a professional.","handle":"webdev-sarah.bsky.social"}]

Use varied, realistic-sounding handles (name.bsky.social format). Each post should feel like it came from a different person.`;

async function generatePosts(prompt: string): Promise<{ text: string; handle: string }[]> {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.9,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    const content = res.choices[0]?.message?.content?.trim() || "[]";
    // Extract JSON array from response
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return [];
  } catch (e: any) {
    console.warn(`Generation failed: ${e.message}`);
    return [];
  }
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts.map((t) => t.slice(0, 512)),
  });
  return res.data.map((d) => d.embedding);
}

interface CardRow {
  uri: string;
  text: string;
  author_handle: string;
  topic_cluster: string;
  vibe_tags: string[];
  format: string;
  embedding: number[];
}

async function main() {
  console.log("Seeding onboarding card bank (LLM-generated)...\n");
  const allCards: CardRow[] = [];
  let cardIndex = 0;

  for (const { cluster, format, prompt } of CLUSTERS) {
    console.log(`[${cluster}] Generating posts...`);
    const posts = await generatePosts(prompt);

    if (posts.length === 0) {
      console.log(`  [${cluster}] No posts generated.`);
      continue;
    }

    // Filter valid posts
    const good = posts.filter(
      (p) => p.text && p.text.length >= 30 && p.text.length <= 600 && p.handle
    );

    if (good.length === 0) {
      console.log(`  [${cluster}] No valid posts after filtering.`);
      continue;
    }

    // Embed
    const texts = good.map((p) => p.text);
    const embeddings = await embedTexts(texts);

    for (let i = 0; i < good.length; i++) {
      const p = good[i];
      // Generate a synthetic URI since these aren't real posts
      const syntheticUri = `at://did:plc:seed${cardIndex}/app.bsky.feed.post/${Date.now().toString(36)}${cardIndex}`;
      cardIndex++;

      allCards.push({
        uri: syntheticUri,
        text: p.text,
        author_handle: p.handle,
        topic_cluster: cluster,
        vibe_tags: [],
        format,
        embedding: embeddings[i],
      });
    }
    console.log(`  [${cluster}] ${good.length} cards prepared.`);

    // Small delay between clusters to avoid rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nInserting ${allCards.length} cards into database...`);

  let inserted = 0;
  for (const card of allCards) {
    try {
      await pool.query(
        `INSERT INTO onboarding_cards (uri, text, author_handle, topic_cluster, vibe_tags, format, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
         ON CONFLICT (uri) DO UPDATE SET
           text = EXCLUDED.text,
           author_handle = EXCLUDED.author_handle,
           topic_cluster = EXCLUDED.topic_cluster,
           embedding = EXCLUDED.embedding`,
        [
          card.uri,
          card.text,
          card.author_handle,
          card.topic_cluster,
          card.vibe_tags,
          card.format,
          `[${card.embedding.join(",")}]`,
        ]
      );
      inserted++;
    } catch (e: any) {
      console.warn(`  Failed to insert ${card.uri}: ${e.message}`);
    }
  }

  console.log(`\nDone. ${inserted}/${allCards.length} cards inserted.`);
  await pool.end();
}

main();
