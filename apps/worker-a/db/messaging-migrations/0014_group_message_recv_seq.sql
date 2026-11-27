-- MSG-FIX-4：群消息单调入库序（消除客户端 created_at 游标永久空洞）
-- SSOT：docs/msg-delivery-fix-2026-10-plan.md §4.4
-- 游标主用 recv_seq；received_at 仅排障；对外 cursor 仍可回写 message_id

ALTER TABLE group_messages ADD COLUMN recv_seq INTEGER;
ALTER TABLE group_messages ADD COLUMN received_at TEXT;

ALTER TABLE member_group_messages ADD COLUMN recv_seq INTEGER;
ALTER TABLE member_group_messages ADD COLUMN received_at TEXT;

-- 回填：按 (group_id, created_at, message_id) 排序赋号（一次性）
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
