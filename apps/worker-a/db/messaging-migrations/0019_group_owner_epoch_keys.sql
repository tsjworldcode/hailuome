-- OWNER-KEY-1：群主节点持钥表（托管群密）。
-- SSOT：docs/group-owner-held-key-2026-11-plan.md §2
--
-- 硬约束：
--   - 仅群主节点写入/读取；禁止经 sync-with-parent / Worker B / 公开 API 外泄
--   - key_material 推荐为 GROUP_OWNER_KEY_WRAP_SECRET 包裹后的密文 JSON（非成员可读明文）
--   - 成员节点可有空表（migration 全账号 apply），但业务路径不得写入

CREATE TABLE IF NOT EXISTS group_owner_epoch_keys (
  group_id         TEXT NOT NULL,
  epoch            INTEGER NOT NULL,
  key_material     TEXT NOT NULL,
  key_fingerprint  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (group_id, epoch)
);

CREATE INDEX IF NOT EXISTS idx_group_owner_epoch_keys_fingerprint
  ON group_owner_epoch_keys (group_id, key_fingerprint);
