-- M17 · 加好友（互粉请求）
-- 在 origin / target 两端各保留一份本地 friend_requests 副本（pending 状态机）。
-- 接受时由 origin 与 target 各自 INSERT 自己的 follows 表 — 不引入独立的 friends 表。
-- 跨节点转发对齐 M10-2 / M16-1c（Service Binding + HMAC v2）。详见 docs/m17-add-friend-plan.md §四。

CREATE TABLE IF NOT EXISTS friend_requests (
  id                     TEXT PRIMARY KEY,                 -- fr_<ulid>
  -- 请求方向与节点身份（origin = 发起方节点；target = 接收方节点）
  origin_node_url        TEXT NOT NULL,                    -- 归一化 origin 的 worker_b_url
  origin_handle          TEXT NOT NULL,                    -- 发起方 handle
  origin_display_name    TEXT NOT NULL DEFAULT '',
  origin_avatar_key      TEXT NOT NULL DEFAULT '',
  target_node_url        TEXT NOT NULL,                    -- 归一化 target 的 worker_b_url
  target_handle          TEXT NOT NULL,                    -- 接收方 handle
  -- 状态机
  status                 TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  message                TEXT,                              -- 用户附言，≤200 字符；M17 §11.1 截断
  -- 审计时间（统一 ISO 8601 字符串）
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  accepted_at            TEXT,
  rejected_at            TEXT,
  cancelled_at           TEXT,
  expired_at             TEXT,
  -- 防重 + 跨节点验证
  nonce                  TEXT NOT NULL,                    -- ULID，跨节点 inbox 防重
  -- 本节点回执：origin 端记录 target 是否已回写；target 端记录 origin 是否已撤回
  outbox_status          TEXT NOT NULL DEFAULT ''          -- 'acked' / 'cancelled' / ''
);

-- 一对 (origin, target) 同时只能有一条 pending；UNIQUE 部分索引是 SQLite 友好写法。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_friend_requests_pending
  ON friend_requests (origin_node_url, target_node_url)
  WHERE status = 'pending';

-- 接收方按 target 维度查 inbox / list
CREATE INDEX IF NOT EXISTS idx_friend_requests_inbox
  ON friend_requests (target_node_url, status, created_at DESC);

-- 发起方按 origin 维度查 outbox / list
CREATE INDEX IF NOT EXISTS idx_friend_requests_outbox
  ON friend_requests (origin_node_url, status, created_at DESC);

-- 跨节点重放去重
CREATE INDEX IF NOT EXISTS idx_friend_requests_nonce
  ON friend_requests (nonce);

-- 列表通用排序
CREATE INDEX IF NOT EXISTS idx_friend_requests_created
  ON friend_requests (created_at DESC);

-- 30 天过期清理索引（minute % 5 === 0 分支 cron 扫描）
CREATE INDEX IF NOT EXISTS idx_friend_requests_expiry
  ON friend_requests (created_at)
  WHERE status = 'pending';
