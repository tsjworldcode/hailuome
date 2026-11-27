-- M16-1a：私信 E2EE 表迁入 MESSAGING_DB（方案 B：DM + 群同库）
-- 主库 DB 仅保留 users.dm_pubkey 与 retention 配置项（历史 0025 + 0041 分拆标记）
-- 存量行搬移：M16-1b scripts/migrate-dm-to-messaging-db.mjs
-- 主库 DROP dm_*：M16-1b 0042_drop_dm_tables.sql（须先校验 COUNT 一致）

-- dm_messages：收件箱 + 发件箱副本（direction 区分）
CREATE TABLE IF NOT EXISTS dm_messages (
  message_id          TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbox', 'outbox')),
  peer_handle         TEXT NOT NULL,
  peer_worker_b_url   TEXT NOT NULL,
  envelope_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  read_at             TEXT,
  delivery_status     TEXT NOT NULL DEFAULT 'delivered'
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_conv_created
  ON dm_messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dm_messages_created
  ON dm_messages (created_at);

-- dm_wrapped_keys：站主密码包裹的会话密钥（每会话每 epoch 一行）
CREATE TABLE IF NOT EXISTS dm_wrapped_keys (
  conversation_id     TEXT NOT NULL,
  key_epoch           INTEGER NOT NULL,
  peer_handle         TEXT NOT NULL,
  wrapped_key_json    TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key_epoch)
);

-- dm_nonces：防重放（私信 envelope nonce + ticket nonce，MVP 合一）
CREATE TABLE IF NOT EXISTS dm_nonces (
  nonce       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

-- M10-3：私信收件限频桶（按 sender_worker_b_url 每小时 D1 计数）
CREATE TABLE IF NOT EXISTS dm_rate_buckets (
  sender_worker_b_url TEXT NOT NULL,
  window_hour          TEXT NOT NULL,
  count                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sender_worker_b_url, window_hour)
);

CREATE INDEX IF NOT EXISTS idx_dm_rate_buckets_window
  ON dm_rate_buckets (window_hour);

-- M10-5c：站主密码包裹的 X25519 身份私钥（Worker 只见密文 JSON）
CREATE TABLE IF NOT EXISTS dm_wrapped_identity (
  owner_handle          TEXT PRIMARY KEY,
  public_key_hex        TEXT NOT NULL,
  wrapped_identity_json TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
