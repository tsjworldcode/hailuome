-- M9-19：互动签名 envelope — nonce 去重表
-- 用于防止跨节点互动请求的重放攻击。
-- nonce 为 16 字节 hex（32 字符），按 post_id + actor_node_url + nonce 做唯一约束。
-- 整点 GC 清理 24h 前的记录。

CREATE TABLE IF NOT EXISTS interaction_nonces (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         TEXT NOT NULL,
  actor_node_url  TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(post_id, actor_node_url, nonce)
);

CREATE INDEX IF NOT EXISTS idx_interaction_nonces_post_actor
  ON interaction_nonces (post_id, actor_node_url);
