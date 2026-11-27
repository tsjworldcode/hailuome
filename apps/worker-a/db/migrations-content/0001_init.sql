-- 0001_init.sql · CONTENT_DB（用户可见内容：posts）
-- M-OPT-SPLIT A-2：原 0001_init 7 表拆三库；本库承担 posts。
-- 跨库外键全部改为应用层引用（见 plan §3.3）。
-- 本库后续扩展：0029 private_notes / 0038 posts_repost / 0055 group_pending_members / 0060 friend_requests。

-- 帖子表
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,              -- 格式：post_<ulid>
  content     TEXT NOT NULL,
  sig         TEXT NOT NULL DEFAULT '',      -- Ed25519 签名 hex（对 id+content+created_at 签名）
  image_keys  TEXT NOT NULL DEFAULT '[]',   -- JSON 数组，存 IMAGE_KV 中的图片 key 列表
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT                           -- 软删除：非 NULL 表示已删除
);

-- 帖子索引：按发布时间倒序查询
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts (created_at DESC) WHERE deleted_at IS NULL;