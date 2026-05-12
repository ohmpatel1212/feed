-- Boolean media flags on bsky.posts. They're derived from embed_type/image_count/video_alt
-- but storing them directly keeps the reconciler query and the read-side JOIN simple.

ALTER TABLE bsky.posts
  ADD COLUMN IF NOT EXISTS has_images        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_video         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_quote         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_external_link boolean NOT NULL DEFAULT false;
