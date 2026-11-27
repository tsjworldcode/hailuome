-- 0001_init.sql · IDENTITY_DB（节点身份与系统配置）
-- M-OPT-SPLIT A-2：原 0001_init 7 表拆三库；本库承担 users + system_config。
-- 跨库外键全部改为应用层引用（见 plan §3.3）。

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

-- 关注表（本节点关注的其他节点列表；M-OPT-SPLIT A-2：身份相关的关注关系放 IDENTITY_DB）
CREATE TABLE IF NOT EXISTS follows (
  id                TEXT PRIMARY KEY,        -- 格式：follow_<ulid>
  follower_node_url TEXT NOT NULL UNIQUE,    -- 被关注节点的 Worker B 地址
  followed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active       TEXT,                    -- 最后一次成功拉取到新帖的时间，用于自适应 Cron
  fail_count        INTEGER NOT NULL DEFAULT 0  -- 连续拉取失败次数，用于指数退避
);

-- 关注列表索引：按活跃度排序，Cron 优先拉取活跃节点
CREATE INDEX IF NOT EXISTS idx_follows_last_active ON follows (last_active DESC);

-- 系统配置表（Key-Value 形式，存储节点级别的可配置参数）
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);