-- M9-1-4：关注流 feed_cache 透传纯转发元数据
ALTER TABLE feed_cache ADD COLUMN post_kind TEXT NOT NULL DEFAULT 'original';
-- post_kind: 'original' | 'repost'

ALTER TABLE feed_cache ADD COLUMN repost_of_json TEXT;
-- repost 时 JSON：{"node_url","post_id","author_handle"}
