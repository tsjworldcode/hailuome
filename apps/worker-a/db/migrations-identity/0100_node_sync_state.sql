-- M16-GROUP-LIFECYCLE-V2-11：节点 daily-sync 锚点 + 中心 INTERVAL_DAYS 缓存
-- 权威库：IDENTITY_DB（与 registration_sync_state 同层；仅 Worker A 私有，禁止暴露给 Worker B / 公开 API）
--
-- 字段语义：
--   last_daily_sync_reported_at — 上次成功上报的 computed_at（秒级 ISO 8601）；供群号增量过滤锚点
--   config_interval_days        — 缓存中心 daily-sync 响应 data.interval_days（下次 body 回显；无缓存则不上报 group_lifecycle 或暂用 30）
--
-- Free Tier：低频写（成功 sync 才写一行），符合 D1；禁止用 KV。

CREATE TABLE IF NOT EXISTS node_sync_state (
  user_id TEXT PRIMARY KEY NOT NULL,
  last_daily_sync_reported_at TEXT,
  config_interval_days INTEGER,
  updated_at TEXT NOT NULL
);

-- V2-12：同文件索引（排障按更新时间扫）
CREATE INDEX IF NOT EXISTS idx_node_sync_state_updated_at
  ON node_sync_state (updated_at DESC);
