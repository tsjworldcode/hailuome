-- GROUP-CAP-SPEAK-1：发言排序与心跳资格解耦
-- last_speak_at = 最近一次成功落库的 chat 发言时刻（排序）；活跃资格仍看 last_ack_at。
-- 存量回填：用 joined_at / last_ack_at，避免全员 NULL 时建树序抖动。

ALTER TABLE group_members ADD COLUMN last_speak_at TEXT;

UPDATE group_members
   SET last_speak_at = COALESCE(joined_at, last_ack_at)
 WHERE last_speak_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_group_members_speak
  ON group_members (group_id, last_speak_at);
