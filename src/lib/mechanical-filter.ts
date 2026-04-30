import type { PostCandidate, MechanicalFilters } from "./types";

// --- Author rate limiting (in-memory, keyed by DID) ---

const authorHourlyCounts = new Map<string, { bucket: number; count: number }>();

function getCurrentHourBucket(): number {
  return Math.floor(Date.now() / 3_600_000);
}

function getAuthorCount(did: string): number {
  const entry = authorHourlyCounts.get(did);
  if (!entry || entry.bucket !== getCurrentHourBucket()) return 0;
  return entry.count;
}

function incrementAuthorCount(did: string): void {
  const bucket = getCurrentHourBucket();
  const entry = authorHourlyCounts.get(did);
  if (!entry || entry.bucket !== bucket) {
    authorHourlyCounts.set(did, { bucket, count: 1 });
  } else {
    entry.count++;
  }
}

/** Periodically prune stale entries (call every ~10 minutes) */
export function pruneAuthorCounts(): void {
  const bucket = getCurrentHourBucket();
  for (const [did, entry] of authorHourlyCounts) {
    if (entry.bucket !== bucket) authorHourlyCounts.delete(did);
  }
}

// --- Compiled regex cache ---

const regexCache = new Map<string, RegExp>();

function getCachedRegex(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re) return re;
  try {
    re = new RegExp(pattern, "i");
    regexCache.set(pattern, re);
    return re;
  } catch {
    return null;
  }
}

// --- Core filter function ---

/**
 * Returns true if the post passes all mechanical filters for a given feed.
 * This is the Stage 1 gate — fast, deterministic, no API calls.
 */
export function passesFilter(
  post: PostCandidate,
  filters: MechanicalFilters
): boolean {
  // Language
  if (filters.lang_allow.length > 0) {
    if (
      !post.langs.some((l) =>
        filters.lang_allow.some((a) => l.startsWith(a))
      )
    ) {
      return false;
    }
  }
  if (filters.lang_block.length > 0) {
    if (
      post.langs.some((l) =>
        filters.lang_block.some((b) => l.startsWith(b))
      )
    ) {
      return false;
    }
  }

  // Length
  if (filters.min_length > 0 && post.charLength < filters.min_length)
    return false;
  if (filters.max_length > 0 && post.charLength > filters.max_length)
    return false;

  // Post type
  if (filters.post_type === "top_level" && post.isReply) return false;
  if (filters.post_type === "replies" && !post.isReply) return false;

  // Media requirements
  if (filters.require_media && !post.hasMedia) return false;
  if (filters.require_link && !post.hasLink) return false;
  if (filters.require_quote && !post.hasQuote) return false;
  if (filters.exclude_media && post.hasMedia) return false;
  if (filters.exclude_links && post.hasLink) return false;

  // Hashtags
  if (filters.hashtag_include.length > 0) {
    const postTags = post.hashtags.map((h) => h.toLowerCase());
    if (
      !filters.hashtag_include.some((h) => postTags.includes(h.toLowerCase()))
    ) {
      return false;
    }
  }
  if (filters.hashtag_exclude.length > 0) {
    const postTags = post.hashtags.map((h) => h.toLowerCase());
    if (
      filters.hashtag_exclude.some((h) => postTags.includes(h.toLowerCase()))
    ) {
      return false;
    }
  }

  // Regex patterns
  if (filters.regex_include.length > 0) {
    const matched = filters.regex_include.some((pattern) => {
      const re = getCachedRegex(pattern);
      return re ? re.test(post.text) : false;
    });
    if (!matched) return false;
  }
  if (filters.regex_exclude.length > 0) {
    const matched = filters.regex_exclude.some((pattern) => {
      const re = getCachedRegex(pattern);
      return re ? re.test(post.text) : false;
    });
    if (matched) return false;
  }

  // Author allowlist/blocklist
  if (
    filters.author_allowlist.length > 0 &&
    !filters.author_allowlist.includes(post.did)
  )
    return false;
  if (filters.author_blocklist.includes(post.did)) return false;

  // Author rate limiting
  if (filters.author_max_per_hour > 0) {
    if (getAuthorCount(post.did) >= filters.author_max_per_hour) return false;
  }

  return true;
}

/**
 * Call after a post is accepted to track author rate limits.
 */
export function recordPostAccepted(did: string): void {
  incrementAuthorCount(did);
}

// --- Metadata extraction from Jetstream events ---

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Extract a PostCandidate from a raw Jetstream commit event.
 * Returns null if the event is not a valid post creation.
 */
export function extractMetadata(event: any): PostCandidate | null {
  if (
    event.kind !== "commit" ||
    event.commit?.operation !== "create" ||
    event.commit?.collection !== "app.bsky.feed.post"
  ) {
    return null;
  }

  const record = event.commit.record;
  if (!record?.text) return null;

  const text: string = record.text;
  const uri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;
  const cid: string = event.commit.cid;

  // Detect media types from embed
  const embed = record.embed;
  const embedType: string = embed?.$type || "";
  const hasMedia =
    embedType === "app.bsky.embed.images" ||
    embedType === "app.bsky.embed.video" ||
    embedType === "app.bsky.embed.recordWithMedia";
  const hasLink = embedType === "app.bsky.embed.external";
  const hasQuote =
    embedType === "app.bsky.embed.record" ||
    embedType === "app.bsky.embed.recordWithMedia";

  // Detect reply
  const isReply = !!record.reply;

  // Extract hashtags from facets
  const hashtags: string[] = [];
  if (Array.isArray(record.facets)) {
    for (const facet of record.facets) {
      if (Array.isArray(facet.features)) {
        for (const feature of facet.features) {
          if (feature.$type === "app.bsky.richtext.facet#tag" && feature.tag) {
            hashtags.push(feature.tag);
          }
        }
      }
    }
  }

  // Also include author-set tags
  if (Array.isArray(record.tags)) {
    for (const tag of record.tags) {
      if (!hashtags.includes(tag)) hashtags.push(tag);
    }
  }

  return {
    uri,
    cid,
    did: event.did,
    text,
    langs: Array.isArray(record.langs) ? record.langs : [],
    hasMedia,
    hasLink,
    hasQuote,
    isReply,
    hashtags,
    charLength: text.length,
  };
}
