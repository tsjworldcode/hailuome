-- M9-20：站主互动通知（别人对本节点帖子的点赞/回复）。
-- 写入发生在 Worker A interactions 成功落库时；站主经 JWT 轮询读取，不用 KV。

CREATE TABLE IF NOT EXISTS local_notifications (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('like', 'reply')),
  post_id         TEXT NOT NULL,
  actor_handle    TEXT NOT NULL,
  actor_node_url  TEXT NOT NULL,
  reply_id        TEXT,
  content_preview TEXT,
  created_at      TEXT NOT NULL,
  read_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_notifications_created
  ON local_notifications (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_notifications_unread
  ON local_notifications (read_at, created_at DESC);
