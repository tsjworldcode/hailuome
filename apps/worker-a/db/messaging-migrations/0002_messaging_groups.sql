-- M16-1c：群聊表迁入 MESSAGING_DB（方案 B：DM + 群同库）
-- SSOT：docs/m16-group-chat-plan.md §4bis.1–4bis.2

CREATE TABLE IF NOT EXISTS groups (
  group_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  announcement        TEXT,
  owner_worker_b_url  TEXT NOT NULL,
  epoch               INTEGER NOT NULL DEFAULT 1,
  tree_id             INTEGER NOT NULL DEFAULT 0,
  dissolved_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id              TEXT NOT NULL,
  member_worker_b_url   TEXT NOT NULL,
  member_handle         TEXT NOT NULL,
  member_pubkey         TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('owner', 'member', 'seed')),
  key_state             TEXT NOT NULL DEFAULT 'pending_key'
    CHECK (key_state IN ('pending_key', 'active', 'epoch_rotation_pending')),
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'kicked', 'left')),
  last_ack_at           TEXT,
  empty_ack_streak      INTEGER NOT NULL DEFAULT 0,
  joined_at             TEXT NOT NULL,
  PRIMARY KEY (group_id, member_worker_b_url)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group_status
  ON group_members (group_id, status);
CREATE INDEX IF NOT EXISTS idx_group_members_last_ack
  ON group_members (group_id, last_ack_at);

CREATE TABLE IF NOT EXISTS group_messages (
  message_id          TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL,
  epoch               INTEGER NOT NULL,
  sender_worker_b_url TEXT NOT NULL,
  sender_handle       TEXT NOT NULL,
  msg_kind            TEXT NOT NULL CHECK (msg_kind IN ('chat', 'system')),
  ciphertext          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL
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
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_group_messages_group_created
  ON member_group_messages (group_id, created_at);

CREATE TABLE IF NOT EXISTS group_outbox (
  message_id          TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL,
  owner_worker_b_url  TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'dead')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  next_retry_at       TEXT NOT NULL,
  last_error          TEXT,
  ciphertext          TEXT NOT NULL,
  envelope_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_outbox_retry
  ON group_outbox (state, next_retry_at);

CREATE TABLE IF NOT EXISTS group_nonces (
  group_id            TEXT NOT NULL,
  nonce               TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (group_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_group_nonces_created
  ON group_nonces (created_at);

CREATE TABLE IF NOT EXISTS group_rate_buckets (
  bucket_key          TEXT PRIMARY KEY,
  count               INTEGER NOT NULL DEFAULT 0,
  window_start        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_wrapped_keys (
  group_id              TEXT NOT NULL,
  epoch                 INTEGER NOT NULL,
  member_worker_b_url   TEXT NOT NULL,
  wrapped_key_json      TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (group_id, epoch, member_worker_b_url)
);

CREATE TABLE IF NOT EXISTS group_sync_state (
  group_id               TEXT PRIMARY KEY,
  parent_worker_b_url    TEXT NOT NULL,
  cursor                 TEXT,
  sync_tier              TEXT NOT NULL CHECK (sync_tier IN ('active', 'unsynced')),
  local_retention_days   INTEGER NOT NULL DEFAULT 90
    CHECK (local_retention_days BETWEEN 1 AND 365),
  last_sync_at           TEXT,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_invites (
  invite_token            TEXT PRIMARY KEY,
  group_id                TEXT NOT NULL,
  owner_worker_b_url      TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  consumed_at             TEXT,
  consumed_by_worker_b_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_group_invites_group
  ON group_invites (group_id);

CREATE TABLE IF NOT EXISTS group_relay_edges (
  group_id              TEXT NOT NULL,
  tree_id               INTEGER NOT NULL,
  parent_worker_b_url   TEXT NOT NULL,
  child_worker_b_url    TEXT NOT NULL,
  PRIMARY KEY (group_id, tree_id, parent_worker_b_url, child_worker_b_url)
);

CREATE INDEX IF NOT EXISTS idx_group_relay_edges_group_tree
  ON group_relay_edges (group_id, tree_id);

CREATE TABLE IF NOT EXISTS group_message_acks (
  group_id              TEXT NOT NULL,
  member_worker_b_url   TEXT NOT NULL,
  cursor                TEXT,
  acks_json             TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (group_id, member_worker_b_url, created_at)
);

CREATE INDEX IF NOT EXISTS idx_group_message_acks_group_member
  ON group_message_acks (group_id, member_worker_b_url);

CREATE TABLE IF NOT EXISTS group_relay_seen (
  message_id            TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL,
  seen_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_relay_seen_group
  ON group_relay_seen (group_id);
