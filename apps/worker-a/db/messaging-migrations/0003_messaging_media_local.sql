-- MM-1：私信/群聊图片本节点元数据（不进 signed envelope）
-- SSOT：docs/m10-p2-dm-media-plan.md §4.4

CREATE TABLE IF NOT EXISTS messaging_media_local (
  message_id          TEXT NOT NULL,
  media_id            TEXT NOT NULL,
  group_id            TEXT,
  local_storage_key   TEXT,
  mirror_of_key       TEXT NOT NULL,
  storage_state       TEXT NOT NULL DEFAULT 'mirror_pending'
    CHECK (storage_state IN (
      'active', 'mirror_pending', 'mirrored', 'stream_only',
      'release_pending', 'released', 'missing'
    )),
  media_view_mode     TEXT NOT NULL DEFAULT 'mirror'
    CHECK (media_view_mode IN ('mirror', 'stream_only')),
  retry_at            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (message_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_media_local_group
  ON messaging_media_local (group_id);
CREATE INDEX IF NOT EXISTS idx_messaging_media_local_state_retry
  ON messaging_media_local (storage_state, retry_at);
