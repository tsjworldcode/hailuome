-- MSG-FIX-4：overflow 分片库与 primary 同结构 recv_seq / received_at
-- SSOT：docs/msg-delivery-fix-2026-10-plan.md §4.4（双 migration 目录同步）

ALTER TABLE group_messages ADD COLUMN recv_seq INTEGER;
ALTER TABLE group_messages ADD COLUMN received_at TEXT;

ALTER TABLE member_group_messages ADD COLUMN recv_seq INTEGER;
ALTER TABLE member_group_messages ADD COLUMN received_at TEXT;

UPDATE group_messages
SET recv_seq = (
  SELECT COUNT(*)
    FROM group_messages AS g2
   WHERE g2.group_id = group_messages.group_id
     AND (
       g2.created_at < group_messages.created_at
       OR (g2.created_at = group_messages.created_at AND g2.message_id <= group_messages.message_id)
     )
)
WHERE recv_seq IS NULL;

UPDATE member_group_messages
SET recv_seq = (
  SELECT COUNT(*)
    FROM member_group_messages AS g2
   WHERE g2.group_id = member_group_messages.group_id
     AND (
       g2.created_at < member_group_messages.created_at
       OR (g2.created_at = member_group_messages.created_at AND g2.message_id <= member_group_messages.message_id)
     )
)
WHERE recv_seq IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_messages_group_recv_seq
  ON group_messages (group_id, recv_seq);

CREATE INDEX IF NOT EXISTS idx_member_group_messages_group_recv_seq
  ON member_group_messages (group_id, recv_seq);
