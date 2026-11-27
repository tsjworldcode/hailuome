-- M10-2: 私信 E2EE 最小闭环。
-- Worker 只保存 envelope 密文 JSON 与站主密码包裹后的会话密钥，不保存明文消息或明文会话密钥。
--
-- M16-1a 注：下方 dm_* 建表 DDL 的权威副本已迁至 MESSAGING_DB
--（apps/worker-a/db/messaging-migrations/0001_messaging_dm.sql）。
-- 本 migration 保留以兼容已 apply 的节点；主库仅长期保留 users.dm_pubkey 与 dm_retention_days。
-- 存量 dm_* 行搬移与主库 DROP 见 M16-1b（migrate-dm-to-messaging-db.mjs + 0042_drop_dm_tables.sql）。

ALTER TABLE users ADD COLUMN dm_pubkey TEXT NOT NULL DEFAULT '';

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

CREATE TABLE IF NOT EXISTS dm_wrapped_keys (
  conversation_id     TEXT NOT NULL,
  key_epoch           INTEGER NOT NULL,
  peer_handle         TEXT NOT NULL,
  wrapped_key_json    TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key_epoch)
);

CREATE TABLE IF NOT EXISTS dm_nonces (
  nonce       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO system_config (key, value, updated_at)
VALUES ('dm_retention_days', '180', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
