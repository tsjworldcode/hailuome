-- M9-1：纯转发元数据（转发帖 content 固定空串，image_keys 固定 '[]'）
ALTER TABLE posts ADD COLUMN post_kind TEXT NOT NULL DEFAULT 'original';
-- post_kind: 'original' | 'repost'

ALTER TABLE posts ADD COLUMN repost_of_node_url TEXT;
ALTER TABLE posts ADD COLUMN repost_of_post_id TEXT;
ALTER TABLE posts ADD COLUMN repost_of_author_handle TEXT;

CREATE INDEX IF NOT EXISTS idx_posts_repost_origin
  ON posts (repost_of_node_url, repost_of_post_id)
  WHERE deleted_at IS NULL AND post_kind = 'repost';

-- 同一节点对同一原帖只保留一条有效转发（软删后可再转）
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_repost_unique_active
  ON posts (repost_of_node_url, repost_of_post_id)
  WHERE deleted_at IS NULL AND post_kind = 'repost';
