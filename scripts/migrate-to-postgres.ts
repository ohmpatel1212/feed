/**
 * One-time migration: SQLite → PostgreSQL
 *
 * Creates a default user for existing single-tenant data,
 * then copies feeds, posts, and chat messages.
 *
 * Usage: npx tsx scripts/migrate-to-postgres.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import Database from "better-sqlite3";
import { Pool } from "pg";
import path from "path";

const SQLITE_PATH = path.join(process.cwd(), "feed.db");
const DEFAULT_FIREBASE_UID = "migration-default-user";

async function main() {
  // Open SQLite
  let sqlite: Database.Database;
  try {
    sqlite = new Database(SQLITE_PATH, { readonly: true });
  } catch {
    console.log("No feed.db found — nothing to migrate.");
    return;
  }

  const pg = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log("Starting migration from SQLite → PostgreSQL...");

    // 1. Create default user
    const userRes = await pg.query(
      `INSERT INTO users (firebase_uid, name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (firebase_uid) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [DEFAULT_FIREBASE_UID, "Default User", "migrated@localhost"]
    );
    const userId = userRes.rows[0].id;
    console.log(`Default user: ${userId}`);

    // 2. Migrate feeds
    const feeds = sqlite
      .prepare("SELECT * FROM feeds")
      .all() as {
      id: number;
      name: string;
      description: string;
      criteria: string;
      published_rkey: string | null;
      created_at: string;
      updated_at: string;
    }[];

    const feedIdMap = new Map<number, number>(); // old id → new id

    for (const f of feeds) {
      let criteria: Record<string, unknown> = {};
      try {
        criteria = JSON.parse(f.criteria || "{}");
      } catch {}

      // Map old criteria to new semantic_config
      const semanticConfig = {
        topics: criteria.topics || [],
        keywords: criteria.keywords || [],
        exclude_topics: criteria.exclude_topics || [],
        exclude_keywords: criteria.exclude_keywords || [],
        vibes: criteria.vibes || "",
        embedding_threshold: 0.5,
        judge_enabled: true,
        judge_strictness: "moderate",
      };

      const res = await pg.query(
        `INSERT INTO feeds (user_id, name, description, semantic_config, published_rkey, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          userId,
          f.name,
          f.description,
          JSON.stringify(semanticConfig),
          f.published_rkey,
          f.created_at,
          f.updated_at,
        ]
      );
      feedIdMap.set(f.id, res.rows[0].id);
      console.log(`Feed "${f.name}" (${f.id} → ${res.rows[0].id})`);
    }

    // 3. Migrate posts
    const posts = sqlite
      .prepare("SELECT * FROM posts")
      .all() as {
      uri: string;
      cid: string;
      author_did: string;
      text: string;
      score: number;
      feed_id: number;
      indexed_at: string;
    }[];

    let postCount = 0;
    const postIdMap = new Map<string, number>(); // uri → new post id

    for (const p of posts) {
      const newFeedId = feedIdMap.get(p.feed_id);
      if (!newFeedId) continue;

      // Insert post (or get existing)
      let postId = postIdMap.get(p.uri);
      if (!postId) {
        const res = await pg.query(
          `INSERT INTO posts (uri, cid, author_did, text, char_length, indexed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (uri) DO UPDATE SET indexed_at = EXCLUDED.indexed_at
           RETURNING id`,
          [p.uri, p.cid, p.author_did, p.text, p.text.length, p.indexed_at]
        );
        postId = res.rows[0].id as number;
        postIdMap.set(p.uri, postId);
      }

      // Assign to feed
      await pg.query(
        `INSERT INTO feed_posts (feed_id, post_id, final_score)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [newFeedId, postId, p.score]
      );
      postCount++;
    }
    console.log(`Migrated ${postCount} post assignments (${postIdMap.size} unique posts)`);

    // 4. Migrate chat messages
    const messages = sqlite
      .prepare("SELECT * FROM chat_messages")
      .all() as {
      feed_id: number;
      role: string;
      content: string;
      created_at: string;
    }[];

    let msgCount = 0;
    for (const m of messages) {
      const newFeedId = feedIdMap.get(m.feed_id);
      if (!newFeedId) continue;
      await pg.query(
        `INSERT INTO chat_messages (feed_id, role, content, created_at)
         VALUES ($1, $2, $3, $4)`,
        [newFeedId, m.role, m.content, m.created_at]
      );
      msgCount++;
    }
    console.log(`Migrated ${msgCount} chat messages`);

    console.log("Migration complete!");
  } catch (err: any) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main();
