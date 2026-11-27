-- M4-1：粉丝 Token 使用计数表（替代 KV 计数，D1 写 100K/天 vs KV 写 1K/天）
-- 主键 (token_hash, day) 按日分桶，GC 清理 30 天前旧桶

CREATE TABLE IF NOT EXISTS follower_token_usage (
  token_hash  TEXT NOT NULL,   -- Token 的 SHA-256 hex
  day         TEXT NOT NULL,   -- UTC 日期：2026-01-01
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, day)
);

-- 按日期索引，供整点 GC 清理过期桶
CREATE INDEX IF NOT EXISTS idx_follower_token_usage_day ON follower_token_usage (day);
