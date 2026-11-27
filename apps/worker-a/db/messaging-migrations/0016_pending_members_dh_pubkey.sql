-- 0016_pending_members_dh_pubkey.sql · MESSAGING_DB
-- SEC-AUDIT-2026-10-15：待上树成员携带入群时登记的 X25519 member_dh_pubkey，drain 写入 group_members。

ALTER TABLE group_pending_members ADD COLUMN member_dh_pubkey TEXT;
