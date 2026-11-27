-- M16-SLA-3：待上树列表
-- 入群成员先进待上树列表（group_pending_members），冷却期满（距上次重建 ≥10s）后
-- 统一触发 recomputeAndPersistRelayTree 将其并入 relay_tree。
-- 冷却期内群主发消息时，实时 POST 副本给待上树成员。
--
-- M-OPT-SPLIT-A6 起步 · 勘误：本表 A-2 误归 CONTENT_DB（migrations-content/0055）。
-- 实际生产代码 lib/groupInvite.ts + lib/groupRelayTree.ts 全走 messagingDb(env) 即
-- MESSAGING_DB 物理库 — 与 group_members / group_invites / group_relay_edges 同库。
-- 本文件迁回 MESSAGING_DB migrations 目录（编号 0008），原 0055 同步删除。
-- 详见 docs/m-opt-split-a6-compensation-plan.md §三。

CREATE TABLE IF NOT EXISTS group_pending_members (
  -- 主键：(group_id, member_worker_b_url)，同一成员在冷却期内最多出现一次
  group_id              TEXT NOT NULL,
  member_worker_b_url    TEXT NOT NULL,
  member_handle          TEXT NOT NULL,
  member_pubkey         TEXT NOT NULL,
  -- key_state = 'active' 时群主已知其 wrapped_key；'pending_key' 时暂用群主公钥加密
  key_state             TEXT NOT NULL DEFAULT 'pending_key',
  -- 入列表时间
  added_at              TEXT NOT NULL,
  PRIMARY KEY (group_id, member_worker_b_url)
);

CREATE INDEX IF NOT EXISTS idx_gpm_group_added
  ON group_pending_members(group_id, added_at);