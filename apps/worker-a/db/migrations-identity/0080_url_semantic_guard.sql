-- M-OPT-SPLIT-B1 · B-1：users.worker_b_url 语义约束。
--
-- 约束内容（B-1）：
--   1. worker_b_url 非空（已在 CREATE TABLE 为 TEXT NOT NULL，新增 CHECK 防止空字符串 ''）
--   2. worker_b_url 必须以 http:// 或 https:// 开头（应用层换域由 registryUrlChange
--      路由层保证；本 CHECK 兜底）
--
-- 同源策略（B-2）：
--   Phase 1（M27-0 前）：节点只能写自己本地的 worker_b_url（从 resolveLocalPublicBaseUrl
--   获取），不能从外部传入。路由层已有此约束（registryUrlChange / register 走 env 注入）。
--   Phase 2（M27-0 后）：允许 operator 显式 override 不同源 host，届时可扩展允许条件。
--
-- SQLite CHECK 约束行为：
--   - 不能 ADD CONSTRAINT，需重建表；
--   - 本 migration 保留旧 users 行数据，仅追加新约束；
--   - 必须保留 0002/0013/0014/0030/0036 等后续 ADD COLUMN 的全部列，
--     否则重建会静默丢掉 birth_date/country/phone 等，导致 register/complete 落库失败。

-- Step 1: 重建 users 表，追加 worker_b_url 语义 CHECK（含历史扩展列）
CREATE TABLE IF NOT EXISTS __users_new (
  handle          TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL DEFAULT '',
  bio             TEXT NOT NULL DEFAULT '',
  pubkey          TEXT NOT NULL DEFAULT '',
  worker_b_url    TEXT NOT NULL
                    CHECK (LENGTH(worker_b_url) > 0
                           AND (worker_b_url LIKE 'http://%' OR worker_b_url LIKE 'https://%')),
  avatar_key      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dm_pubkey       TEXT NOT NULL DEFAULT '',
  -- 0002_node_metadata
  node_type           TEXT NOT NULL DEFAULT 'human',
  did                 TEXT NOT NULL DEFAULT '',
  node_proto_version  TEXT NOT NULL DEFAULT '1.0',
  -- 0013_user_public_profile
  contact_email   TEXT NOT NULL DEFAULT '',
  -- 0014_user_demographics
  birth_date      TEXT NOT NULL DEFAULT '',
  gender          TEXT NOT NULL DEFAULT '',
  -- 0030_user_country
  country         TEXT NOT NULL DEFAULT 'US',
  -- 0036_register_phone
  phone           TEXT NOT NULL DEFAULT ''
);

-- Step 2: 迁移数据（缺列用 COALESCE 兜底，兼容残缺旧表）
INSERT INTO __users_new
  (handle, display_name, bio, pubkey, worker_b_url, avatar_key, created_at, dm_pubkey,
   node_type, did, node_proto_version, contact_email, birth_date, gender, country, phone)
SELECT
  handle, display_name, bio, pubkey,
  CASE WHEN LENGTH(worker_b_url) = 0 THEN ''
       ELSE worker_b_url END,
  avatar_key, created_at,
  COALESCE(dm_pubkey, '') AS dm_pubkey,
  COALESCE(node_type, 'human'),
  COALESCE(did, ''),
  COALESCE(node_proto_version, '1.0'),
  COALESCE(contact_email, ''),
  COALESCE(birth_date, ''),
  COALESCE(gender, ''),
  COALESCE(country, 'US'),
  COALESCE(phone, '')
FROM users;

-- Step 3: 替换旧表
DROP TABLE users;
ALTER TABLE __users_new RENAME TO users;

-- Step 4: 重建索引（原有 idx 无变化，仅重新声明）
CREATE INDEX IF NOT EXISTS idx_users_handle ON users (handle);
CREATE INDEX IF NOT EXISTS idx_users_pubkey ON users (pubkey);
