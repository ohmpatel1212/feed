// --- User Profile ---

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  blueskyHandle: string;
  blueskyDid: string;
  bskyAppPassword: string;
  onboardedAt: string;
}

// --- Mechanical Filters ---
// Only fields wired to a read-path action live here. Everything else was
// removed in the curator redesign (see DECISIONS.md).

export interface MechanicalFilters {
  lang_allow: string[];           // e.g. ["en", "es"] — empty = allow all
  post_type: "all" | "top_level" | "replies";
  require_media: boolean;
  require_video: boolean;
  require_link: boolean;
  require_quote: boolean;
  exclude_media: boolean;
  exclude_video: boolean;
  exclude_links: boolean;
  hashtag_include: string[];      // post must contain at least one (case-insensitive)
  block_labels: string[];         // Bluesky self-labels to reject (NSFW gate)
  exclude_likely_nsfw: boolean;   // drop posts from authors whose description matches LIKE_NSFW_DESCRIPTION_KEYWORDS
  min_like_count: number;         // SQL filter on post_engagement.like_count
  min_repost_count: number;
  min_reply_count: number;
  time_window: TimeWindow;
  created_after_iso: string;      // only used when time_window === "custom"
  created_before_iso: string;
}

// Capped at the partial HNSW index coverage (currently ~3 days — see
// DECISIONS.md #12). A window longer than the indexed range would silently
// return only what's indexed. Raise this back toward 7d/14d once the index
// is rebuilt over a wider range. "custom" is not clamped — older bounds just
// match nothing beyond the indexed range.
export type TimeWindow = "1h" | "24h" | "3d" | "custom";
