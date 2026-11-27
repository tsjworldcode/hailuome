-- 0001_init.sql · GOVERNANCE_DB（黑名单 / Token 吊销 / Feed 缓存治理层）
-- M-OPT-SPLIT A-2：原 0001_init 7 表拆三库；本库承担 blacklist + revoked_tokens + feed_cache。
-- 跨库外键全部改为应用层引用（见 plan §3.3）。
-- 本库 7 表含 posts/follows 拆出后留下的治理子集。

-- 黑名单表（被封禁的粉丝节点，无法获取粉丝 Token）
CREATE TABLE IF NOT EXISTS blacklist (
  node_url    TEXT PRIMARY KEY,              -- 被封禁节点的 Worker B 地址
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 已吊销 Token 表（粉丝被加入黑名单时，其 Token 立即吊销）
-- Worker B 通过 STATE_KV 快速检查（Worker A Cron 每 5 分钟同步），本表是权威存储
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash  TEXT PRIMARY KEY,             -- Token 的 SHA-256 hex，避免存原始 Token
  node_url    TEXT NOT NULL,               -- 被吊销 Token 所属节点
  revoked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 已吊销 Token 索引：按节点 URL 快速查找（解封时需要清理）
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_node_url ON revoked_tokens (node_url);

-- Feed 聚合缓存表（Cron 拉取后写入，前端读取）
-- 注意：聚合完成后旧记录立即 DELETE，避免 D1 行数堆积
CREATE TABLE IF NOT EXISTS feed_cache (
  id          TEXT PRIMARY KEY,              -- 源帖子的 id（格式：<node_url>#<post_id>）
  node_url    TEXT NOT NULL,               -- 帖子来源节点的 Worker B 地址
  content     TEXT NOT NULL,
  sig         TEXT NOT NULL DEFAULT '',
  image_urls  TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，完整图片 URL（含 node_url 前缀）
  post_id     TEXT NOT NULL,               -- 原始帖子 id
  created_at  TEXT NOT NULL,               -- 原始帖子发布时间（ISO 8601）
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Feed 按时间倒序索引
CREATE INDEX IF NOT EXISTS idx_feed_cache_created_at ON feed_cache (created_at DESC);
-- Feed 按来源节点索引（清理某节点的帖子时使用）
CREATE INDEX IF NOT EXISTS idx_feed_cache_node_url ON feed_cache (node_url);