-- M9-18：帖子公开互动 v1（点赞 + 回复）。
-- 公开互动归发帖人节点 Worker A D1 权威保存；Worker B 只代理，不持有 D1。
--
-- M-OPT-SPLIT A-2：原跨库 FK `FOREIGN KEY (post_id) REFERENCES posts(id)` 已删除
--（posts 表在 CONTENT_DB，跨库 FK 由 SQLite 不支持）；应用层在 routes/interactions
-- 校验 post_id 合法（见 plan §3.3）。

CREATE TABLE IF NOT EXISTS post_likes (
  post_id         TEXT NOT NULL,
  actor_handle    TEXT NOT NULL,
  actor_node_url  TEXT NOT NULL,
  actor_pubkey    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  sig             TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (post_id, actor_node_url)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_post_id ON post_likes (post_id);

CREATE TABLE IF NOT EXISTS post_replies (
  id              TEXT PRIMARY KEY,
  post_id         TEXT NOT NULL,
  actor_handle    TEXT NOT NULL,
  actor_node_url  TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  sig             TEXT NOT NULL DEFAULT '',
  deleted_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_post_replies_post_created
  ON post_replies (post_id, created_at DESC)
  WHERE deleted_at IS NULL;
