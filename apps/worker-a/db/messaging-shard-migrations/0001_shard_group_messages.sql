-- M16-P：overflow 分片库 — 仅 group_messages / member_group_messages（metadata 留 MESSAGING_DB）
-- SSOT：docs/m16-group-chat-plan.md §4bis.0.1

CREATE TABLE IF NOT EXISTS group_messages (
  message_id          TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL,
  epoch               INTEGER NOT NULL,
  sender_worker_b_url TEXT NOT NULL,
  sender_handle       TEXT NOT NULL,
  msg_kind            TEXT NOT NULL CHECK (msg_kind IN ('chat', 'system')),
  ciphertext          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  envelope_json       TEXT
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group_created
  ON group_messages (group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_group_messages_group_epoch
  ON group_messages (group_id, epoch, created_at);

CREATE TABLE IF NOT EXISTS member_group_messages (
  message_id          TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL,
  epoch               INTEGER NOT NULL,
  sender_worker_b_url TEXT NOT NULL,
  sender_handle       TEXT NOT NULL,
  msg_kind            TEXT NOT NULL,
  ciphertext          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  envelope_json       TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_group_messages_group_created
  ON member_group_messages (group_id, created_at);
