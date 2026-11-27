-- 初始化海螺节点 D1 数据库（Worker A）
-- 约定：时间字段全部使用 ISO 8601 字符串（UTC），如 2026-01-01T00:00:00.000Z

-- 用户表（节点所有者信息，当前节点只有一条记录）
CREATE TABLE IF NOT EXISTS users (
  handle          TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL DEFAULT '',
  bio             TEXT NOT NULL DEFAULT '',
  pubkey          TEXT NOT NULL DEFAULT '',  -- Ed25519 公钥 hex，供其他节点验证帖子签名
  worker_b_url    TEXT NOT NULL DEFAULT '',  -- 对外公开的 Worker B 地址
  avatar_key      TEXT,                      -- 头像在 IMAGE_KV 中的 key
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

-- 关注表（本节点关注的其他节点列表）
CREATE TABLE IF NOT EXISTS follows (
  id                TEXT PRIMARY KEY,        -- 格式：follow_<ulid>
  follower_node_url TEXT NOT NULL UNIQUE,    -- 被关注节点的 Worker B 地址
  followed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active       TEXT,                    -- 最后一次成功拉取到新帖的时间，用于自适应 Cron
  fail_count        INTEGER NOT NULL DEFAULT 0  -- 连续拉取失败次数，用于指数退避
);

-- 关注列表索引：按活跃度排序，Cron 优先拉取活跃节点
CREATE INDEX IF NOT EXISTS idx_follows_last_active ON follows (last_active DESC);

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

-- 系统配置表（Key-Value 形式，存储节点级别的可配置参数）
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
