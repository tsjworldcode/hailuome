-- lookup 缓存表（cache_entries）
-- M1-3a 建表（方案优化.md §4.2 P-1c；原计划 0003，因 M1-2 提前占用 outbound_events 顺延为 0004）
-- M1-3 在此基础上实装缓存读写逻辑（TTL 24h，过期回源）
--
-- 缓存策略：
--   命中条件：handle 存在 AND expires_at > now()
--   写入时机：注册中心 GET /lookup/:handle 成功响应后
--   TTL：24h（fetched_at + 86400s = expires_at）
--   GC：每小时整点 gcCacheEntries(env) 删除 fetched_at < now - 2天 的记录（方案 §4.5）
--
-- fail-soft：若注册中心 429 / 不可达，不强制更新缓存，沿用已有缓存直到 expires_at

CREATE TABLE IF NOT EXISTS cache_entries (
  handle              TEXT PRIMARY KEY,   -- 被查节点的 handle（lookup key，唯一）
  user_id             TEXT NOT NULL,      -- 注册中心返回的 user_id
  node_url            TEXT NOT NULL,      -- 被查节点的 node_url（Worker B 地址）
  worker_b_url        TEXT,               -- worker_b_url（通常与 node_url 相同，可为 NULL）
  pubkey_fingerprint  TEXT NOT NULL,      -- SHA-256(pubkey_hex) 前 16 hex
  registry_status     TEXT,               -- registered / suspended 等
  health_status       TEXT,               -- active / inactive 等
  response_json       TEXT NOT NULL,      -- 注册中心原始 JSON 响应（data 字段），保留完整字段
  fetched_at          TEXT NOT NULL,      -- 首次或最近一次回源时间（ISO 8601 UTC）
  expires_at          TEXT NOT NULL       -- TTL 过期时间 = fetched_at + 24h（ISO 8601 UTC）
);

-- 按过期时间查询（TTL 命中检查：WHERE handle = ? AND expires_at > datetime('now')）
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries (handle, expires_at);
-- 按拉取时间排序（GC 扫描：WHERE fetched_at < datetime('now', '-2 days')）
CREATE INDEX IF NOT EXISTS idx_cache_fetched ON cache_entries (fetched_at ASC);
