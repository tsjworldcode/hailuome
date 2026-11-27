-- M16-P：群消息 overflow 分片路由表（主 MESSAGING_DB；大表按 group_id 显式路由）
CREATE TABLE IF NOT EXISTS group_message_shard_routes (
  group_id    TEXT PRIMARY KEY,
  shard_id    TEXT NOT NULL CHECK (shard_id IN ('primary', 'shard_1')),
  routed_at   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_message_shard_routes_shard
  ON group_message_shard_routes (shard_id);
