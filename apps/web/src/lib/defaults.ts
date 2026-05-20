import type { MechanicalFilters } from "./types";

// Bluesky's standard self-applied content labels we filter by default.
// Posts whose `self_labels` Vertex restrict contains any of these are
// excluded from results.
export const DEFAULT_SENSITIVE_LABELS = [
  "porn",
  "sexual",
  "nudity",
  "graphic-media",
];

export const DEFAULT_MECHANICAL_FILTERS: MechanicalFilters = {
  lang_allow: ["en"],
  post_type: "all",
  require_media: false,
  require_video: false,
  require_link: false,
  require_quote: false,
  exclude_media: false,
  exclude_video: false,
  exclude_links: false,
  hashtag_include: [],
  block_labels: DEFAULT_SENSITIVE_LABELS,
  min_like_count: 0,
  min_repost_count: 0,
  min_reply_count: 0,
  time_window: "24h",
  created_after_iso: "",
  created_before_iso: "",
};

// Total candidate budget across all subqueries. Per-subquery k is
// floor(DEFAULT_CANDIDATE_BUDGET / subqueries.length).
export const DEFAULT_CANDIDATE_BUDGET = 150;
export const MIN_CANDIDATE_BUDGET = 50;
export const MAX_CANDIDATE_BUDGET = 500;

export const DEFAULT_SUBQUERIES: string[] = [];

export function withMechanicalDefaults(
  partial: Partial<MechanicalFilters>
): MechanicalFilters {
  return { ...DEFAULT_MECHANICAL_FILTERS, ...partial };
}
